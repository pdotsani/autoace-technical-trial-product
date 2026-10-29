"""All model paths and decision thresholds for the worker.

Every threshold is a first guess. They are read from the environment so a calibration
run can override them without code changes.
"""

import os
from pathlib import Path

WORKER_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = WORKER_DIR.parent
RESULT_SCHEMA_PATH = REPO_ROOT / "shared" / "schema" / "result.schema.json"


def _env_float(name: str, default: float) -> float:
    return float(os.environ.get(name, default))


def _env_int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


def _default_models_dir() -> Path:
    # LAMBDA_TASK_ROOT is set inside the AWS Lambda runtime / base images
    if os.environ.get("LAMBDA_TASK_ROOT"):
        return Path("/opt/models")
    return WORKER_DIR / "models"


# --- Model locations -------------------------------------------------------------------
MODELS_DIR = Path(os.environ.get("MODELS_DIR", _default_models_dir())).resolve()
HF_CACHE_DIR = MODELS_DIR / "hf"
EMOTION2VEC_DIR = MODELS_DIR / "emotion2vec"
EMOTION2VEC_LARGE_DIR = MODELS_DIR / "emotion2vec_large"  # optional; end-of-call satisfied check
DNSMOS_PATH = MODELS_DIR / "dnsmos" / "sig_bak_ovr.onnx"
TONE_CLASSIFIER_PATH = MODELS_DIR / "custom" / "tone_classifier.joblib"

AST_MODEL_ID = "MIT/ast-finetuned-audioset-10-10-0.4593"
PYANNOTE_DIARIZATION_ID = "pyannote/speaker-diarization-community-1"  # native pyannote 4 pipeline
PYANNOTE_SEGMENTATION_ID = "pyannote/segmentation-3.0"
SILERO_VAD_ID = "silero-vad (bundled with the silero-vad package)"

FFMPEG_BIN = os.environ.get("FFMPEG_BIN", "ffmpeg")
TORCH_NUM_THREADS = _env_int("TORCH_NUM_THREADS", os.cpu_count() or 1)


def apply_offline_env() -> None:
    """Force Hugging Face libraries to read only from MODELS_DIR/hf. Call before importing them."""
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_CACHE"] = str(HF_CACHE_DIR)
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")


# --- Decoding --------------------------------------------------------------------------
SAMPLE_RATE = 16000
# Which channel holds the customer in stereo recordings. TODO: confirm with data
CUSTOMER_CHANNEL = _env_int("CUSTOMER_CHANNEL", 1)
# Channels whose difference is below this fraction of their RMS are treated as one mono signal.
# TODO: calibrate on dev set
DUPLICATE_CHANNEL_RATIO = _env_float("DUPLICATE_CHANNEL_RATIO", 0.01)
# A channel quieter than this is treated as empty (e.g. stereo file with one dead side).
# TODO: calibrate on dev set
EMPTY_CHANNEL_DBFS = _env_float("EMPTY_CHANNEL_DBFS", -70.0)

# --- VAD / silence / overlap -----------------------------------------------------------
VAD_THRESHOLD = _env_float("VAD_THRESHOLD", 0.5)  # TODO: calibrate on dev set
VAD_MIN_SPEECH_MS = _env_int("VAD_MIN_SPEECH_MS", 250)  # TODO: calibrate on dev set
VAD_MIN_SILENCE_MS = _env_int("VAD_MIN_SILENCE_MS", 300)  # TODO: calibrate on dev set
LONG_SILENCE_SEC = _env_float("LONG_SILENCE_SEC", 8.0)  # TODO: calibrate on dev set
# Count silence before the first / after the last speech (ringing, hold-up) as long silence.
# TODO: calibrate on dev set
LONG_SILENCE_INCLUDE_EDGES = os.environ.get("LONG_SILENCE_INCLUDE_EDGES", "0") == "1"
# Silence also has to be quiet: VAD can miss soft speech, which is not dead air.
SILENCE_MAX_DBFS = _env_float("SILENCE_MAX_DBFS", -40.0)  # TODO: calibrate on dev set
SILENCE_FRAME_SEC = 0.1
OVERLAP_SEC = _env_float("OVERLAP_SEC", 0.6)  # TODO: calibrate on dev set
# Mono: per-frame second-speaker activation above this counts as overlap.
OVERLAP_ONSET = _env_float("OVERLAP_ONSET", 0.5)  # TODO: calibrate on dev set

# --- Audio quality (DNSMOS SIG/OVRL + signal checks; never BAK) --------------------------
DNSMOS_HOP_SEC = _env_float("DNSMOS_HOP_SEC", 9.01)  # 9.01 = non-overlapping windows
DNSMOS_MIN_SPEECH_SEC = _env_float("DNSMOS_MIN_SPEECH_SEC", 2.0)  # TODO: calibrate on dev set
SIG_CLEAR_MIN = _env_float("SIG_CLEAR_MIN", 3.0)  # TODO: calibrate on dev set
SIG_SEVERE_MAX = _env_float("SIG_SEVERE_MAX", 2.5)  # TODO: calibrate on dev set
OVRL_CLEAR_MIN = _env_float("OVRL_CLEAR_MIN", 2.8)  # TODO: calibrate on dev set
OVRL_SEVERE_MAX = _env_float("OVRL_SEVERE_MAX", 2.0)  # TODO: calibrate on dev set
CLIP_LEVEL = _env_float("CLIP_LEVEL", 0.99)  # TODO: calibrate on dev set
CLIP_RATIO_SLIGHT = _env_float("CLIP_RATIO_SLIGHT", 0.001)  # TODO: calibrate on dev set
CLIP_RATIO_SEVERE = _env_float("CLIP_RATIO_SEVERE", 0.01)  # TODO: calibrate on dev set
SPEECH_RMS_SLIGHT_DBFS = _env_float("SPEECH_RMS_SLIGHT_DBFS", -38.0)  # TODO: calibrate on dev set
SPEECH_RMS_SEVERE_DBFS = _env_float("SPEECH_RMS_SEVERE_DBFS", -50.0)  # TODO: calibrate on dev set

# --- Background noise (AST on non-speech frames + DNSMOS BAK) ----------------------------
NOISE_MIN_GAP_SEC = _env_float("NOISE_MIN_GAP_SEC", 0.5)  # shortest non-speech gap to classify
AST_CHUNK_SEC = _env_float("AST_CHUNK_SEC", 10.0)  # AST was trained on 10 s clips
AST_SILENT_CHUNK_DBFS = _env_float("AST_SILENT_CHUNK_DBFS", -60.0)  # skip near-digital-silence
AST_BATCH_SIZE = _env_int("AST_BATCH_SIZE", 8)
NOISE_EVENT_MIN = _env_float("NOISE_EVENT_MIN", 0.3)  # TODO: calibrate on dev set
BAK_NOISE_MAX = _env_float("BAK_NOISE_MAX", 3.8)  # TODO: calibrate on dev set
BAK_SEVERITY_HIGH_MAX = _env_float("BAK_SEVERITY_HIGH_MAX", 2.5)  # TODO: calibrate on dev set
BAK_SEVERITY_MEDIUM_MAX = _env_float("BAK_SEVERITY_MEDIUM_MAX", 3.6)  # TODO: calibrate on dev set
# Fraction of speech time overlapped by noise that bumps severity up / down one band.
NOISE_OVERLAP_BUMP_UP = _env_float("NOISE_OVERLAP_BUMP_UP", 0.5)  # TODO: calibrate on dev set
NOISE_OVERLAP_BUMP_DOWN = _env_float("NOISE_OVERLAP_BUMP_DOWN", 0.1)  # TODO: calibrate on dev set
# Background TV is mostly dialogue: VAD marks it as speech and AST calls it "Speech" in the
# gaps, so the gap check misses it. AST's "Television" score is also checked over the whole
# call (speech included) in sliding windows, and used when the gap check finds nothing.
TV_WINDOW_SEC = _env_float("TV_WINDOW_SEC", 10.0)
TV_HOP_SEC = _env_float("TV_HOP_SEC", 5.0)
TV_EVENT_MIN = _env_float("TV_EVENT_MIN", 0.1)  # TODO: calibrate on dev set
# Sharp static (crackle): very short bursts of 14-20 kHz energy. They sit above the 8 kHz
# limit of the 16 kHz analysis audio, so the file is also decoded at full bandwidth.
# DNSMOS BAK does not see intermittent crackle, so this check is not gated by BAK.
STATIC_SAMPLE_RATE = 48000
STATIC_BAND_HZ = (14000.0, 20000.0)
STATIC_FRAME_SEC = 0.005
STATIC_BURST_DB = _env_float("STATIC_BURST_DB", 20.0)  # above the band's median level
STATIC_MIN_BAND_DB = _env_float("STATIC_MIN_BAND_DB", -60.0)  # ignore bursts in digital silence
STATIC_RATE_MIN = _env_float("STATIC_RATE_MIN", 0.3)  # bursts/s. TODO: calibrate on dev set
STATIC_RATE_MEDIUM = _env_float("STATIC_RATE_MEDIUM", 0.6)  # TODO: calibrate on dev set
STATIC_RATE_HIGH = _env_float("STATIC_RATE_HIGH", 2.0)  # TODO: calibrate on dev set

# --- Tone (emotion2vec) --------------------------------------------------------------------
TONE_CHUNK_MIN_SEC = _env_float("TONE_CHUNK_MIN_SEC", 3.0)
TONE_CHUNK_MAX_SEC = _env_float("TONE_CHUNK_MAX_SEC", 30.0)
TONE_MIN_SPEECH_SEC = _env_float("TONE_MIN_SPEECH_SEC", 1.0)  # below this, tone is not scored
# Chunks are loudness-normalised so tone never follows raw loudness.
TONE_TARGET_DBFS = _env_float("TONE_TARGET_DBFS", -23.0)
# Baseline: "angry" at or above this probability -> upset, below -> frustrated.
# TODO: calibrate on dev set
ANGRY_UPSET_MIN = _env_float("ANGRY_UPSET_MIN", 0.6)
# Baseline: tone that emotion2vec's "sad" maps to. "upset" keeps "distressed" for fear/panic only.
# TODO: calibrate on dev set
SAD_TONE = os.environ.get("SAD_TONE", "upset")
TONE_SUSTAINED_MIN_CHUNKS = _env_int("TONE_SUSTAINED_MIN_CHUNKS", 2)  # TODO: calibrate on dev set
INTENSITY_HIGH_MARGIN = _env_float("INTENSITY_HIGH_MARGIN", 0.5)  # TODO: calibrate on dev set
# Lowered from 0.2 so borderline cases (margin 0.1-0.2) read as medium, not low.
INTENSITY_MEDIUM_MARGIN = _env_float("INTENSITY_MEDIUM_MARGIN", 0.1)  # TODO: calibrate on dev set
# Intensity reported when the tone is neutral (emotion2vec margins say nothing about intensity
# there). "medium" = ordinary engaged conversation. TODO: calibrate on dev set
NEUTRAL_INTENSITY = os.environ.get("NEUTRAL_INTENSITY", "medium")
# A neutral call becomes satisfied when emotion2vec_plus_large scores the customer's last chunk
# "happy" at or above this ("<unk>" excluded). Set from 3 labelled calls only (call_002 0.72,
# call_003 0.985). TODO: calibrate on dev set
END_SATISFIED_HAPPY_MIN = _env_float("END_SATISFIED_HAPPY_MIN", 0.9)
NO_SPEECH_CONFIDENCE = _env_float("NO_SPEECH_CONFIDENCE", 0.2)  # TODO: calibrate on dev set
UNCERTAIN_CHANNEL_PENALTY = _env_float("UNCERTAIN_CHANNEL_PENALTY", 0.1)
