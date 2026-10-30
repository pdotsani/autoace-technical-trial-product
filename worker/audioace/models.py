"""Load the models from MODELS_DIR only (never from the network).

Most load once, at import time. The models in _ON_DEMAND load on their first get() instead,
and release() frees them again: they are only needed for some calls, so they stay out of
memory (and out of the cold start) otherwise.

A model that cannot be loaded does not break the import: its error is recorded and
raised as ModelMissingError by get() when a stage actually needs it.
"""

import gc
from pathlib import Path
from typing import Any, Callable

import numpy as np

from . import config

config.apply_offline_env()  # must run before transformers / pyannote / huggingface_hub import

import onnxruntime as ort  # noqa: E402
import torch  # noqa: E402

torch.set_num_threads(config.TORCH_NUM_THREADS)


class ModelMissingError(RuntimeError):
    pass


def _hf_cached_file(repo_id: str, filename: str) -> Path:
    """Where `filename` of repo_id must be in the HF cache (snapshot that refs/main points to)."""
    repo_dir = config.HF_CACHE_DIR / f"models--{repo_id.replace('/', '--')}"
    ref = repo_dir / "refs" / "main"
    revision = ref.read_text().strip() if ref.exists() else "<revision>"
    return repo_dir / "snapshots" / revision / filename


def _require(path: Path, what: str) -> None:
    if not path.exists():
        raise ModelMissingError(
            f"{what} not found at {path} (run scripts/download_models.py or set MODELS_DIR)"
        )


def _load_vad() -> Any:
    from silero_vad import load_silero_vad

    return load_silero_vad(onnx=False)


def _load_dnsmos() -> ort.InferenceSession:
    _require(config.DNSMOS_PATH, "DNSMOS model")
    options = ort.SessionOptions()
    options.intra_op_num_threads = config.TORCH_NUM_THREADS
    return ort.InferenceSession(str(config.DNSMOS_PATH), options, providers=["CPUExecutionProvider"])


def _load_ast() -> tuple[Any, Any]:
    _require(_hf_cached_file(config.AST_MODEL_ID, "config.json"), f"AST model {config.AST_MODEL_ID}")
    from transformers import ASTFeatureExtractor, ASTForAudioClassification

    kwargs = {"cache_dir": config.HF_CACHE_DIR, "local_files_only": True}
    extractor = ASTFeatureExtractor.from_pretrained(config.AST_MODEL_ID, **kwargs)
    model = ASTForAudioClassification.from_pretrained(config.AST_MODEL_ID, **kwargs).eval()
    return extractor, model


def _load_emotion2vec() -> Any:
    _require(config.EMOTION2VEC_DIR / "model.pt", "emotion2vec model")
    from funasr import AutoModel

    return AutoModel(model=str(config.EMOTION2VEC_DIR), disable_update=True, device="cpu", log_level="ERROR")


def _load_emotion2vec_large() -> Any | None:
    if not (config.EMOTION2VEC_LARGE_DIR / "model.pt").exists():
        return None  # optional: the end-of-call satisfied check is skipped
    from funasr import AutoModel

    return AutoModel(model=str(config.EMOTION2VEC_LARGE_DIR), disable_update=True, device="cpu", log_level="ERROR")


def _load_tone_classifier() -> Any | None:
    if not config.TONE_CLASSIFIER_PATH.exists():
        return None  # optional: tone falls back to the baseline label mapping
    import joblib

    return joblib.load(config.TONE_CLASSIFIER_PATH)


_GATED_HINT = "(gated repo: accept its terms on huggingface.co, set HF_TOKEN in worker/.env and rerun scripts/download_models.py)"


def _load_diarization() -> Any:
    _require(
        _hf_cached_file(config.PYANNOTE_DIARIZATION_ID, "config.yaml"),
        f"pyannote pipeline {config.PYANNOTE_DIARIZATION_ID} {_GATED_HINT}",
    )
    from pyannote.audio import Pipeline

    pipeline = Pipeline.from_pretrained(config.PYANNOTE_DIARIZATION_ID, cache_dir=config.HF_CACHE_DIR)
    if pipeline is None:
        raise ModelMissingError(f"pyannote could not load {config.PYANNOTE_DIARIZATION_ID}")
    return pipeline.to(torch.device("cpu"))


def _second_speaker_activation(scores: np.ndarray) -> np.ndarray:
    # (chunks, frames, speakers) -> (chunks, frames, 1): activation of the 2nd most active speaker
    return np.partition(scores, -2, axis=-1)[:, :, -2, np.newaxis]


def _load_overlap() -> Any:
    _require(
        _hf_cached_file(config.PYANNOTE_SEGMENTATION_ID, "config.yaml"),
        f"pyannote model {config.PYANNOTE_SEGMENTATION_ID} {_GATED_HINT}",
    )
    from pyannote.audio import Inference, Model

    model = Model.from_pretrained(config.PYANNOTE_SEGMENTATION_ID, cache_dir=config.HF_CACHE_DIR)
    if model is None:
        raise ModelMissingError(f"pyannote could not load {config.PYANNOTE_SEGMENTATION_ID}")
    return Inference(model, pre_aggregation_hook=_second_speaker_activation, device=torch.device("cpu"))


_LOADERS: dict[str, Callable[[], Any]] = {
    "vad": _load_vad,
    "dnsmos": _load_dnsmos,
    "ast": _load_ast,
    "emotion2vec": _load_emotion2vec,
    "emotion2vec_large": _load_emotion2vec_large,
    "tone_classifier": _load_tone_classifier,
    "diarization": _load_diarization,
    "overlap": _load_overlap,
}


# Only used for neutral-sounding calls (the end-of-call satisfied check in tone.py)
_ON_DEMAND = frozenset({"emotion2vec_large"})


def _load(name: str, loaded: dict[str, Any], errors: dict[str, str]) -> None:
    try:
        loaded[name] = _LOADERS[name]()
    except Exception as exc:  # recorded, raised later by get()
        errors[name] = str(exc) if isinstance(exc, ModelMissingError) else f"{type(exc).__name__}: {exc}"


def _load_all() -> tuple[dict[str, Any], dict[str, str]]:
    loaded: dict[str, Any] = {}
    errors: dict[str, str] = {}
    for name in _LOADERS:
        if name not in _ON_DEMAND:
            _load(name, loaded, errors)
    return loaded, errors


_MODELS, _LOAD_ERRORS = _load_all()


def get(name: str) -> Any:
    if name in _ON_DEMAND and name not in _MODELS and name not in _LOAD_ERRORS:
        _load(name, _MODELS, _LOAD_ERRORS)
    if name in _LOAD_ERRORS:
        raise ModelMissingError(f"model '{name}' unavailable: {_LOAD_ERRORS[name]}")
    return _MODELS[name]


def release(name: str) -> None:
    """Free an on-demand model; the next get() loads it again."""
    if name in _ON_DEMAND and _MODELS.pop(name, None) is not None:
        gc.collect()


def is_loaded(name: str) -> bool:
    return name in _MODELS


def load_errors() -> dict[str, str]:
    return dict(_LOAD_ERRORS)
