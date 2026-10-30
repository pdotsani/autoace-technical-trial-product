// Run manifest and status rules, used by the API and by the web app's mock API.
import type { FileView, RunView, WorkerResult } from "./api-types";
import { parseManifestCsv, type BatchReport, type Label } from "./validation";

export interface ManifestFile {
  name: string;
  status: "valid" | "skipped";
  inCsv: boolean; // a row of the given CSV (only these go into the output CSV)
  reason?: string; // skipped files
  expected?: Label; // parsed result_json label; kept for scoring, never sent to the worker
  invokeError?: string; // set by /analyze when the worker could not be invoked
}

export interface Manifest {
  runId: string;
  createdAt: string;
  csvName: string | null;
  labeled: boolean;
  blocking: string[];
  warnings: string[];
  files: ManifestFile[]; // CSV rows in CSV order, then uploaded files not listed in the CSV
  submittedAt: string | null;
}

export const TIMED_OUT = "timed out";

/** Per-file status in manifest order. A valid file with no result is processing until it is stale. */
export function runView(manifest: Manifest, results: Map<string, WorkerResult>, now: Date, staleAfterSec: number): RunView {
  const submittedMs = manifest.submittedAt ? Date.parse(manifest.submittedAt) : null;
  const stale = submittedMs !== null && now.getTime() - submittedMs > staleAfterSec * 1000;

  const files = manifest.files.map((f): FileView => {
    const base = { name: f.name, inCsv: f.inCsv, ...(f.expected ? { expected: f.expected } : {}) };
    if (f.status === "skipped") return { ...base, status: "skipped", error: f.reason };
    if (f.invokeError) return { ...base, status: "failed", error: f.invokeError };
    const result = results.get(f.name);
    if (result?.status === "failed") return { ...base, status: "failed", result, error: String(result.error ?? "") };
    if (result) return { ...base, status: "done", result };
    if (stale) return { ...base, status: "failed", error: TIMED_OUT };
    return { ...base, status: "processing" };
  });

  const counts = { total: files.length, done: 0, failed: 0, skipped: 0, processing: 0 };
  for (const f of files) counts[f.status]++;
  return {
    runId: manifest.runId,
    createdAt: manifest.createdAt,
    labeled: manifest.labeled,
    submitted: manifest.submittedAt !== null,
    counts,
    complete: manifest.submittedAt !== null && counts.processing === 0,
    files,
  };
}

/** True while the run has submitted files that may still get a result (for the retention rule). */
export function isProcessing(manifest: Manifest, resultNames: Set<string>, now: Date, staleAfterSec: number): boolean {
  if (!manifest.submittedAt) return false;
  if (now.getTime() - Date.parse(manifest.submittedAt) > staleAfterSec * 1000) return false;
  return manifest.files.some((f) => f.status === "valid" && !f.invokeError && !resultNames.has(f.name));
}

/** CSV rows in CSV order (valid or skipped), then skipped files that have no CSV row. */
export function manifestFiles(report: BatchReport, csvText: string | undefined): ManifestFile[] {
  const matched = new Set(report.matched);
  const reasons = new Map(report.skipped.map((s) => [s.name, s.reason]));
  const files: ManifestFile[] = [];
  const listed = new Set<string>();
  const parsed = csvText !== undefined && report.blocking.length === 0 ? parseManifestCsv(csvText) : null;
  for (const row of parsed?.ok ? parsed.rows : []) {
    if (row.name === "" || listed.has(row.name)) continue;
    listed.add(row.name);
    if (matched.has(row.name)) {
      const expected = report.expected[row.name];
      files.push({ name: row.name, status: "valid", inCsv: true, ...(expected ? { expected } : {}) });
    } else {
      files.push({ name: row.name, status: "skipped", inCsv: true, reason: reasons.get(row.name) ?? "missing audio" });
    }
  }
  for (const s of report.skipped) {
    if (!listed.has(s.name)) files.push({ name: s.name, status: "skipped", inCsv: false, reason: s.reason });
  }
  return files;
}

/** The output rows: exactly the given CSV's rows, in its order (uploads it doesn't list are left out). */
export function outputRows(view: RunView): { name: string; result: Record<string, unknown> }[] {
  return view.files.filter((f) => f.inCsv).map((f) => ({ name: f.name, result: outputResult(f) }));
}

function outputResult(f: FileView): Record<string, unknown> {
  switch (f.status) {
    case "done":
      return f.result!;
    case "failed":
      return { status: "failed", error: f.error ?? "" };
    case "skipped":
      return { status: "skipped", error: f.error ?? "" };
    case "processing":
      return { status: "processing", error: "result not ready" };
  }
}
