import { describe, expect, it } from "vitest";

import { validateBatch } from "../src/validation";

const LABEL = {
  emotional_tone: "upset",
  emotional_intensity: "high",
  background_noise_present: false,
  background_noise_type: "",
  background_noise_severity: "none",
  audio_quality: "clear",
  speaker_overlap_present: false,
  long_silence_present: false,
};

const audio = (...names: string[]) => names.map((name) => ({ name, size: 1000 }));
const csvFile = { name: "labels.csv", size: 100 };

function csvCell(value: unknown): string {
  return `"${JSON.stringify(value).replace(/"/g, '""')}"`;
}

describe("validateBatch: CSV count", () => {
  it("accepts exactly one CSV", () => {
    const report = validateBatch({ files: [csvFile, ...audio("a.wav")], csvText: "name\na.wav\n" });
    expect(report.blocking).toEqual([]);
    expect(report.matched).toEqual(["a.wav"]);
    expect(report.analyzable).toBe(true);
    expect(report.csvName).toBe("labels.csv");
  });

  it("blocks with no CSV", () => {
    const report = validateBatch({ files: audio("a.wav") });
    expect(report.blocking).toEqual([expect.stringContaining("no CSV file")]);
    expect(report.analyzable).toBe(false);
  });

  it("blocks with two CSVs", () => {
    const report = validateBatch({ files: [csvFile, { name: "other.CSV", size: 10 }, ...audio("a.wav")] });
    expect(report.blocking).toEqual([expect.stringContaining("2 CSV files")]);
  });

  it("checks names and the CSV count before upload, without CSV text", () => {
    const report = validateBatch({ files: [csvFile, ...audio("a.wav", "b.mp3")] });
    expect(report.blocking).toEqual([]);
    expect(report.matched).toEqual([]);
    expect(report.summary).toBe("2 audio files ready to upload.");
  });
});

describe("validateBatch: CSV parsing", () => {
  it("handles a BOM, CRLF line endings and quoted JSON", () => {
    const csvText = `﻿name,result_json\r\na.wav,${csvCell(LABEL)}\r\nb.wav,\r\n`;
    const report = validateBatch({ files: [csvFile, ...audio("a.wav", "b.wav")], csvText });
    expect(report.blocking).toEqual([]);
    expect(report.matched).toEqual(["a.wav", "b.wav"]);
    expect(report.labeled).toBe(true);
    expect(report.expected["a.wav"]).toEqual(LABEL);
    expect(report.expected["b.wav"]).toBeUndefined();
  });

  it("accepts a CSV without a result_json column (hidden test set)", () => {
    const report = validateBatch({ files: [csvFile, ...audio("a.wav", "b.wav")], csvText: "name\nb.wav\na.wav\n" });
    expect(report.blocking).toEqual([]);
    expect(report.labeled).toBe(false);
    expect(report.matched).toEqual(["b.wav", "a.wav"]); // CSV order
    expect(report.summary).toContain("unlabeled");
  });

  it("requires a name column", () => {
    const report = validateBatch({ files: [csvFile, ...audio("a.wav")], csvText: "file,result_json\na.wav,\n" });
    expect(report.blocking).toEqual(['CSV has no "name" column']);
  });

  it("blocks duplicate names in the CSV", () => {
    const report = validateBatch({ files: [csvFile, ...audio("a.wav")], csvText: "name\na.wav\na.wav\n" });
    expect(report.blocking).toEqual(["duplicate name in CSV: a.wav"]);
    expect(report.analyzable).toBe(false);
  });

  it("reports invalid labels per row without blocking", () => {
    const badEnum = { ...LABEL, emotional_tone: "angry" };
    const noiseRule = { ...LABEL, background_noise_type: "TV" };
    const csvText = [
      "name,result_json",
      "a.wav,{not json",
      `b.wav,${csvCell(badEnum)}`,
      `c.wav,${csvCell(noiseRule)}`,
      `d.wav,${csvCell({ ...LABEL, confidence: 0.7 })}`,
    ].join("\n");
    const report = validateBatch({ files: [csvFile, ...audio("a.wav", "b.wav", "c.wav", "d.wav")], csvText });
    expect(report.blocking).toEqual([]);
    expect(report.matched).toEqual(["a.wav", "b.wav", "c.wav", "d.wav"]);
    expect(report.warnings).toEqual([
      "row 2 (a.wav): invalid label, result_json is not valid JSON",
      expect.stringMatching(/^row 3 \(b\.wav\): invalid label, emotional_tone: /),
      expect.stringMatching(/^row 4 \(c\.wav\): invalid label, background_noise_type: must be ""/),
    ]);
    expect(Object.keys(report.expected)).toEqual(["d.wav"]);
  });
});

describe("validateBatch: matching", () => {
  it("reports missing and unmatched audio", () => {
    const report = validateBatch({ files: [csvFile, ...audio("a.wav", "extra.wav")], csvText: "name\na.wav\ngone.wav\n" });
    expect(report.matched).toEqual(["a.wav"]);
    expect(report.skipped).toEqual([
      { name: "gone.wav", kind: "missing_audio", reason: "missing audio" },
      { name: "extra.wav", kind: "unmatched", reason: "unmatched audio: no CSV row" },
    ]);
  });

  it("suggests case-insensitive near misses without auto-correcting", () => {
    const report = validateBatch({ files: [csvFile, ...audio("Call 001.WAV", "b.wav")], csvText: "name\ncall 001.wav\nb.wav\n" });
    expect(report.matched).toEqual(["b.wav"]);
    expect(report.skipped).toEqual([
      { name: "call 001.wav", kind: "missing_audio", reason: 'missing audio (did you mean "Call 001.WAV"? names must match exactly)' },
      { name: "Call 001.WAV", kind: "unmatched", reason: 'unmatched audio: no CSV row (did you mean "call 001.wav"? names must match exactly)' },
    ]);
  });

  it("blocks when nothing matches", () => {
    const report = validateBatch({ files: [csvFile, ...audio("a.wav")], csvText: "name\nb.wav\n" });
    expect(report.blocking).toEqual(["no audio file matches a CSV row"]);
  });
});

describe("validateBatch: files", () => {
  it("ignores unsupported types and silently skips hidden and __MACOSX entries", () => {
    const files = [
      csvFile,
      ...audio("a.wav", "notes.txt", ".DS_Store", "__MACOSX/._a.wav", ".hidden.wav"),
    ];
    const report = validateBatch({ files, csvText: "name\na.wav\n" });
    expect(report.skipped).toEqual([{ name: "notes.txt", kind: "ignored", reason: "ignored: unsupported type" }]);
    expect(report.matched).toEqual(["a.wav"]);
  });

  it("rejects names with path separators and keeps other names exactly", () => {
    const report = validateBatch({ files: [csvFile, ...audio("dir\\a.wav", " spaced name .ogg")], csvText: "name\n spaced name .ogg\n" });
    expect(report.skipped).toEqual([{ name: "dir\\a.wav", kind: "invalid_name", reason: "invalid name: name must not contain '/' or '\\'" }]);
    expect(report.matched).toEqual([" spaced name .ogg"]);
  });

  it("skips audio over the size limit and blocks an oversized CSV", () => {
    const report = validateBatch(
      { files: [{ name: "labels.csv", size: 10 }, { name: "big.wav", size: 3 * 1024 * 1024 }, ...audio("a.wav")], csvText: "name\nbig.wav\na.wav\n" },
      { maxAudioBytes: 2 * 1024 * 1024 },
    );
    expect(report.skipped).toEqual([{ name: "big.wav", kind: "too_large", reason: "larger than 2 MB" }]);
    expect(report.matched).toEqual(["a.wav"]);

    const big = validateBatch({ files: [{ name: "labels.csv", size: 2 * 1024 * 1024 }, ...audio("a.wav")] }, { maxCsvBytes: 1024 * 1024 });
    expect(big.blocking).toEqual(["CSV labels.csv is larger than 1 MB"]);
  });

  it("blocks duplicate file names", () => {
    const report = validateBatch({ files: [csvFile, ...audio("a.wav", "a.wav")] });
    expect(report.blocking).toEqual(["duplicate file name: a.wav"]);
  });
});
