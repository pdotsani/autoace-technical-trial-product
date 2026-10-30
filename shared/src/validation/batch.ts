import { parseManifestCsv } from "./csv";
import { describeIssues, labelSchema, type Label } from "./labels";
import { extensionOf, isIgnoredEntry, nameProblem } from "./names";

export const DEFAULT_SUPPORTED_AUDIO = [".wav", ".mp3", ".ogg", ".m4a", ".flac"];

export interface BatchFile {
  name: string;
  size: number;
}

export interface BatchOptions {
  supportedAudio?: string[]; // extensions with the dot, any case
  maxAudioBytes?: number;
  maxCsvBytes?: number;
}

/** Why a file is left out, for counting; reason is the human-readable text. */
export type SkipKind = "missing_audio" | "unmatched" | "ignored" | "invalid_name" | "too_large" | "empty";

export interface SkippedFile {
  name: string;
  kind: SkipKind;
  reason: string;
}

export interface BatchReport {
  blocking: string[];
  matched: string[]; // audio names with a CSV row, in CSV order
  skipped: SkippedFile[];
  warnings: string[];
  labeled: boolean; // the CSV has result_json labels
  summary: string;
  analyzable: boolean; // no blocking errors and at least one matched file
  csvName: string | null;
  expected: Record<string, Label>; // valid labels by name; kept for scoring, never sent to the worker
}

const MB = 1024 * 1024;

/**
 * Check a batch: one CSV manifest plus audio files. Without csvText (before upload) only names,
 * types, sizes and the CSV count are checked; with it, rows are matched to audio files.
 */
export function validateBatch(
  input: { files: BatchFile[]; csvText?: string },
  options: BatchOptions = {},
): BatchReport {
  const supported = new Set((options.supportedAudio ?? DEFAULT_SUPPORTED_AUDIO).map((e) => e.toLowerCase()));
  const maxAudio = options.maxAudioBytes ?? 500 * MB;
  const maxCsv = options.maxCsvBytes ?? 5 * MB;

  const blocking: string[] = [];
  const warnings: string[] = [];
  const skipped: SkippedFile[] = [];
  const audio = new Map<string, BatchFile>(); // usable audio files by exact name
  const skippedAudio = new Set<string>();
  const csvFiles: BatchFile[] = [];
  const seen = new Set<string>();

  for (const file of input.files) {
    if (isIgnoredEntry(file.name)) continue;
    const problem = nameProblem(file.name);
    if (problem) {
      skipped.push({ name: file.name, kind: "invalid_name", reason: `invalid name: ${problem}` });
      continue;
    }
    if (seen.has(file.name)) {
      blocking.push(`duplicate file name: ${file.name}`);
      continue;
    }
    seen.add(file.name);

    const ext = extensionOf(file.name);
    if (ext === ".csv") {
      csvFiles.push(file);
    } else if (!supported.has(ext)) {
      skipped.push({ name: file.name, kind: "ignored", reason: "ignored: unsupported type" });
      skippedAudio.add(file.name);
    } else if (file.size > maxAudio) {
      skipped.push({ name: file.name, kind: "too_large", reason: `larger than ${maxAudio / MB} MB` });
      skippedAudio.add(file.name);
    } else if (file.size === 0) {
      skipped.push({ name: file.name, kind: "empty", reason: "empty file" });
      skippedAudio.add(file.name);
    } else {
      audio.set(file.name, file);
    }
  }

  const csv = csvFiles.length === 1 ? csvFiles[0]! : null;
  if (csvFiles.length === 0) blocking.push("no CSV file: the batch needs exactly one .csv listing the audio files");
  if (csvFiles.length > 1) blocking.push(`${csvFiles.length} CSV files (${csvFiles.map((f) => f.name).join(", ")}): the batch needs exactly one`);
  if (csv && csv.size > maxCsv) blocking.push(`CSV ${csv.name} is larger than ${maxCsv / MB} MB`);

  const matched: string[] = [];
  const expected: Record<string, Label> = {};
  let labeled = false;

  if (csv && input.csvText !== undefined && blocking.length === 0) {
    const parsed = parseManifestCsv(input.csvText);
    if (!parsed.ok) {
      blocking.push(parsed.error);
    } else {
      const rowNames = new Set<string>();
      const duplicates = new Set<string>();
      for (const row of parsed.rows) {
        if (row.name === "") warnings.push(`row ${row.row}: empty name, row ignored`);
        else if (rowNames.has(row.name)) duplicates.add(row.name);
        else rowNames.add(row.name);
      }
      for (const name of duplicates) blocking.push(`duplicate name in CSV: ${name}`);

      const audioByLower = groupByLower([...audio.keys()]);
      const rowsByLower = groupByLower([...rowNames]);
      for (const row of parsed.rows) {
        if (row.name === "" || duplicates.has(row.name)) continue;
        if (row.resultJson !== "") {
          labeled = true;
          const label = checkLabel(row.resultJson);
          if (label.ok) expected[row.name] = label.value;
          else warnings.push(`row ${row.row} (${row.name}): invalid label, ${label.error}`);
        }
        if (audio.has(row.name)) {
          matched.push(row.name);
        } else if (!skippedAudio.has(row.name)) {
          const near = audioByLower.get(row.name.toLowerCase())?.filter((n) => !rowNames.has(n));
          skipped.push({ name: row.name, kind: "missing_audio", reason: "missing audio" + suggestion(near) });
        }
      }
      for (const name of audio.keys()) {
        if (rowNames.has(name)) continue;
        const near = rowsByLower.get(name.toLowerCase())?.filter((n) => !audio.has(n));
        skipped.push({ name, kind: "unmatched", reason: "unmatched audio: no CSV row" + suggestion(near) });
      }
      if (parsed.hasResultColumn && !labeled) warnings.push("result_json column is empty: batch is unlabeled");
      if (matched.length === 0 && blocking.length === 0) blocking.push("no audio file matches a CSV row");
    }
  }

  const analyzable = blocking.length === 0 && matched.length > 0;
  return {
    blocking,
    matched,
    skipped,
    warnings,
    labeled,
    analyzable,
    csvName: csv?.name ?? null,
    expected,
    summary: summarize({ blocking, matched, skipped, labeled, checkedCsv: input.csvText !== undefined, audioCount: audio.size }),
  };
}

function checkLabel(text: string): { ok: true; value: Label } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "result_json is not valid JSON" };
  }
  const result = labelSchema.safeParse(json);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: describeIssues(result.error) };
}

function groupByLower(names: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const name of names) groups.set(name.toLowerCase(), [...(groups.get(name.toLowerCase()) ?? []), name]);
  return groups;
}

function suggestion(near: string[] | undefined): string {
  return near?.length ? ` (did you mean ${near.map((n) => `"${n}"`).join(" or ")}? names must match exactly)` : "";
}

function summarize(r: {
  blocking: string[];
  matched: string[];
  skipped: SkippedFile[];
  labeled: boolean;
  checkedCsv: boolean;
  audioCount: number;
}): string {
  if (r.blocking.length) return `Cannot analyze: ${r.blocking.length} blocking error${r.blocking.length > 1 ? "s" : ""}.`;
  const skipped = r.skipped.length ? `, ${r.skipped.length} skipped` : "";
  if (!r.checkedCsv) return `${r.audioCount} audio file${r.audioCount === 1 ? "" : "s"} ready to upload${skipped}.`;
  return `${r.matched.length} file${r.matched.length === 1 ? "" : "s"} ready to analyze${skipped}; ${r.labeled ? "labeled" : "unlabeled"} batch.`;
}
