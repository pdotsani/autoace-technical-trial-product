"""Signal features: VAD, silence, overlap, diarization, DNSMOS, signal checks, sound events.

Audio-quality and background-noise decisions are kept separate on purpose:
quality never looks at DNSMOS BAK, and noise needs a detected sound event, so poor
audio alone can never produce a background-noise verdict.
"""

import math
import re
from dataclasses import dataclass

import numpy as np
import torch
from silero_vad import get_speech_timestamps

from . import config, models
from .preprocess import rms_dbfs

Interval = tuple[float, float]
SR = config.SAMPLE_RATE

QUALITY_LEVELS = ("clear", "slightly_impaired", "severely_impaired")
SEVERITY_LEVELS = ("low", "medium", "high")


# --- Interval helpers --------------------------------------------------------------------
def merge_intervals(intervals: list[Interval]) -> list[Interval]:
    merged: list[Interval] = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def complement(intervals: list[Interval], duration: float) -> list[Interval]:
    gaps: list[Interval] = []
    cursor = 0.0
    for start, end in merge_intervals(intervals):
        if start > cursor:
            gaps.append((cursor, start))
        cursor = max(cursor, end)
    if cursor < duration:
        gaps.append((cursor, duration))
    return gaps


def total_seconds(intervals: list[Interval]) -> float:
    return sum(end - start for start, end in intervals)


def intersection_seconds(a: list[Interval], b: list[Interval]) -> float:
    a, b = merge_intervals(a), merge_intervals(b)
    total, i, j = 0.0, 0, 0
    while i < len(a) and j < len(b):
        overlap = min(a[i][1], b[j][1]) - max(a[i][0], b[j][0])
        if overlap > 0:
            total += overlap
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return total


def split_interval(interval: Interval, max_len: float) -> list[Interval]:
    start, end = interval
    pieces = max(1, math.ceil((end - start) / max_len))
    step = (end - start) / pieces
    return [(start + k * step, start + (k + 1) * step) for k in range(pieces)]


def slice_audio(audio: np.ndarray, interval: Interval) -> np.ndarray:
    return audio[int(interval[0] * SR) : int(interval[1] * SR)]


def concat_segments(audio: np.ndarray, intervals: list[Interval], pad: float = 0.0) -> np.ndarray:
    duration = len(audio) / SR
    padded = merge_intervals([(max(0.0, s - pad), min(duration, e + pad)) for s, e in intervals])
    parts = [slice_audio(audio, iv) for iv in padded]
    return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)


# --- VAD, silence, overlap, diarization -----------------------------------------------------
def vad_segments(audio: np.ndarray) -> list[Interval]:
    stamps = get_speech_timestamps(
        torch.from_numpy(audio),
        models.get("vad"),
        sampling_rate=SR,
        threshold=config.VAD_THRESHOLD,
        min_speech_duration_ms=config.VAD_MIN_SPEECH_MS,
        min_silence_duration_ms=config.VAD_MIN_SILENCE_MS,
        return_seconds=True,
    )
    return merge_intervals([(float(s["start"]), float(s["end"])) for s in stamps])


def _frame_dbfs(audio: np.ndarray, frame: int) -> np.ndarray:
    frames = audio[: len(audio) // frame * frame].reshape(-1, frame).astype(np.float64)
    return 20.0 * np.log10(np.maximum(np.sqrt(np.mean(np.square(frames), axis=1)), 1e-10))


def _longest_run(mask: np.ndarray) -> int:
    best = run = 0
    for value in mask:
        run = run + 1 if value else 0
        best = max(best, run)
    return best


def longest_silence(
    channels: list[np.ndarray], speech_by_channel: list[list[Interval]], include_edges: bool
) -> float:
    """Longest stretch with no speech on ANY channel and every channel below SILENCE_MAX_DBFS."""
    frame = int(config.SILENCE_FRAME_SEC * SR)
    count = len(channels[0]) // frame
    centers = (np.arange(count) + 0.5) * config.SILENCE_FRAME_SEC

    silent = np.ones(count, dtype=bool)
    for audio in channels:
        silent &= _frame_dbfs(audio, frame)[:count] < config.SILENCE_MAX_DBFS
    speech = merge_intervals([iv for channel in speech_by_channel for iv in channel])
    for start, end in speech:
        silent &= ~((centers >= start) & (centers < end))
    if speech and not include_edges:
        silent &= (centers > speech[0][0]) & (centers < speech[-1][1])
    return _longest_run(silent) * config.SILENCE_FRAME_SEC


def mono_overlap_seconds(audio: np.ndarray) -> float:
    scores = models.get("overlap")({"waveform": torch.from_numpy(audio)[None], "sample_rate": SR})
    second_speaker = np.asarray(scores.data).reshape(len(scores.data), -1)[:, 0]
    return float((second_speaker > config.OVERLAP_ONSET).sum() * scores.sliding_window.step)


def diarize_customer(audio: np.ndarray) -> list[Interval]:
    """Customer = the speaker who does NOT speak first (most talk time among the rest)."""
    output = models.get("diarization")({"waveform": torch.from_numpy(audio)[None], "sample_rate": SR})
    annotation = getattr(output, "speaker_diarization", output)  # pyannote 4 wraps the annotation
    speech: dict[str, list[Interval]] = {}
    for segment, _, speaker in annotation.itertracks(yield_label=True):
        speech.setdefault(speaker, []).append((float(segment.start), float(segment.end)))
    if not speech:
        return []
    by_first_turn = sorted(speech, key=lambda spk: min(start for start, _ in speech[spk]))
    candidates = by_first_turn[1:] or by_first_turn
    customer = max(candidates, key=lambda spk: total_seconds(speech[spk]))
    return merge_intervals(speech[customer])


# --- DNSMOS + audio quality -----------------------------------------------------------------
_DNSMOS_INPUT_SEC = 9.01
_POLY_SIG = np.poly1d([-0.08397278, 1.22083953, 0.0052439])
_POLY_BAK = np.poly1d([-0.13166888, 1.60915514, -0.39604546])
_POLY_OVRL = np.poly1d([-0.06766283, 1.11546468, 0.04602535])


@dataclass(frozen=True)
class Dnsmos:
    sig: float
    bak: float
    ovrl: float


def dnsmos(audio: np.ndarray, speech: list[Interval]) -> Dnsmos | None:
    """DNSMOS P.835 on the speech portion (whole channel if there is too little speech)."""
    clip = concat_segments(audio, speech, pad=0.25)
    if len(clip) < config.DNSMOS_MIN_SPEECH_SEC * SR:
        clip = audio
    if rms_dbfs(clip) < config.EMPTY_CHANNEL_DBFS:
        return None

    window = int(_DNSMOS_INPUT_SEC * SR)
    while len(clip) < window:  # same padding as the reference implementation
        clip = np.concatenate([clip, clip])
    hop = int(config.DNSMOS_HOP_SEC * SR)
    session = models.get("dnsmos")
    input_name = session.get_inputs()[0].name

    scores = []
    for start in range(0, len(clip) - window + 1, hop):
        segment = clip[start : start + window].astype(np.float32)[np.newaxis, :]
        sig, bak, ovrl = session.run(None, {input_name: segment})[0][0]
        scores.append((_POLY_SIG(sig), _POLY_BAK(bak), _POLY_OVRL(ovrl)))
    sig, bak, ovrl = np.mean(scores, axis=0)
    return Dnsmos(sig=float(sig), bak=float(bak), ovrl=float(ovrl))


@dataclass(frozen=True)
class QualitySignals:
    """Inputs to the audio-quality decision. Deliberately has no background (BAK) score."""

    sig: float | None
    ovrl: float | None
    clip_ratio: float
    speech_rms_dbfs: float | None


def clip_ratio(audio: np.ndarray) -> float:
    return float(np.mean(np.abs(audio) >= config.CLIP_LEVEL)) if audio.size else 0.0


def speech_rms_dbfs(audio: np.ndarray, speech: list[Interval]) -> float | None:
    clip = concat_segments(audio, speech)
    return rms_dbfs(clip) if clip.size else None


def decide_audio_quality(s: QualitySignals) -> str:
    severe = (
        (s.sig is not None and s.sig < config.SIG_SEVERE_MAX)
        or (s.ovrl is not None and s.ovrl < config.OVRL_SEVERE_MAX)
        or s.clip_ratio > config.CLIP_RATIO_SEVERE
        or (s.speech_rms_dbfs is not None and s.speech_rms_dbfs < config.SPEECH_RMS_SEVERE_DBFS)
    )
    if severe:
        return "severely_impaired"
    slight = (
        (s.sig is not None and s.sig < config.SIG_CLEAR_MIN)
        or (s.ovrl is not None and s.ovrl < config.OVRL_CLEAR_MIN)
        or s.clip_ratio > config.CLIP_RATIO_SLIGHT
        or (s.speech_rms_dbfs is not None and s.speech_rms_dbfs < config.SPEECH_RMS_SLIGHT_DBFS)
    )
    return "slightly_impaired" if slight else "clear"


def worst_quality(levels: list[str]) -> str:
    return max(levels, key=QUALITY_LEVELS.index, default="clear")


# --- Sound events + background noise ---------------------------------------------------------
# AudioSet labels that are never background noise: speech, silence, room tone, signal
# artifacts (those belong to audio quality), the speaker's own sounds and phone-line tones.
_IGNORED_LABELS = frozenset({
    "Speech", "Male speech, man speaking", "Female speech, woman speaking",
    "Child speech, kid speaking", "Conversation", "Narration, monologue", "Babbling",
    "Speech synthesizer", "Whispering", "Silence",
    "Inside, small room", "Inside, large room or hall", "Inside, public space",
    "Static", "White noise", "Pink noise", "Hum", "Mains hum", "Distortion", "Noise",
    "Echo", "Reverberation", "Sidetone",
    "Breathing", "Cough", "Sneeze", "Sniff", "Throat clearing", "Sigh", "Gasp",
    "Telephone", "Telephone dialing, DTMF", "Dial tone", "Busy signal",
})  # fmt: skip

# First match wins, so more specific patterns come first.
_NOISE_CATEGORIES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("other", (r"wind chime",)),
    ("TV", (r"\btelevision\b", r"\bradio\b")),
    ("music", (r"music", r"\binstrument\b", r"\bsinging\b", r"\bsong\b", r"\bguitar\b", r"\bpiano\b",
               r"\bdrum", r"\borchestra\b", r"\bchoir\b", r"\bjingle\b")),
    ("office chatter", (r"\bchatter\b", r"\bhubbub\b", r"\bbabble\b", r"\bcrowd\b")),
    ("keyboard typing", (r"\btyping\b", r"\bkeyboard\b", r"\btypewriter\b")),
    ("road noise", (r"\bvehicle\b", r"\bcar\b", r"\btraffic\b", r"\btruck\b", r"\bbus\b",
                    r"\bmotorcycle\b", r"\broad", r"\bhonking\b", r"\bsiren\b", r"\brevving\b")),
    ("wind", (r"\bwind\b",)),
    ("mechanical noise", (r"\bmechanical\b", r"\bmachine", r"\bengine\b", r"\bfan\b",
                          r"air conditioning", r"\bmechanisms\b", r"\bprinter\b", r"\bvacuum\b",
                          r"\bdrill\b", r"\bmotor\b", r"\bpower tool\b", r"\bblender\b")),
)  # fmt: skip
NOISE_TYPES = tuple(dict.fromkeys([name for name, _ in _NOISE_CATEGORIES] + ["other"]))


def label_category(label: str) -> str | None:
    """Map an AudioSet label to a short noise type; None if it is never background noise."""
    if label in _IGNORED_LABELS:
        return None
    lowered = label.lower()
    for name, patterns in _NOISE_CATEGORIES:
        if any(re.search(p, lowered) for p in patterns):
            return name
    return "other"


@dataclass(frozen=True)
class GapChunk:
    channel: int
    gap: Interval
    span: Interval


@dataclass(frozen=True)
class SoundEvents:
    noise_type: str | None
    score: float
    noisy_gaps: frozenset[tuple[int, Interval]]


def _gap_chunks(channels: list[np.ndarray], speech_by_channel: list[list[Interval]], duration: float) -> list[GapChunk]:
    chunks = []
    for channel, (audio, speech) in enumerate(zip(channels, speech_by_channel)):
        for gap in complement(speech, duration):
            if gap[1] - gap[0] < config.NOISE_MIN_GAP_SEC:
                continue
            for span in split_interval(gap, config.AST_CHUNK_SEC):
                if rms_dbfs(slice_audio(audio, span)) >= config.AST_SILENT_CHUNK_DBFS:
                    chunks.append(GapChunk(channel, gap, span))
    return chunks


def _ast_probabilities(clips: list[np.ndarray]) -> np.ndarray:
    extractor, model = models.get("ast")
    batches = []
    for i in range(0, len(clips), config.AST_BATCH_SIZE):
        inputs = extractor(clips[i : i + config.AST_BATCH_SIZE], sampling_rate=SR, return_tensors="pt")
        with torch.inference_mode():
            batches.append(torch.sigmoid(model(**inputs).logits).numpy())
    return np.concatenate(batches)


def sound_events(
    channels: list[np.ndarray], speech_by_channel: list[list[Interval]], duration: float
) -> SoundEvents:
    """Run the AudioSet classifier on non-speech gaps of every channel."""
    chunks = _gap_chunks(channels, speech_by_channel, duration)
    if not chunks:
        return SoundEvents(None, 0.0, frozenset())

    probs = _ast_probabilities([slice_audio(channels[c.channel], c.span) for c in chunks])
    _, model = models.get("ast")
    categories = [label_category(model.config.id2label[i]) for i in range(probs.shape[1])]

    type_scores = np.zeros((len(chunks), len(NOISE_TYPES)))
    for col, category in enumerate(categories):
        if category is not None:
            k = NOISE_TYPES.index(category)
            type_scores[:, k] = np.maximum(type_scores[:, k], probs[:, col])

    best = int(type_scores.max(axis=0).argmax())
    noisy = frozenset(
        (c.channel, c.gap) for c, row in zip(chunks, type_scores) if row[best] > config.NOISE_EVENT_MIN
    )
    return SoundEvents(noise_type=NOISE_TYPES[best], score=float(type_scores[:, best].max()), noisy_gaps=noisy)


def noise_speech_overlap_fraction(
    speech_by_channel: list[list[Interval]], noisy_gaps: frozenset[tuple[int, Interval]]
) -> float:
    """Fraction of speech time adjacent to a noisy gap, as a proxy for noise under speech."""
    speech_total = noisy_total = 0.0
    for channel, speech in enumerate(speech_by_channel):
        gaps = [gap for ch, gap in noisy_gaps if ch == channel]
        for start, end in speech:
            speech_total += end - start
            if any(math.isclose(g[1], start, abs_tol=1e-6) or math.isclose(g[0], end, abs_tol=1e-6) for g in gaps):
                noisy_total += end - start
    return noisy_total / speech_total if speech_total else 0.0


@dataclass(frozen=True)
class TelevisionActivity:
    score: float  # highest "Television" probability over any window
    active: list[Interval]  # windows scoring above TV_EVENT_MIN


def _windows(duration: float, length: float, hop: float) -> list[Interval]:
    starts = np.arange(0.0, max(duration - length, 0.0) + hop / 2, hop)
    return [(float(s), float(min(s + length, duration))) for s in starts]


def television_activity(channels: list[np.ndarray], duration: float) -> TelevisionActivity:
    """AST "Television" score over the whole call, speech included."""
    _, model = models.get("ast")
    tv_index = model.config.label2id["Television"]
    windows = _windows(duration, config.TV_WINDOW_SEC, config.TV_HOP_SEC)
    scores = np.concatenate(
        [_ast_probabilities([slice_audio(audio, w) for w in windows])[:, tv_index] for audio in channels]
    )
    spans = windows * len(channels)
    active = merge_intervals([w for w, s in zip(spans, scores) if s > config.TV_EVENT_MIN])
    return TelevisionActivity(score=float(scores.max()), active=active)


def speech_fraction_inside(speech_by_channel: list[list[Interval]], intervals: list[Interval]) -> float:
    speech_total = sum(total_seconds(speech) for speech in speech_by_channel)
    inside = sum(intersection_seconds(speech, intervals) for speech in speech_by_channel)
    return inside / speech_total if speech_total else 0.0


@dataclass(frozen=True)
class NoiseDecision:
    present: bool
    type: str
    severity: str


NO_NOISE = NoiseDecision(present=False, type="", severity="none")


STATIC_TYPE = "sharp static"


def static_burst_rate(fullband: np.ndarray) -> float:
    """Crackle bursts per second: 5 ms frames whose 14-20 kHz energy jumps STATIC_BURST_DB above normal."""
    sr = config.STATIC_SAMPLE_RATE
    frame = int(config.STATIC_FRAME_SEC * sr)
    count = len(fullband) // frame
    if count < 2:
        return 0.0
    frames = fullband[: count * frame].reshape(count, frame).astype(np.float64)
    power = np.abs(np.fft.rfft(frames * np.hanning(frame), axis=1)) ** 2
    freqs = np.fft.rfftfreq(frame, 1 / sr)
    low, high = config.STATIC_BAND_HZ
    band_db = 10 * np.log10(power[:, (freqs >= low) & (freqs < high)].sum(axis=1) + 1e-20)

    burst = (band_db > np.median(band_db) + config.STATIC_BURST_DB) & (band_db > config.STATIC_MIN_BAND_DB)
    onsets = int(np.sum(burst[1:] & ~burst[:-1]) + burst[0])
    return onsets / (len(fullband) / sr)


def decide_static(burst_rate: float) -> NoiseDecision | None:
    if burst_rate <= config.STATIC_RATE_MIN:
        return None
    if burst_rate >= config.STATIC_RATE_HIGH:
        severity = "high"
    elif burst_rate >= config.STATIC_RATE_MEDIUM:
        severity = "medium"
    else:
        severity = "low"
    return NoiseDecision(present=True, type=STATIC_TYPE, severity=severity)


def decide_background_noise(
    noise_type: str | None,
    event_score: float,
    bak: float | None,
    speech_overlap_fraction: float,
    event_min: float = config.NOISE_EVENT_MIN,
) -> NoiseDecision:
    """Noise needs BOTH a sound event and a low DNSMOS background score."""
    if noise_type is None or event_score <= event_min:
        return NO_NOISE
    if bak is None or bak >= config.BAK_NOISE_MAX:
        return NO_NOISE

    if bak < config.BAK_SEVERITY_HIGH_MAX:
        level = 2
    elif bak < config.BAK_SEVERITY_MEDIUM_MAX:
        level = 1
    else:
        level = 0
    if speech_overlap_fraction >= config.NOISE_OVERLAP_BUMP_UP:
        level += 1
    elif speech_overlap_fraction < config.NOISE_OVERLAP_BUMP_DOWN:
        level -= 1
    severity = SEVERITY_LEVELS[min(max(level, 0), len(SEVERITY_LEVELS) - 1)]
    return NoiseDecision(present=True, type=noise_type, severity=severity)
