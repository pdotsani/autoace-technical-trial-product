import json

import jsonschema
import pytest
from pydantic import ValidationError

from audioace import config
from audioace.schema import FailedResult, Result

VALID = {
    "emotional_tone": "frustrated",
    "emotional_intensity": "medium",
    "background_noise_present": True,
    "background_noise_type": "office chatter",
    "background_noise_severity": "low",
    "audio_quality": "clear",
    "speaker_overlap_present": False,
    "long_silence_present": True,
    "confidence": 0.72,
}


@pytest.fixture(scope="module")
def json_schema() -> dict:
    return json.loads(config.RESULT_SCHEMA_PATH.read_text())


def test_pydantic_model_matches_shared_json_schema(json_schema: dict) -> None:
    model_schema = Result.model_json_schema()
    assert set(model_schema["properties"]) == set(json_schema["properties"])
    assert set(model_schema["required"]) == set(json_schema["required"])
    assert json_schema.get("additionalProperties") is False
    assert model_schema.get("additionalProperties") is False
    for name, expected in json_schema["properties"].items():
        actual = model_schema["properties"][name]
        for key in ("type", "enum", "minimum", "maximum"):
            assert actual.get(key) == expected.get(key), f"{name}.{key}"


def test_valid_result_passes_both_schemas(json_schema: dict) -> None:
    jsonschema.validate(Result(**VALID).model_dump(), json_schema)


@pytest.mark.parametrize(
    "override",
    [
        {"background_noise_present": False, "background_noise_type": "music", "background_noise_severity": "none"},
        {"background_noise_present": False, "background_noise_type": "", "background_noise_severity": "low"},
    ],
)
def test_no_noise_requires_empty_type_and_none_severity(override: dict) -> None:
    with pytest.raises(ValidationError):
        Result(**{**VALID, **override})


def test_no_noise_with_empty_fields_is_valid() -> None:
    Result(**{**VALID, "background_noise_present": False, "background_noise_type": "", "background_noise_severity": "none"})


@pytest.mark.parametrize("override", [{"emotional_tone": "angry"}, {"confidence": 1.5}, {"extra": 1}])
def test_rejects_out_of_schema_values(override: dict) -> None:
    with pytest.raises(ValidationError):
        Result(**{**VALID, **override})


def test_failed_result_shape() -> None:
    assert FailedResult(error="boom").model_dump() == {"status": "failed", "error": "boom"}
