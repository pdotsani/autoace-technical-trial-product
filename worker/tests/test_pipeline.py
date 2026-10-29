"""End-to-end runs on generated audio. Model-dependent tests skip when models are missing."""

import json
import shutil
import subprocess
import sys
import wave
from pathlib import Path

import jsonschema
import numpy as np
import pytest

from audioace import config, models, pipeline
from audioace.schema import Result

WORKER_DIR = Path(__file__).resolve().parents[1]
SR = config.SAMPLE_RATE

needs_ffmpeg = pytest.mark.skipif(
    shutil.which(config.FFMPEG_BIN) is None, reason=f"ffmpeg not found ({config.FFMPEG_BIN}); set FFMPEG_BIN"
)


def _needs_models(*names: str) -> pytest.MarkDecorator:
    missing = {n: e for n, e in models.load_errors().items() if n in names}
    return pytest.mark.skipif(bool(missing), reason=f"models unavailable under {config.MODELS_DIR}: {missing}")


def _tone(seconds: float, freq: float, amp: float = 0.3) -> np.ndarray:
    t = np.arange(int(seconds * SR)) / SR
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def _silence(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * SR), dtype=np.float32)


def _write_wav(path: Path, channels: list[np.ndarray]) -> Path:
    frames = np.stack(channels, axis=1)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(len(channels))
        wav.setsampwidth(2)
        wav.setframerate(SR)
        wav.writeframes((np.clip(frames, -1, 1) * 32767).astype("<i2").tobytes())
    return path


def _assert_valid(result: dict) -> None:
    Result(**result)
    jsonschema.validate(result, json.loads(config.RESULT_SCHEMA_PATH.read_text()))


@pytest.fixture
def stereo_wav(tmp_path: Path) -> Path:
    left = np.concatenate([_tone(2, 220), _silence(6), _tone(2, 220)])
    right = np.concatenate([_silence(3), _tone(2, 330), _silence(5)])
    return _write_wav(tmp_path / "stereo.wav", [left, right])


@pytest.fixture
def mono_wav(tmp_path: Path) -> Path:
    return _write_wav(tmp_path / "mono.wav", [np.concatenate([_tone(2, 220), _silence(6), _tone(2, 330)])])


@needs_ffmpeg
def test_corrupt_file_returns_failed_result(tmp_path: Path) -> None:
    corrupt = tmp_path / "corrupt.wav"
    corrupt.write_bytes(b"RIFF\x00\x00\x00\x00WAVEnot really audio" + bytes(range(256)) * 4)
    result = pipeline.analyze(corrupt)
    assert result["status"] == "failed"
    assert result["error"].startswith("decode failed")


def test_missing_file_returns_failed_result(tmp_path: Path) -> None:
    result = pipeline.analyze(tmp_path / "nope.wav")
    assert result == {"status": "failed", "error": result["error"]}
    assert "file not found" in result["error"]


@needs_ffmpeg
def test_stereo_layout_detection(tmp_path: Path, stereo_wav: Path) -> None:
    from audioace.preprocess import decode

    assert decode(stereo_wav).mode == "stereo"
    duplicated = _tone(3, 220)
    assert decode(_write_wav(tmp_path / "dup.wav", [duplicated, duplicated])).mode == "mono_duplicate_stereo"
    assert decode(_write_wav(tmp_path / "dead.wav", [duplicated, _silence(3)])).mode == "mono_single_live_channel"


@needs_ffmpeg
@_needs_models("vad", "dnsmos", "ast", "emotion2vec")
def test_stereo_end_to_end(stereo_wav: Path) -> None:
    result = pipeline.analyze(stereo_wav)
    _assert_valid(result)


@needs_ffmpeg
@_needs_models("vad", "dnsmos", "ast", "emotion2vec", "diarization", "overlap")
def test_mono_end_to_end(mono_wav: Path) -> None:
    _assert_valid(pipeline.analyze(mono_wav))


@needs_ffmpeg
@_needs_models("vad", "dnsmos", "ast", "emotion2vec")
def test_cli_prints_result_json(stereo_wav: Path) -> None:
    proc = subprocess.run(
        [sys.executable, "-m", "cli.analyze_file", str(stereo_wav)],
        cwd=WORKER_DIR, capture_output=True, text=True, check=True,
    )  # fmt: skip
    output = json.loads(proc.stdout)
    assert list(output) == ["name", "total_seconds", "result_json"]
    assert output["name"] == "stereo.wav"
    _assert_valid(output["result_json"])
