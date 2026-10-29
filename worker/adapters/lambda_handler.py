"""AWS Lambda entry point: handler(event, context). Analyzes one file and saves its own result.

Event (invoked asynchronously by the API Lambda, one file per invocation):
    {"run_id": "...", "user_id": "...", "name": "call_001.wav", "audio_url": "<presigned S3 GET URL>"}
Local testing: {"name": "...", "audio_path": "/local/file.wav"} instead of audio_url.

Writes two compact JSON objects, always (even on failure), to s3://$BUCKET/
    runs/{user_id}/{run_id}/results/{name}.json   Result, or {"status": "failed", "error": ...}
    runs/{user_id}/{run_id}/metrics/{name}.json   timings, audio duration, model ids, cold start
or, when BUCKET is unset or the event has audio_path, to ./out/{run_id or "local"}/ with the
same results/ and metrics/ layout.

Returns: {"name", "status": "done" | "failed", "result_key"}.
"""

import json
import logging
import os
import shutil
import signal
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from functools import cache
from pathlib import Path
from typing import Any

_INIT_STARTED = time.perf_counter()

import requests  # noqa: E402
from pydantic import BaseModel, ValidationError, field_validator, model_validator  # noqa: E402

from audioace import config, models, pipeline  # noqa: E402  (loads all models once per container)

INIT_SECONDS = round(time.perf_counter() - _INIT_STARTED, 3)

DOWNLOAD_TIMEOUT_SEC = 60
TIMEOUT_MARGIN_SEC = 30  # stop this long before Lambda's own timeout, so the failure gets written
TIMEOUT_ERROR = "processing exceeded time limit"
LOCAL_OUT_DIR = Path("out")

logger = logging.getLogger("audioace.worker")
logger.setLevel(logging.INFO)

_cold_start = True


class WorkerEvent(BaseModel):
    name: str
    run_id: str | None = None
    user_id: str | None = None
    audio_url: str | None = None
    audio_path: str | None = None

    @field_validator("name", "run_id", "user_id")
    @classmethod
    def _safe_path_part(cls, value: str | None) -> str | None:
        # These become parts of local paths and S3 keys; reject anything that could escape them
        if value is not None and (not value or "/" in value or "\\" in value or value.startswith(".")):
            raise ValueError("must be non-empty, contain no '/' or '\\' and not start with '.'")
        return value

    @model_validator(mode="after")
    def _one_audio_source(self) -> "WorkerEvent":
        if bool(self.audio_url) == bool(self.audio_path):
            raise ValueError("event must contain exactly one of 'audio_url' or 'audio_path'")
        return self


class WorkerFailure(Exception):
    """A failure with a short, human-readable reason and a machine-readable type."""

    def __init__(self, error_type: str, error: str):
        super().__init__(error)
        self.error_type = error_type
        self.error = error


def _max_audio_bytes() -> int:
    return int(float(os.environ.get("MAX_AUDIO_MB", 500)) * 1024 * 1024)


def _download(url: str, dest: Path) -> int:
    """Stream url to dest; return the size in bytes. Errors never include the (presigned) URL."""
    limit = _max_audio_bytes()
    try:
        with requests.get(url, stream=True, timeout=DOWNLOAD_TIMEOUT_SEC) as resp:
            if resp.status_code == 403:
                raise WorkerFailure("url_expired", "download failed: presigned URL expired or invalid")
            if resp.status_code != 200:
                raise WorkerFailure("download_error", f"download failed: HTTP {resp.status_code}")
            if int(resp.headers.get("Content-Length") or 0) > limit:
                raise WorkerFailure("too_large", f"audio file larger than MAX_AUDIO_MB ({limit // 2**20} MB)")
            size = 0
            with dest.open("wb") as out:
                for block in resp.iter_content(chunk_size=1 << 20):
                    size += len(block)
                    if size > limit:
                        raise WorkerFailure("too_large", f"audio file larger than MAX_AUDIO_MB ({limit // 2**20} MB)")
                    out.write(block)
    except requests.Timeout as exc:
        raise WorkerFailure("download_error", "download failed: timed out") from exc
    except requests.RequestException as exc:
        raise WorkerFailure("download_error", f"download failed: {type(exc).__name__}") from exc
    return size


def _error_type(error: str) -> str:
    """Classify a pipeline FailedResult by the stage named in its error ("<stage> failed: ...")."""
    stage = error.split(" failed", 1)[0]
    return "decode_error" if stage == "decode" else "model_error"


def _model_ids() -> dict[str, Any]:
    return {
        "ast": config.AST_MODEL_ID,
        "diarization": config.PYANNOTE_DIARIZATION_ID,
        "segmentation": config.PYANNOTE_SEGMENTATION_ID,
        "vad": config.SILERO_VAD_ID,
        "dnsmos": config.DNSMOS_PATH.name,
        "emotion2vec": config.EMOTION2VEC_DIR.name,
        "emotion2vec_large": config.EMOTION2VEC_LARGE_DIR.name if models.get("emotion2vec_large") else None,
        "unavailable": sorted(models.load_errors()),
    }


def _dumps(obj: dict[str, Any]) -> bytes:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


@cache
def _s3_client() -> Any:
    import boto3

    return boto3.client("s3")


def _write_outputs(event: WorkerEvent, result: dict, metrics: dict) -> str:
    """Write result + metrics; return where the result went (S3 key or local path)."""
    bucket = os.environ.get("BUCKET")
    name = event.name
    if bucket and not event.audio_path:
        prefix = f"runs/{event.user_id}/{event.run_id}"
        result_key = f"{prefix}/results/{name}.json"
        s3 = _s3_client()
        s3.put_object(Bucket=bucket, Key=result_key, Body=_dumps(result), ContentType="application/json")
        s3.put_object(Bucket=bucket, Key=f"{prefix}/metrics/{name}.json", Body=_dumps(metrics),
                      ContentType="application/json")  # fmt: skip
        return result_key
    out = LOCAL_OUT_DIR / (event.run_id or "local")
    for kind, obj in (("results", result), ("metrics", metrics)):
        (out / kind).mkdir(parents=True, exist_ok=True)
        (out / kind / f"{name}.json").write_bytes(_dumps(obj))
    return str(out / "results" / f"{name}.json")


class _Alarm:
    """SIGALRM TIMEOUT_MARGIN_SEC before Lambda's timeout. Only possible on the main thread.

    The pipeline turns every exception into a "<stage> failed" result, and requests can wrap it,
    so whether the alarm fired is tracked here rather than by catching the exception.
    """

    def __init__(self, context: Any):
        self.fired = False
        remaining_ms = getattr(context, "get_remaining_time_in_millis", None)
        self.armed = remaining_ms is not None and threading.current_thread() is threading.main_thread()
        if self.armed:
            signal.signal(signal.SIGALRM, self._on_alarm)
            signal.alarm(max(1, int(remaining_ms() / 1000 - TIMEOUT_MARGIN_SEC)))

    def _on_alarm(self, signum: int, frame: Any) -> None:
        self.fired = True
        raise TimeoutError(TIMEOUT_ERROR)

    def cancel(self) -> None:
        if self.armed:
            signal.alarm(0)


def _process(event: WorkerEvent, alarm: _Alarm, timings: dict[str, Any]) -> tuple[dict, str | None, int | None]:
    """Download (if needed) and analyze; return (result, error_type, audio_bytes). Cleans up /tmp."""
    work_dir = None
    audio_bytes = None
    try:
        if event.audio_url:
            work_dir = Path(tempfile.gettempdir()) / uuid.uuid4().hex
            work_dir.mkdir()
            path = work_dir / event.name
            t = time.perf_counter()
            audio_bytes = _download(event.audio_url, path)
            timings["download_sec"] = round(time.perf_counter() - t, 3)
        else:
            path = Path(event.audio_path)
            audio_bytes = path.stat().st_size if path.is_file() else None

        t = time.perf_counter()
        timings["analyze_sec"] = None  # marks that the pipeline ran, for the stage timings
        result = pipeline.analyze(path)
        timings["analyze_sec"] = round(time.perf_counter() - t, 3)
        error_type = _error_type(result["error"]) if result.get("status") == "failed" else None
    except WorkerFailure as exc:
        result, error_type = {"status": "failed", "error": exc.error}, exc.error_type
    except Exception as exc:
        if not alarm.fired:
            raise
        result, error_type = {"status": "failed", "error": TIMEOUT_ERROR}, "timeout"
    finally:
        alarm.cancel()
        if work_dir is not None:
            shutil.rmtree(work_dir, ignore_errors=True)
    if alarm.fired:
        result, error_type = {"status": "failed", "error": TIMEOUT_ERROR}, "timeout"
    return result, error_type, audio_bytes


def _parse(event: Any) -> WorkerEvent:
    parsed = WorkerEvent.model_validate(event)
    if os.environ.get("BUCKET") and parsed.audio_url and not (parsed.run_id and parsed.user_id):
        raise ValueError("run_id and user_id are required to write results to S3")
    return parsed


def handler(event: dict[str, Any], context: Any = None) -> dict[str, Any]:
    global _cold_start
    cold_start, _cold_start = _cold_start, False
    started = time.perf_counter()
    started_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    raw = event if isinstance(event, dict) else {}

    try:
        parsed = _parse(event)
    except (ValidationError, ValueError) as exc:
        reason = exc.errors()[0]["msg"] if isinstance(exc, ValidationError) else str(exc)
        # An invalid name or id can't be used in an output path, so nothing is written
        logger.info(json.dumps({"run_id": raw.get("run_id"), "name": raw.get("name"), "status": "rejected",
                                "error": reason, "cold_start": cold_start}))  # fmt: skip
        return {"name": raw.get("name"), "status": "failed", "result_key": None, "error": f"invalid event: {reason}"}

    timings: dict[str, Any] = {}
    remaining_at_start = context.get_remaining_time_in_millis() if hasattr(context, "get_remaining_time_in_millis") else None
    audio_bytes = None
    try:
        result, error_type, audio_bytes = _process(parsed, _Alarm(context), timings)
    except Exception as exc:  # last resort: still write a failure object
        logger.exception("unexpected worker error")
        result, error_type = {"status": "failed", "error": f"internal error: {type(exc).__name__}"}, "internal_error"

    ran_pipeline = "analyze_sec" in timings
    timings["stages"] = dict(pipeline.last_run.stage_seconds) if ran_pipeline else {}
    timings["total_sec"] = round(time.perf_counter() - started, 3)
    status = "failed" if result.get("status") == "failed" else "done"
    metrics = {
        "run_id": parsed.run_id,
        "user_id": parsed.user_id,
        "name": parsed.name,
        "status": status,
        "error_type": error_type,
        "started_at": started_at,
        "cold_start": cold_start,
        "init_sec": INIT_SECONDS if cold_start else 0.0,
        "audio_duration_sec": pipeline.last_run.audio_duration_sec if ran_pipeline else None,
        "audio_bytes": audio_bytes,
        "timings": timings,
        "lambda": {
            "request_id": getattr(context, "aws_request_id", None),
            "memory_limit_mb": getattr(context, "memory_limit_in_mb", None),
            "remaining_ms_at_start": remaining_at_start,
        },
        "models": _model_ids(),
    }
    try:
        result_key = _write_outputs(parsed, result, metrics)
    except Exception as exc:
        logger.exception("could not write outputs")
        status, result_key, error_type = "failed", None, f"write_error: {type(exc).__name__}"

    logger.info(json.dumps({
        "run_id": parsed.run_id, "name": parsed.name, "status": status, "error_type": error_type,
        "cold_start": cold_start, "total_sec": timings["total_sec"], "download_sec": timings.get("download_sec"),
        "analyze_sec": timings.get("analyze_sec"), "audio_duration_sec": metrics["audio_duration_sec"],
    }))  # fmt: skip
    return {"name": parsed.name, "status": status, "result_key": result_key}
