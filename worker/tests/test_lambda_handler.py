"""The Lambda worker adapter: event checks, download, S3 / local outputs, timeout. S3 is mocked with moto."""

import json
import shutil
import time
from pathlib import Path
from typing import Any

import boto3
import pytest
from moto import mock_aws

from adapters import lambda_handler
from audioace import config, models, pipeline

BUCKET = "test-bucket"
PRESIGNED = "https://test-bucket.s3.amazonaws.com/uploads/call.wav?X-Amz-Signature=secret"
RESULT = {
    "emotional_tone": "neutral",
    "emotional_intensity": "medium",
    "background_noise_present": False,
    "background_noise_type": "",
    "background_noise_severity": "none",
    "audio_quality": "clear",
    "speaker_overlap_present": False,
    "long_silence_present": False,
    "confidence": 0.8,
}

needs_ffmpeg = pytest.mark.skipif(
    shutil.which(config.FFMPEG_BIN) is None, reason=f"ffmpeg not found ({config.FFMPEG_BIN}); set FFMPEG_BIN"
)


class FakeResponse:
    def __init__(self, status_code: int, body: bytes = b""):
        self.status_code = status_code
        self.headers = {"Content-Length": str(len(body))}
        self._body = body

    def iter_content(self, chunk_size: int) -> Any:
        for i in range(0, len(self._body), chunk_size):
            yield self._body[i : i + chunk_size]

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *exc: Any) -> None:
        pass


class FakeContext:
    aws_request_id = "req-1"
    memory_limit_in_mb = 3008

    def __init__(self, remaining_sec: float = 900):
        self._deadline = time.monotonic() + remaining_sec

    def get_remaining_time_in_millis(self) -> int:
        return int((self._deadline - time.monotonic()) * 1000)


@pytest.fixture
def s3(monkeypatch: pytest.MonkeyPatch) -> Any:
    for var, value in {"AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing",
                       "AWS_DEFAULT_REGION": "us-east-1", "BUCKET": BUCKET}.items():  # fmt: skip
        monkeypatch.setenv(var, value)
    monkeypatch.delenv("AWS_PROFILE", raising=False)
    with mock_aws():
        lambda_handler._s3_client.cache_clear()
        client = boto3.client("s3")
        client.create_bucket(Bucket=BUCKET)
        yield client
    lambda_handler._s3_client.cache_clear()


@pytest.fixture
def tmp_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Downloads go here instead of /tmp, so the tests can check the folder is removed."""
    root = tmp_path / "lambda_tmp"
    root.mkdir()
    monkeypatch.setattr(lambda_handler.tempfile, "gettempdir", lambda: str(root))
    return root


def _serve(monkeypatch: pytest.MonkeyPatch, response: FakeResponse) -> None:
    monkeypatch.setattr(lambda_handler.requests, "get", lambda url, **kwargs: response)


def _stub_analyze(monkeypatch: pytest.MonkeyPatch, result: dict) -> list[Path]:
    seen: list[Path] = []

    def analyze(path: Path) -> dict:
        seen.append(Path(path))
        assert Path(path).is_file()
        pipeline.last_run = pipeline.RunStats({"decode": 0.1, "tone": 0.2}, 12.5)
        return result

    monkeypatch.setattr(pipeline, "analyze", analyze)
    return seen


def _event(name: str = "call 001.wav") -> dict:
    return {"run_id": "run1", "user_id": "user1", "name": name, "audio_url": PRESIGNED}


def _get(s3: Any, key: str) -> tuple[dict, str, bytes]:
    obj = s3.get_object(Bucket=BUCKET, Key=key)
    body = obj["Body"].read()
    return json.loads(body), obj["ContentType"], body


def test_success_writes_result_and_metrics(s3: Any, tmp_root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _serve(monkeypatch, FakeResponse(200, b"audio bytes"))
    seen = _stub_analyze(monkeypatch, RESULT)

    returned = lambda_handler.handler(_event(), FakeContext())

    key = "runs/user1/run1/results/call 001.wav.json"
    assert returned == {"name": "call 001.wav", "status": "done", "result_key": key}
    result, content_type, body = _get(s3, key)
    assert result == RESULT and content_type == "application/json"
    assert b": " not in body and b", " not in body  # compact JSON
    metrics, content_type, _ = _get(s3, "runs/user1/run1/metrics/call 001.wav.json")
    assert content_type == "application/json"
    assert metrics["status"] == "done" and metrics["error_type"] is None
    assert metrics["audio_duration_sec"] == 12.5 and metrics["audio_bytes"] == len(b"audio bytes")
    assert metrics["timings"]["stages"] == {"decode": 0.1, "tone": 0.2}
    assert {"download_sec", "analyze_sec", "total_sec"} <= set(metrics["timings"])
    assert metrics["lambda"]["request_id"] == "req-1"
    assert metrics["models"]["ast"] == config.AST_MODEL_ID
    assert isinstance(metrics["cold_start"], bool)
    assert seen[0].name == "call 001.wav"  # downloaded under the exact original name
    assert list(tmp_root.iterdir()) == []  # /tmp/<uuid> removed


def test_cold_start_only_on_first_invocation(s3: Any, tmp_root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _serve(monkeypatch, FakeResponse(200, b"x"))
    _stub_analyze(monkeypatch, RESULT)
    monkeypatch.setattr(lambda_handler, "_cold_start", True)

    lambda_handler.handler(_event("a.wav"), FakeContext())
    lambda_handler.handler(_event("b.wav"), FakeContext())

    assert _get(s3, "runs/user1/run1/metrics/a.wav.json")[0]["cold_start"] is True
    assert _get(s3, "runs/user1/run1/metrics/b.wav.json")[0]["cold_start"] is False


@needs_ffmpeg
def test_corrupt_file_writes_failure(s3: Any, tmp_root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _serve(monkeypatch, FakeResponse(200, b"RIFF\x00\x00\x00\x00WAVEnot really audio" + bytes(range(256)) * 4))

    returned = lambda_handler.handler(_event("corrupt.wav"), FakeContext())

    assert returned["status"] == "failed"
    result, _, _ = _get(s3, returned["result_key"])
    assert result["status"] == "failed" and result["error"].startswith("decode failed")
    assert _get(s3, "runs/user1/run1/metrics/corrupt.wav.json")[0]["error_type"] == "decode_error"
    assert list(tmp_root.iterdir()) == []


def test_expired_url_writes_failure_and_never_logs_url(
    s3: Any, tmp_root: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    _serve(monkeypatch, FakeResponse(403, b"<Error>AccessDenied</Error>"))
    caplog.set_level("INFO")

    returned = lambda_handler.handler(_event(), FakeContext())

    assert returned["status"] == "failed"
    result, _, _ = _get(s3, returned["result_key"])
    assert result == {"status": "failed", "error": "download failed: presigned URL expired or invalid"}
    metrics, _, _ = _get(s3, "runs/user1/run1/metrics/call 001.wav.json")
    assert metrics["error_type"] == "url_expired"
    assert "secret" not in caplog.text and "X-Amz" not in caplog.text
    assert "secret" not in json.dumps(metrics)
    assert list(tmp_root.iterdir()) == []


def test_oversized_download_writes_failure(s3: Any, tmp_root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAX_AUDIO_MB", "0.000001")
    _serve(monkeypatch, FakeResponse(200, b"more than one byte"))

    returned = lambda_handler.handler(_event(), FakeContext())

    assert _get(s3, returned["result_key"])[0]["error"].startswith("audio file larger than MAX_AUDIO_MB")
    assert _get(s3, "runs/user1/run1/metrics/call 001.wav.json")[0]["error_type"] == "too_large"


@pytest.mark.parametrize("name", ["../call.wav", "dir/call.wav", "dir\\call.wav", ".call.wav", ""])
def test_bad_name_is_rejected(name: str, s3: Any, tmp_root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(lambda_handler.requests, "get", lambda *a, **k: pytest.fail("must not download"))

    returned = lambda_handler.handler(_event(name), FakeContext())

    assert returned["status"] == "failed" and returned["result_key"] is None
    assert returned["error"].startswith("invalid event")
    assert "Contents" not in s3.list_objects_v2(Bucket=BUCKET)


def test_timeout_writes_failure(s3: Any, tmp_root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _serve(monkeypatch, FakeResponse(200, b"x"))

    def slow_measure(path: Path) -> Any:  # the alarm fires inside a pipeline stage
        return pipeline._run_stage("tone", lambda: time.sleep(5))

    monkeypatch.setattr(pipeline, "measure", slow_measure)
    started = time.monotonic()

    returned = lambda_handler.handler(_event(), FakeContext(remaining_sec=lambda_handler.TIMEOUT_MARGIN_SEC + 1))

    assert time.monotonic() - started < 4
    assert _get(s3, returned["result_key"])[0] == {"status": "failed", "error": "processing exceeded time limit"}
    assert _get(s3, "runs/user1/run1/metrics/call 001.wav.json")[0]["error_type"] == "timeout"
    assert list(tmp_root.iterdir()) == []


def test_local_mode_writes_to_out(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("BUCKET", raising=False)
    monkeypatch.chdir(tmp_path)
    audio = tmp_path / "call 002.wav"
    audio.write_bytes(b"audio")
    _stub_analyze(monkeypatch, RESULT)

    returned = lambda_handler.handler({"name": audio.name, "audio_path": str(audio)})

    assert returned == {"name": "call 002.wav", "status": "done", "result_key": "out/local/results/call 002.wav.json"}
    assert json.loads((tmp_path / returned["result_key"]).read_text()) == RESULT
    metrics = json.loads((tmp_path / "out/local/metrics/call 002.wav.json").read_text())
    assert metrics["status"] == "done" and "download_sec" not in metrics["timings"]
    assert audio.exists()  # a local input file is never deleted


def test_audio_path_skips_s3_even_with_bucket(s3: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    audio = tmp_path / "c.wav"
    audio.write_bytes(b"audio")
    _stub_analyze(monkeypatch, RESULT)

    returned = lambda_handler.handler({"run_id": "r9", "name": "c.wav", "audio_path": str(audio)})

    assert returned["result_key"] == "out/r9/results/c.wav.json"
    assert (tmp_path / "out/r9/metrics/c.wav.json").is_file()
    assert "Contents" not in s3.list_objects_v2(Bucket=BUCKET)


@needs_ffmpeg
@pytest.mark.skipif(bool(models.load_errors()), reason=f"models unavailable under {config.MODELS_DIR}")
def test_real_pipeline_result_matches_cli(s3: Any, tmp_root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fixture = Path.home() / "Downloads" / "call_001.ogg"
    if not fixture.is_file():
        pytest.skip(f"{fixture} not found")
    _serve(monkeypatch, FakeResponse(200, fixture.read_bytes()))

    returned = lambda_handler.handler(_event("call_001.ogg"), FakeContext())

    assert _get(s3, returned["result_key"])[0] == pipeline.analyze(fixture)
    metrics = _get(s3, "runs/user1/run1/metrics/call_001.ogg.json")[0]
    assert metrics["audio_duration_sec"] > 0 and "tone" in metrics["timings"]["stages"]
