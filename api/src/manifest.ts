import type { Label } from "./validation";

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

/** What the worker wrote to results/{name}.json: a result, or {"status": "failed", "error": ...}. */
export type WorkerResult = Record<string, unknown> & { status?: string; error?: string };

export type FileStatus = "done" | "failed" | "skipped" | "processing";

export interface FileView {
  name: string;
  inCsv: boolean;
  status: FileStatus;
  result?: WorkerResult;
  error?: string;
}

export interface RunView {
  runId: string;
  createdAt: string;
  labeled: boolean;
  submitted: boolean;
  counts: Record<"total" | FileStatus, number>;
  complete: boolean;
  files: FileView[];
}

export const TIMED_OUT = "timed out";

/** Per-file status in manifest order. A valid file with no result is processing until it is stale. */
export function runView(manifest: Manifest, results: Map<string, WorkerResult>, now: Date, staleAfterSec: number): RunView {
  const submittedMs = manifest.submittedAt ? Date.parse(manifest.submittedAt) : null;
  const stale = submittedMs !== null && now.getTime() - submittedMs > staleAfterSec * 1000;

  const files = manifest.files.map((f): FileView => {
    const base = { name: f.name, inCsv: f.inCsv };
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
