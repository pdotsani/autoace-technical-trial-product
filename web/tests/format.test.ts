import { describe, expect, it } from "vitest";

import { COMPARED_COLUMNS, countMatches, fieldMatches } from "../src/format";

const RESULT = {
  emotional_tone: "neutral",
  emotional_intensity: "medium",
  background_noise_present: true,
  background_noise_type: "television",
  background_noise_severity: "medium",
  audio_quality: "clear",
  speaker_overlap_present: false,
  long_silence_present: false,
  confidence: 0.9,
};

describe("comparing a result with its label", () => {
  it("compares every field except confidence", () => {
    expect(COMPARED_COLUMNS.map((c) => c.key)).not.toContain("confidence");
    expect(COMPARED_COLUMNS).toHaveLength(8);
    expect(countMatches(RESULT, { ...RESULT, confidence: 0.1 })).toBe(8);
  });

  it("needs enums and booleans to be equal", () => {
    expect(fieldMatches(RESULT, { ...RESULT, emotional_tone: "upset" }, "emotional_tone")).toBe(false);
    expect(fieldMatches(RESULT, { ...RESULT, long_silence_present: true }, "long_silence_present")).toBe(false);
    expect(countMatches(RESULT, { ...RESULT, emotional_tone: "upset", long_silence_present: true })).toBe(6);
  });

  it("ignores case and outer spaces in the free-text noise type", () => {
    expect(fieldMatches(RESULT, { ...RESULT, background_noise_type: " Television " }, "background_noise_type")).toBe(true);
    expect(fieldMatches(RESULT, { ...RESULT, background_noise_type: "tv" }, "background_noise_type")).toBe(false);
  });
});
