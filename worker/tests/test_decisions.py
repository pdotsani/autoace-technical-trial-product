"""Pure decision logic: noise/quality separation, label mapping, intervals, tone aggregation."""

import dataclasses

import numpy as np
import pytest

from audioace import config, features, pipeline, tone
from audioace.features import NO_NOISE, QualitySignals, decide_audio_quality, decide_background_noise

CLEAN = QualitySignals(sig=3.8, ovrl=3.4, clip_ratio=0.0, speech_rms_dbfs=-22.0)


# --- noise vs quality consistency -------------------------------------------------------------
def test_quality_decision_never_sees_background_score() -> None:
    assert "bak" not in {f.name for f in dataclasses.fields(QualitySignals)}


def test_poor_quality_alone_is_not_background_noise() -> None:
    bad = QualitySignals(sig=1.5, ovrl=1.4, clip_ratio=0.05, speech_rms_dbfs=-55.0)
    assert decide_audio_quality(bad) == "severely_impaired"
    # Low BAK from a degraded signal, but no sound event -> no background noise
    assert decide_background_noise(None, 0.0, bak=1.5, speech_overlap_fraction=0.0) == NO_NOISE
    assert decide_background_noise("music", config.NOISE_EVENT_MIN / 2, bak=1.5, speech_overlap_fraction=0.9) == NO_NOISE


def test_sound_event_with_clean_background_is_not_noise() -> None:
    assert decide_background_noise("music", 0.9, bak=4.2, speech_overlap_fraction=0.9) == NO_NOISE
    assert decide_background_noise("music", 0.9, bak=None, speech_overlap_fraction=0.9) == NO_NOISE


def test_noise_present_has_type_and_severity() -> None:
    decision = decide_background_noise("office chatter", 0.8, bak=2.9, speech_overlap_fraction=0.3)
    assert decision.present and decision.type == "office chatter" and decision.severity == "medium"


def test_noise_severity_bumps_with_speech_overlap() -> None:
    low_overlap = decide_background_noise("wind", 0.8, bak=2.9, speech_overlap_fraction=0.0)
    high_overlap = decide_background_noise("wind", 0.8, bak=2.9, speech_overlap_fraction=0.9)
    assert (low_overlap.severity, high_overlap.severity) == ("low", "high")


def test_clean_signals_are_clear_and_degradations_escalate() -> None:
    assert decide_audio_quality(CLEAN) == "clear"
    assert decide_audio_quality(dataclasses.replace(CLEAN, sig=config.SIG_CLEAR_MIN - 0.1)) == "slightly_impaired"
    assert decide_audio_quality(dataclasses.replace(CLEAN, clip_ratio=0.05)) == "severely_impaired"
    assert decide_audio_quality(dataclasses.replace(CLEAN, speech_rms_dbfs=-42.0)) == "slightly_impaired"
    assert features.worst_quality(["clear", "severely_impaired", "slightly_impaired"]) == "severely_impaired"


@pytest.mark.parametrize(
    ("label", "expected"),
    [
        ("Speech", None),
        ("Static", None),
        ("White noise", None),
        ("Computer keyboard", "keyboard typing"),
        ("Keyboard (musical)", "music"),
        ("Wind instrument, woodwind instrument", "music"),
        ("Wind", "wind"),
        ("Wind chime", "other"),
        ("Television", "TV"),
        ("Traffic noise, roadway noise", "road noise"),
        ("Motor vehicle (road)", "road noise"),
        ("Hubbub, speech noise, speech babble", "office chatter"),
        ("Mechanical fan", "mechanical noise"),
        ("Dog", "other"),
    ],
)
def test_label_category(label: str, expected: str | None) -> None:
    assert features.label_category(label) == expected


def _events(noise_type: str | None = None, score: float = 0.0) -> features.SoundEvents:
    return features.SoundEvents(noise_type=noise_type, score=score, noisy_gaps=frozenset())


SPEECH = [[(0.0, 10.0), (20.0, 30.0)]]


def test_tv_under_speech_is_reported_when_gaps_show_nothing() -> None:
    tv = features.TelevisionActivity(score=0.16, active=[(20.0, 30.0)])
    noise = pipeline._background_noise(0.0, _events("other", 0.13), tv, SPEECH, bak=3.4)
    assert (noise.present, noise.type) == (True, "TV")


def test_tv_needs_low_background_score_and_enough_evidence() -> None:
    tv = features.TelevisionActivity(score=0.16, active=[(20.0, 30.0)])
    assert pipeline._background_noise(0.0, _events(), tv, SPEECH, bak=4.0) == NO_NOISE
    weak_tv = features.TelevisionActivity(score=0.01, active=[])
    assert pipeline._background_noise(0.0, _events(), weak_tv, SPEECH, bak=3.0) == NO_NOISE


def test_gap_event_takes_precedence_over_tv() -> None:
    tv = features.TelevisionActivity(score=0.5, active=[(0.0, 30.0)])
    assert pipeline._background_noise(0.0, _events("music", 0.8), tv, SPEECH, bak=3.0).type == "music"


def test_speech_fraction_inside_and_windows() -> None:
    assert features.speech_fraction_inside(SPEECH, [(5.0, 25.0)]) == pytest.approx(0.5)
    assert features._windows(25.0, 10.0, 5.0) == [(0.0, 10.0), (5.0, 15.0), (10.0, 20.0), (15.0, 25.0)]
    assert features._windows(4.0, 10.0, 5.0) == [(0.0, 4.0)]


def _fullband(seconds: float, bursts_per_sec: float) -> np.ndarray:
    sr = config.STATIC_SAMPLE_RATE
    rng = np.random.default_rng(0)
    t = np.arange(int(seconds * sr)) / sr
    audio = 0.1 * np.sin(2 * np.pi * 300 * t) + 1e-4 * rng.standard_normal(t.size)
    if bursts_per_sec:
        for start in np.arange(0.5, seconds, 1 / bursts_per_sec):
            i = int(start * sr)
            audio[i : i + 240] += 0.3 * rng.standard_normal(240)  # 5 ms broadband click
    return audio.astype(np.float32)


def test_static_burst_rate_counts_short_broadband_clicks() -> None:
    assert features.static_burst_rate(_fullband(10, 0)) == pytest.approx(0.0, abs=0.05)
    assert features.static_burst_rate(_fullband(10, 1.0)) == pytest.approx(1.0, abs=0.15)


@pytest.mark.parametrize(("rate", "severity"), [(0.1, None), (0.4, "low"), (0.9, "medium"), (3.0, "high")])
def test_static_severity_bands(rate: float, severity: str | None) -> None:
    decision = features.decide_static(rate)
    assert (decision.severity if decision else None) == severity
    if decision:
        assert (decision.present, decision.type) == (True, "sharp static")


def test_static_wins_over_other_noise_and_ignores_bak() -> None:
    tv = features.TelevisionActivity(score=0.5, active=[(0.0, 30.0)])
    noise = pipeline._background_noise(0.9, _events("music", 0.8), tv, SPEECH, bak=4.2)
    assert (noise.type, noise.severity) == ("sharp static", "medium")


# --- intervals --------------------------------------------------------------------------------
def test_longest_silence_uses_all_channels() -> None:
    agent = [(0.0, 2.0), (9.0, 10.0)]
    customer = [(4.0, 6.0)]
    quiet = np.zeros(12 * config.SAMPLE_RATE, dtype=np.float32)
    assert features.longest_silence([quiet], [agent], include_edges=False) == pytest.approx(7.0)
    assert features.longest_silence([quiet, quiet], [agent, customer], include_edges=False) == pytest.approx(3.0)
    assert features.longest_silence([quiet, quiet], [agent, customer], include_edges=True) == pytest.approx(3.0)
    assert features.longest_silence([quiet[: 8 * config.SAMPLE_RATE]], [[]], include_edges=False) == pytest.approx(8.0)


def test_loud_non_speech_is_not_silence() -> None:
    audio = np.zeros(12 * config.SAMPLE_RATE, dtype=np.float32)
    audio[4 * config.SAMPLE_RATE : 6 * config.SAMPLE_RATE] = 0.1  # -20 dBFS, missed by VAD
    assert features.longest_silence([audio], [[(0.0, 2.0), (9.0, 10.0)]], include_edges=False) == pytest.approx(3.0)


def test_intersection_and_complement() -> None:
    assert features.intersection_seconds([(0, 3), (5, 8)], [(2, 6)]) == pytest.approx(2.0)
    assert features.complement([(1, 2), (1.5, 3)], 5.0) == [(0.0, 1), (3, 5.0)]


def test_noise_overlap_fraction_counts_speech_next_to_noisy_gaps() -> None:
    speech = [[(1.0, 3.0), (5.0, 9.0)]]
    noisy = frozenset({(0, (3.0, 5.0))})
    assert features.noise_speech_overlap_fraction(speech, noisy) == pytest.approx(1.0)
    noisy_edge = frozenset({(0, (0.0, 1.0))})
    assert features.noise_speech_overlap_fraction(speech, noisy_edge) == pytest.approx(2 / 6)


# --- tone -------------------------------------------------------------------------------------
def _probs(**kwargs: float) -> dict[str, float]:
    return {t: kwargs.get(t, 0.0) for t in tone.TONES}


def test_baseline_mapping_splits_angry_by_probability() -> None:
    labels = ["生气/angry", "中立/neutral", "开心/happy", "恐惧/fearful"]
    strong = tone.baseline_tone_probs(labels, [0.8, 0.1, 0.05, 0.05])
    weak = tone.baseline_tone_probs(labels, [0.4, 0.5, 0.05, 0.05])
    assert max(strong, key=strong.get) == "upset"
    assert weak["frustrated"] == pytest.approx(0.4) and weak["upset"] == 0.0
    assert sum(strong.values()) == pytest.approx(1.0)


def test_baseline_maps_sad_to_upset_and_fear_to_distressed() -> None:
    sad = tone.baseline_tone_probs(["难过/sad", "中立/neutral"], [0.9, 0.1])
    fearful = tone.baseline_tone_probs(["恐惧/fearful", "中立/neutral"], [0.9, 0.1])
    assert max(sad, key=sad.get) == "upset" and sad["distressed"] == 0.0
    assert max(fearful, key=fearful.get) == "distressed"


def test_sustained_non_neutral_tone_is_promoted_over_neutral_sum() -> None:
    chunks = [
        _probs(neutral=0.9, frustrated=0.1),
        _probs(neutral=0.9, frustrated=0.1),
        _probs(neutral=0.9, frustrated=0.1),
        _probs(neutral=0.4, frustrated=0.6),
        _probs(neutral=0.3, frustrated=0.7),
    ]
    tone_, intensity, probability = tone.aggregate_tone(chunks)
    assert tone_ == "frustrated"
    assert probability == pytest.approx(0.65)
    assert intensity == "medium"  # strongest sustained margin 0.4


@pytest.mark.parametrize(("top", "expected"), [(0.52, "low"), (0.575, "medium"), (0.8, "high")])
def test_intensity_bands_from_margin(top: float, expected: str) -> None:
    chunks = [_probs(frustrated=top, neutral=1 - top)] * 2
    assert tone.aggregate_tone(chunks)[:2] == ("frustrated", expected)


def test_single_non_neutral_chunk_is_not_promoted() -> None:
    chunks = [_probs(neutral=0.9, upset=0.1), _probs(neutral=0.2, upset=0.8)]
    assert tone.aggregate_tone(chunks)[:2] == ("neutral", config.NEUTRAL_INTENSITY)


def test_neutral_tone_uses_configured_intensity() -> None:
    chunks = [_probs(neutral=0.98, satisfied=0.02)] * 3
    assert tone.aggregate_tone(chunks)[:2] == ("neutral", "medium")


def test_build_chunks_respects_bounds() -> None:
    segments = [(0.0, 1.0), (2.0, 3.5), (5.0, 70.0)]
    chunks = tone.build_chunks(segments)
    lengths = [features.total_seconds(c) for c in chunks]
    assert all(config.TONE_CHUNK_MIN_SEC <= n <= config.TONE_CHUNK_MAX_SEC for n in lengths)
    assert sum(lengths) == pytest.approx(67.5)


def _chunk(channel: int, start: float, end: float) -> features.GapChunk:
    return features.GapChunk(channel, (start, end), (start, end))


def test_gap_chunks_are_packed_into_clips_of_at_most_ast_chunk_sec() -> None:
    chunks = [_chunk(0, 0, 3), _chunk(0, 5, 9), _chunk(0, 12, 15), _chunk(0, 20, 21), _chunk(1, 2, 4)]
    groups = features.pack_gap_chunks(chunks)
    # 3 + 4 + 3 s = 10 s fills a clip, the next 1 s starts a new one, another channel always does
    assert [[c.span for c in g] for g in groups] == [[(0, 3), (5, 9), (12, 15)], [(20, 21)], [(2, 4)]]
    assert all(sum(c.span[1] - c.span[0] for c in g) <= config.AST_CHUNK_SEC for g in groups)
    assert features.pack_gap_chunks([]) == []


def test_ast_is_skipped_only_when_it_cannot_change_the_noise_result() -> None:
    _ast_skip_reason = pipeline._ast_skip_reason
    static = config.STATIC_RATE_MIN + 0.1
    clean = config.BAK_NOISE_MAX
    assert _ast_skip_reason(static, [2.0]) == "sharp static detected"
    assert _ast_skip_reason(0.0, [clean, clean + 0.5]).startswith("DNSMOS BAK")
    assert _ast_skip_reason(0.0, [None]) == "no DNSMOS background score"
    assert _ast_skip_reason(0.0, [clean, clean - 0.1]) is None  # one channel may be noisy
    # every skip reason is a case where the decision is "no noise" or static, whatever AST says
    assert features.decide_background_noise("TV", 0.99, clean, 1.0) == features.NO_NOISE
    assert features.decide_background_noise("TV", 0.99, None, 1.0) == features.NO_NOISE
