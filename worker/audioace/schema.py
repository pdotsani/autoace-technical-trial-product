"""Pydantic models for the worker output (mirror of shared/schema/result.schema.json)."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

EmotionalTone = Literal["neutral", "satisfied", "frustrated", "upset", "distressed"]
EmotionalIntensity = Literal["low", "medium", "high"]
NoiseSeverity = Literal["none", "low", "medium", "high"]
AudioQuality = Literal["clear", "slightly_impaired", "severely_impaired"]


class Result(BaseModel):
    model_config = ConfigDict(extra="forbid", title="CallAudioAnalysis")

    emotional_tone: EmotionalTone = Field(description="The customer's tone")
    emotional_intensity: EmotionalIntensity
    background_noise_present: bool
    background_noise_type: str = Field(description="Short description; empty string when none")
    background_noise_severity: NoiseSeverity
    audio_quality: AudioQuality
    speaker_overlap_present: bool
    long_silence_present: bool
    confidence: float = Field(ge=0.0, le=1.0)

    @model_validator(mode="after")
    def _no_noise_means_no_type_or_severity(self) -> "Result":
        if not self.background_noise_present:
            if self.background_noise_type != "":
                raise ValueError("background_noise_type must be '' when background_noise_present is false")
            if self.background_noise_severity != "none":
                raise ValueError("background_noise_severity must be 'none' when background_noise_present is false")
        return self


class FailedResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["failed"] = "failed"
    error: str
