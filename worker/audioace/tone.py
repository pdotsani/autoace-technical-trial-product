"""Customer tone and intensity from emotion2vec, aggregated over 3-30 s speech chunks."""

from dataclasses import dataclass

import numpy as np

from . import config, models
from .features import Interval, concat_segments, split_interval, total_seconds
from .preprocess import rms_dbfs

TONES = ("neutral", "satisfied", "frustrated", "upset", "distressed")
INTENSITIES = ("low", "medium", "high")
if config.SAD_TONE not in TONES:
    raise ValueError(f"SAD_TONE={config.SAD_TONE!r} must be one of {TONES}")
if config.NEUTRAL_INTENSITY not in INTENSITIES:
    raise ValueError(f"NEUTRAL_INTENSITY={config.NEUTRAL_INTENSITY!r} must be one of {INTENSITIES}")

# Baseline mapping of emotion2vec's native labels; "angry" is split by probability below.
_BASELINE_MAP = {
    "happy": "satisfied",
    "neutral": "neutral",
    "sad": config.SAD_TONE,
    "fearful": "distressed",
    "disgusted": "frustrated",
    "surprised": "neutral",
    "other": "neutral",
    "<unk>": "neutral",
}


@dataclass(frozen=True)
class ToneResult:
    tone: str
    intensity: str
    probability: float


def build_chunks(segments: list[Interval]) -> list[list[Interval]]:
    """Group speech segments into chunks of TONE_CHUNK_MIN_SEC..TONE_CHUNK_MAX_SEC of speech."""
    max_len, min_len = config.TONE_CHUNK_MAX_SEC, config.TONE_CHUNK_MIN_SEC
    chunks: list[list[Interval]] = []
    current: list[Interval] = []
    for piece in (p for seg in segments for p in split_interval(seg, max_len)):
        if current and total_seconds(current) + (piece[1] - piece[0]) > max_len:
            chunks.append(current)
            current = []
        current.append(piece)
    if current:
        chunks.append(current)

    merged: list[list[Interval]] = []
    for chunk in chunks:
        too_short = total_seconds(chunk) < min_len or (merged and total_seconds(merged[-1]) < min_len)
        if merged and too_short and total_seconds(merged[-1]) + total_seconds(chunk) <= max_len:
            merged[-1] = merged[-1] + chunk
        else:
            merged.append(chunk)
    return merged


def _normalize_loudness(clip: np.ndarray) -> np.ndarray:
    """Bring every chunk to the same loudness so tone never follows raw volume."""
    gain = 10 ** ((config.TONE_TARGET_DBFS - rms_dbfs(clip)) / 20)
    peak = float(np.max(np.abs(clip))) if clip.size else 0.0
    if peak * gain > 0.99:
        gain = 0.99 / peak
    return (clip * gain).astype(np.float32)


def baseline_tone_probs(labels: list[str], scores: list[float]) -> dict[str, float]:
    probs = dict.fromkeys(TONES, 0.0)
    for label, score in zip(labels, scores):
        name = label.split("/")[-1]
        if name == "angry":
            probs["upset" if score >= config.ANGRY_UPSET_MIN else "frustrated"] += float(score)
        else:
            probs[_BASELINE_MAP.get(name, "neutral")] += float(score)
    total = sum(probs.values())
    return {t: p / total for t, p in probs.items()} if total > 0 else {**probs, "neutral": 1.0}


def _classifier_probs(row: np.ndarray, classes: list[str]) -> dict[str, float]:
    probs = dict.fromkeys(TONES, 0.0)
    for cls, p in zip(classes, row):
        if cls not in probs:
            raise ValueError(f"tone classifier class {cls!r} is not one of {TONES}")
        probs[cls] = float(p)
    return probs


def _native_scores(output: dict) -> dict[str, float]:
    return {label: float(score) for label, score in zip(output["labels"], output["scores"])}


def measure_emotions(
    audio: np.ndarray, segments: list[Interval]
) -> tuple[list[dict[str, float]], list[dict[str, float]] | None, dict[str, float] | None]:
    """Per chunk: emotion2vec's native scores, plus tone probs if a tone classifier is installed.

    Also emotion2vec_plus_large's native scores for the last chunk, but only when the tone so far
    is neutral (the only case decide_tone uses them) and that model is installed. It is loaded
    for this and, unless EMOTION2VEC_LARGE_KEEP_LOADED, freed again afterwards.
    """
    if total_seconds(segments) < config.TONE_MIN_SPEECH_SEC:
        return [], None, None
    clips = [_normalize_loudness(concat_segments(audio, chunk)) for chunk in build_chunks(segments)]
    emotion2vec = models.get("emotion2vec")
    classifier = models.get("tone_classifier")
    outputs = [
        emotion2vec.generate(input=clip, granularity="utterance", extract_embedding=classifier is not None,
                             disable_pbar=True)[0]
        for clip in clips
    ]  # fmt: skip
    native = [_native_scores(o) for o in outputs]
    probs = None
    if classifier is not None:
        proba = classifier.predict_proba(np.stack([o["feats"] for o in outputs]))
        probs = [_classifier_probs(row, list(classifier.classes_)) for row in proba]

    end = None
    if aggregate_tone(_chunk_probs(native, probs))[0] == "neutral":
        large = models.get("emotion2vec_large")
        if large is not None:
            end = _native_scores(large.generate(input=clips[-1], granularity="utterance", disable_pbar=True)[0])
        if not config.EMOTION2VEC_LARGE_KEEP_LOADED:
            models.release("emotion2vec_large")
    return native, probs, end


def _chunk_probs(native: list[dict[str, float]], classifier_probs: list[dict[str, float]] | None) -> list[dict[str, float]]:
    return classifier_probs or [baseline_tone_probs(list(n), list(n.values())) for n in native]


def _margin(probs: dict[str, float], tone: str) -> float:
    others = [p for t, p in probs.items() if t != tone]
    return probs[tone] - max(others)


def _intensity(margin: float) -> str:
    if margin >= config.INTENSITY_HIGH_MARGIN:
        return "high"
    if margin >= config.INTENSITY_MEDIUM_MARGIN:
        return "medium"
    return "low"


def aggregate_tone(chunk_probs: list[dict[str, float]]) -> tuple[str, str, float]:
    """Highest summed probability, promoting a non-neutral tone that tops 2+ chunks."""
    sums = {t: sum(cp[t] for cp in chunk_probs) for t in TONES}
    tops = [max(cp, key=cp.get) for cp in chunk_probs]
    tone = max(TONES, key=sums.get)
    if tone == "neutral":
        sustained = [t for t in TONES if t != "neutral" and tops.count(t) >= config.TONE_SUSTAINED_MIN_CHUNKS]
        if sustained:
            tone = max(sustained, key=sums.get)

    winning = [cp for cp, top in zip(chunk_probs, tops) if top == tone]
    probability = float(np.mean([cp[tone] for cp in winning])) if winning else sums[tone] / len(chunk_probs)
    if tone == "neutral":
        return tone, config.NEUTRAL_INTENSITY, probability
    if not winning:
        return tone, "low", probability
    return tone, _intensity(max(_margin(cp, tone) for cp in winning)), probability


def end_happy(end_scores: dict[str, float]) -> float:
    """emotion2vec_plus_large's "happy" share for the last chunk, with "<unk>" left out."""
    by_name = {label.split("/")[-1]: score for label, score in end_scores.items()}
    known = sum(score for name, score in by_name.items() if name != "<unk>")
    return by_name.get("happy", 0.0) / known if known > 0 else 0.0


def decide_tone(
    native: list[dict[str, float]],
    classifier_probs: list[dict[str, float]] | None,
    end_scores: dict[str, float] | None = None,
) -> ToneResult:
    chunk_probs = _chunk_probs(native, classifier_probs)
    if not chunk_probs:
        return ToneResult("neutral", "low", config.NO_SPEECH_CONFIDENCE)
    result = ToneResult(*aggregate_tone(chunk_probs))
    # A neutral call that ends clearly happy (per the larger model) is satisfied; intensity is kept.
    if result.tone == "neutral" and end_scores and end_happy(end_scores) >= config.END_SATISFIED_HAPPY_MIN:
        return ToneResult("satisfied", result.intensity, end_happy(end_scores))
    return result
