"""emotion2vec_large loads only for neutral-sounding calls and is freed again afterwards."""

from typing import Any

import numpy as np
import pytest

from audioace import config, models, tone
from audioace.features import Interval

SR = 16000
LABELS = ["angry", "happy", "neutral", "sad"]


class FakeEmotion2vec:
    def __init__(self, scores: list[float]):
        self.scores = scores
        self.calls = 0

    def generate(self, input: Any, **_: Any) -> list[dict]:
        self.calls += 1
        return [{"labels": LABELS, "scores": self.scores, "feats": np.zeros(4)}]


@pytest.fixture
def fake_models(monkeypatch: pytest.MonkeyPatch):
    """Replace the real emotion models with fakes; returns (set base scores, large-load counter)."""
    loads = {"large": 0}
    large = FakeEmotion2vec([0.0, 0.95, 0.05, 0.0])

    def load_large() -> FakeEmotion2vec:
        loads["large"] += 1
        return large

    base = {"model": FakeEmotion2vec([0.0, 0.0, 1.0, 0.0])}
    monkeypatch.setitem(models._LOADERS, "emotion2vec_large", load_large)
    monkeypatch.setitem(models._MODELS, "emotion2vec", base["model"])
    monkeypatch.setitem(models._MODELS, "tone_classifier", None)
    monkeypatch.delitem(models._MODELS, "emotion2vec_large", raising=False)
    monkeypatch.delitem(models._LOAD_ERRORS, "emotion2vec_large", raising=False)

    def set_base(scores: list[float]) -> None:
        base["model"].scores = scores

    yield set_base, loads, large
    models._MODELS.pop("emotion2vec_large", None)


def _speech(seconds: float = 6.0) -> tuple[np.ndarray, list[Interval]]:
    rng = np.random.default_rng(0)
    return (0.1 * rng.standard_normal(int(seconds * SR))).astype(np.float32), [(0.0, seconds)]


def test_large_model_is_not_loaded_at_import() -> None:
    assert "emotion2vec_large" in models._ON_DEMAND
    assert "emotion2vec_large" not in models.load_errors()


def test_large_model_runs_only_for_neutral_and_is_freed(fake_models, monkeypatch: pytest.MonkeyPatch) -> None:
    set_base, loads, large = fake_models
    monkeypatch.setattr(config, "EMOTION2VEC_LARGE_KEEP_LOADED", False)
    audio, segments = _speech()

    set_base([0.0, 0.0, 1.0, 0.0])  # neutral
    _, _, end = tone.measure_emotions(audio, segments)
    assert end is not None and end["happy"] == pytest.approx(0.95)
    assert loads["large"] == 1 and large.calls == 1
    assert not models.is_loaded("emotion2vec_large")

    set_base([1.0, 0.0, 0.0, 0.0])  # angry: the end-of-call check can't change the result
    _, _, end = tone.measure_emotions(audio, segments)
    assert end is None
    assert loads["large"] == 1 and large.calls == 1

    set_base([0.0, 0.0, 1.0, 0.0])  # neutral again: loaded again
    tone.measure_emotions(audio, segments)
    assert loads["large"] == 2


def test_keep_loaded_reuses_the_large_model(fake_models, monkeypatch: pytest.MonkeyPatch) -> None:
    _, loads, large = fake_models
    monkeypatch.setattr(config, "EMOTION2VEC_LARGE_KEEP_LOADED", True)
    audio, segments = _speech()
    tone.measure_emotions(audio, segments)
    tone.measure_emotions(audio, segments)
    assert loads["large"] == 1 and large.calls == 2
    assert models.is_loaded("emotion2vec_large")


def test_missing_large_model_skips_the_check(fake_models, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(models._LOADERS, "emotion2vec_large", lambda: None)  # not installed
    audio, segments = _speech()
    _, _, end = tone.measure_emotions(audio, segments)
    assert end is None
