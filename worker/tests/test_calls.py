"""Regression tests: the three labelled sample calls must produce their expected results.

These run decide() on Signals recorded from the calls (tests/fixtures), so they need neither
the audio files nor the models. After changing the measuring step, re-record with
scripts/record_signals.py.
"""

import json
from pathlib import Path

import jsonschema
import pytest

from audioace import config, pipeline

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"

EXPECTED = {
    "call_001.ogg": {
        "emotional_tone": "upset",
        "emotional_intensity": "high",
        "background_noise_present": False,
        "background_noise_type": "",
        "background_noise_severity": "none",
        "audio_quality": "clear",
        "speaker_overlap_present": False,
        "long_silence_present": False,
    },
    "call_002.ogg": {
        "emotional_tone": "neutral",
        "emotional_intensity": "medium",
        "background_noise_present": True,
        "background_noise_type": "TV",
        "background_noise_severity": "medium",
        "audio_quality": "clear",
        "speaker_overlap_present": True,
        "long_silence_present": False,
    },
    "call_003.ogg": {
        # The base model hears neutral throughout; emotion2vec_plus_large scores the last
        # chunk happy 0.985 (END_SATISFIED_HAPPY_MIN), which makes it satisfied.
        "emotional_tone": "satisfied",
        "emotional_intensity": "medium",
        "background_noise_present": True,
        "background_noise_type": "sharp static",
        "background_noise_severity": "medium",
        "audio_quality": "clear",
        "speaker_overlap_present": True,
        "long_silence_present": False,
    },
}


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_call_matches_expected_result(name: str) -> None:
    signals = pipeline.Signals.model_validate_json((FIXTURES_DIR / f"{name}.signals.json").read_text())

    result = pipeline.decide(signals)

    jsonschema.validate(result, json.loads(config.RESULT_SCHEMA_PATH.read_text()))
    assert 0.0 <= result.pop("confidence") <= 1.0
    assert result == EXPECTED[name]
