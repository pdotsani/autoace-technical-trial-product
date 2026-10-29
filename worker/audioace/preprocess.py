"""Decode any audio file with ffmpeg to 16 kHz float32, one array per channel."""

import struct
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import config


class DecodeError(RuntimeError):
    pass


@dataclass(frozen=True)
class DecodedAudio:
    channels: list[np.ndarray]  # float32 in [-1, 1] at config.SAMPLE_RATE
    sample_rate: int
    mode: str  # stereo | mono | mono_duplicate_stereo | mono_single_live_channel

    @property
    def is_stereo(self) -> bool:
        return self.mode == "stereo"

    @property
    def duration_sec(self) -> float:
        return len(self.channels[0]) / self.sample_rate


def rms_dbfs(audio: np.ndarray) -> float:
    if audio.size == 0:
        return -200.0
    rms = float(np.sqrt(np.mean(np.square(audio, dtype=np.float64))))
    return 20.0 * np.log10(max(rms, 1e-10))


def decode(path: Path) -> DecodedAudio:
    if not path.is_file():
        raise DecodeError(f"file not found: {path}")
    channels = _split_channels(_run_ffmpeg(path, config.SAMPLE_RATE))
    if channels[0].size == 0:
        raise DecodeError(f"no audio samples decoded from {path}")
    return _detect_layout(channels)


def decode_fullband(path: Path) -> np.ndarray:
    """Mono mix at STATIC_SAMPLE_RATE, keeping content above 8 kHz (used for static detection)."""
    return _split_channels(_run_ffmpeg(path, config.STATIC_SAMPLE_RATE, mono=True))[0]


def _run_ffmpeg(path: Path, sample_rate: int, mono: bool = False) -> bytes:
    cmd = [
        config.FFMPEG_BIN, "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", str(path), "-map", "0:a:0", "-vn", *(["-ac", "1"] if mono else []),
        "-ar", str(sample_rate), "-acodec", "pcm_f32le", "-f", "wav", "-",
    ]  # fmt: skip
    try:
        proc = subprocess.run(cmd, capture_output=True, check=False)
    except FileNotFoundError as exc:
        raise DecodeError(f"ffmpeg binary not found: {config.FFMPEG_BIN} (set FFMPEG_BIN)") from exc
    if proc.returncode != 0:
        stderr = proc.stderr.decode(errors="replace").strip()
        raise DecodeError(f"ffmpeg could not decode {path.name}: {stderr[-500:] or 'unknown error'}")
    return proc.stdout


def _split_channels(wav: bytes) -> list[np.ndarray]:
    """Parse the WAV stream ffmpeg wrote to stdout (header sizes may be placeholders)."""
    if wav[:4] != b"RIFF" or wav[8:12] != b"WAVE":
        raise DecodeError("ffmpeg output is not a WAV stream")
    pos, n_channels = 12, 0
    while pos + 8 <= len(wav):
        chunk_id = wav[pos : pos + 4]
        size = struct.unpack("<I", wav[pos + 4 : pos + 8])[0]
        body = pos + 8
        if chunk_id == b"fmt ":
            n_channels = struct.unpack("<H", wav[body + 2 : body + 4])[0]
        elif chunk_id == b"data":
            if n_channels == 0:
                raise DecodeError("WAV data chunk before fmt chunk")
            payload = wav[body:]  # streamed output: data runs to the end
            frame_bytes = 4 * n_channels
            usable = len(payload) - len(payload) % frame_bytes
            samples = np.frombuffer(payload[:usable], dtype="<f4").reshape(-1, n_channels)
            samples = np.nan_to_num(samples, nan=0.0, posinf=1.0, neginf=-1.0)
            return [np.ascontiguousarray(samples[:, c], dtype=np.float32) for c in range(n_channels)]
        pos = body + size + (size & 1)
    raise DecodeError("no data chunk in ffmpeg output")


def _detect_layout(channels: list[np.ndarray]) -> DecodedAudio:
    if len(channels) == 1:
        return DecodedAudio(channels, config.SAMPLE_RATE, "mono")

    left, right = channels[0], channels[1]  # >2 channels: only the first two are used
    left_db, right_db = rms_dbfs(left), rms_dbfs(right)
    if left_db < config.EMPTY_CHANNEL_DBFS or right_db < config.EMPTY_CHANNEL_DBFS:
        live = left if left_db >= right_db else right
        return DecodedAudio([live], config.SAMPLE_RATE, "mono_single_live_channel")

    diff_db = rms_dbfs(left - right)
    ratio_db = 20.0 * np.log10(config.DUPLICATE_CHANNEL_RATIO)
    if diff_db < max(left_db, right_db) + ratio_db:
        mono = ((left + right) * 0.5).astype(np.float32)
        return DecodedAudio([mono], config.SAMPLE_RATE, "mono_duplicate_stereo")

    return DecodedAudio([left, right], config.SAMPLE_RATE, "stereo")
