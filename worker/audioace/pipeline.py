"""analyze(path) = decide(measure(path)).

measure() runs the models on the audio and returns Signals: plain numbers and intervals.
decide() turns Signals into the schema result using only config thresholds, so it runs
without audio or models (tests/fixtures holds recorded Signals for the sample calls).
"""

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, TypeVar

import numpy as np
from pydantic import BaseModel

from . import config, features, preprocess, tone
from .features import Interval
from .preprocess import DecodedAudio
from .schema import FailedResult, Result

T = TypeVar("T")


class StageError(RuntimeError):
    pass


@dataclass
class RunStats:
    """Timings of the most recent analyze() call, read by the Lambda adapter for its metrics."""

    stage_seconds: dict[str, float] = field(default_factory=dict)
    audio_duration_sec: float | None = None


last_run = RunStats()


def _run_stage(name: str, fn: Callable[[], T]) -> T:
    started = time.perf_counter()
    try:
        return fn()
    except Exception as exc:
        raise StageError(f"{name} failed: {type(exc).__name__}: {exc}") from exc
    finally:
        last_run.stage_seconds[name] = round(time.perf_counter() - started, 3)


class Signals(BaseModel):
    """Everything the models measured on one file; the only input decide() needs."""

    is_stereo: bool
    speech: list[list[Interval]]  # VAD speech per channel
    longest_silence_sec: float
    overlap_sec: float
    quality: list[features.QualitySignals]  # per channel
    bak: list[float | None]  # DNSMOS background score per channel
    noise_event_type: str | None
    noise_event_score: float
    noisy_gaps: list[tuple[int, Interval]]
    tv_score: float
    tv_active: list[Interval]
    static_rate: float
    # Why the AST sound-event and TV checks were not run (their result could not matter), or None
    ast_skipped: str | None = None
    emotion_scores: list[dict[str, float]]  # emotion2vec native scores per customer chunk
    tone_classifier_probs: list[dict[str, float]] | None = None
    # emotion2vec_plus_large native scores for the last customer chunk (None if not installed)
    end_emotion_scores: dict[str, float] | None = None


def analyze(path: str | Path) -> dict[str, Any]:
    """Return the Result or FailedResult as a dict. Never raises."""
    global last_run
    last_run = RunStats()
    try:
        return decide(measure(Path(path)))
    except StageError as exc:
        return FailedResult(error=str(exc)).model_dump()


def _customer_speech(audio: DecodedAudio, speech: list[list[Interval]]) -> tuple[np.ndarray, list[Interval]]:
    if audio.is_stereo:
        channel = config.CUSTOMER_CHANNEL
        if channel >= len(audio.channels):
            raise ValueError(f"CUSTOMER_CHANNEL={channel} but the file has {len(audio.channels)} channels")
        return audio.channels[channel], speech[channel]
    return audio.channels[0], features.diarize_customer(audio.channels[0])


def _overlap_seconds(audio: DecodedAudio, speech: list[list[Interval]]) -> float:
    if audio.is_stereo:
        return features.intersection_seconds(speech[0], speech[1])
    return features.mono_overlap_seconds(audio.channels[0])


def _quality_signals(
    audio: DecodedAudio, speech: list[list[Interval]], dnsmos: list[features.Dnsmos | None]
) -> list[features.QualitySignals]:
    return [
        features.QualitySignals(
            sig=scores.sig if scores else None,
            ovrl=scores.ovrl if scores else None,
            clip_ratio=features.clip_ratio(channel),
            speech_rms_dbfs=features.speech_rms_dbfs(channel, segments),
        )
        for channel, segments, scores in zip(audio.channels, speech, dnsmos)
    ]


def _background_noise(
    static_rate: float,
    events: features.SoundEvents,
    tv: features.TelevisionActivity,
    speech: list[list[Interval]],
    bak: float | None,
) -> features.NoiseDecision:
    """First match wins: sharp static, then sound events in the gaps, then TV under speech."""
    static = features.decide_static(static_rate)
    if static is not None:
        return static
    gap_noise = features.decide_background_noise(
        events.noise_type, events.score, bak, features.noise_speech_overlap_fraction(speech, events.noisy_gaps)
    )
    if gap_noise.present:
        return gap_noise
    return features.decide_background_noise(
        "TV", tv.score, bak, features.speech_fraction_inside(speech, tv.active), event_min=config.TV_EVENT_MIN
    )


def _ast_skip_reason(static_rate: float, baks: list[float | None]) -> str | None:
    """Why AST can't change the noise result, or None when it has to run.

    Sharp static is decided first and wins; every other noise type needs the lowest DNSMOS BAK
    below BAK_NOISE_MAX (see _background_noise and features.decide_background_noise).
    """
    if features.decide_static(static_rate) is not None:
        return "sharp static detected"
    known = [b for b in baks if b is not None]
    if not known:
        return "no DNSMOS background score"
    if min(known) >= config.BAK_NOISE_MAX:
        return f"DNSMOS BAK {min(known):.2f} >= BAK_NOISE_MAX {config.BAK_NOISE_MAX}"
    return None


def _confidence(tone_probability: float, customer_channel_uncertain: bool) -> float:
    # TODO: replace with calibrated model
    penalty = config.UNCERTAIN_CHANNEL_PENALTY if customer_channel_uncertain else 0.0
    return round(min(max(tone_probability - penalty, 0.0), 1.0), 3)


def measure(path: Path) -> Signals:
    """Run every model on the file. Raises StageError naming the stage that failed."""
    audio = _run_stage("decode", lambda: preprocess.decode(path))
    last_run.audio_duration_sec = round(audio.duration_sec, 3)

    speech = _run_stage("vad", lambda: [features.vad_segments(ch) for ch in audio.channels])
    customer_audio, customer_speech = _run_stage("customer", lambda: _customer_speech(audio, speech))

    longest_gap = _run_stage(
        "silence", lambda: features.longest_silence(audio.channels, speech, config.LONG_SILENCE_INCLUDE_EDGES)
    )
    overlap_sec = _run_stage("overlap", lambda: _overlap_seconds(audio, speech))

    dnsmos = _run_stage("dnsmos", lambda: [features.dnsmos(ch, sp) for ch, sp in zip(audio.channels, speech)])
    quality = _run_stage("quality", lambda: _quality_signals(audio, speech, dnsmos))

    static_rate = _run_stage("static", lambda: features.static_burst_rate(preprocess.decode_fullband(path)))
    # AST is the slowest check; skip it when static or a clean BAK already decides the noise result
    ast_skipped = _ast_skip_reason(static_rate, [d.bak if d else None for d in dnsmos])
    if ast_skipped:
        events, tv = features.SoundEvents(None, 0.0, frozenset()), features.TelevisionActivity(0.0, [])
    else:
        events = _run_stage("sound_events", lambda: features.sound_events(audio.channels, speech, audio.duration_sec))
        tv = _run_stage("television", lambda: features.television_activity(audio.channels, audio.duration_sec))

    emotions, classifier_probs, end_emotions = _run_stage(
        "tone", lambda: tone.measure_emotions(customer_audio, customer_speech)
    )

    return Signals(
        is_stereo=audio.is_stereo,
        speech=speech,
        longest_silence_sec=longest_gap,
        overlap_sec=overlap_sec,
        quality=quality,
        bak=[d.bak if d else None for d in dnsmos],
        noise_event_type=events.noise_type,
        noise_event_score=events.score,
        noisy_gaps=sorted(events.noisy_gaps),
        tv_score=tv.score,
        tv_active=tv.active,
        static_rate=static_rate,
        ast_skipped=ast_skipped,
        emotion_scores=emotions,
        tone_classifier_probs=classifier_probs,
        end_emotion_scores=end_emotions,
    )


def decide(s: Signals) -> dict[str, Any]:
    """Apply the config thresholds to measured Signals. Needs no audio and no models."""
    quality = features.worst_quality([features.decide_audio_quality(q) for q in s.quality])

    events = features.SoundEvents(s.noise_event_type, s.noise_event_score, frozenset(s.noisy_gaps))
    tv = features.TelevisionActivity(s.tv_score, s.tv_active)
    baks = [b for b in s.bak if b is not None]
    noise = _background_noise(s.static_rate, events, tv, s.speech, min(baks) if baks else None)

    tone_result = tone.decide_tone(s.emotion_scores, s.tone_classifier_probs, s.end_emotion_scores)

    result = _run_stage(
        "validate",
        lambda: Result(
            emotional_tone=tone_result.tone,
            emotional_intensity=tone_result.intensity,
            background_noise_present=noise.present,
            background_noise_type=noise.type,
            background_noise_severity=noise.severity,
            audio_quality=quality,
            speaker_overlap_present=s.overlap_sec > config.OVERLAP_SEC,
            long_silence_present=s.longest_silence_sec > config.LONG_SILENCE_SEC,
            confidence=_confidence(tone_result.probability, customer_channel_uncertain=not s.is_stereo),
        ),
    )
    return result.model_dump()
