// Request and response bodies of every API route (api/src/routes.ts types its responses
// against these with `satisfies`, so the two can't drift apart).
import type { BatchReport } from "./validation";

// --- Errors ------------------------------------------------------------------------------

export type ApiErrorCode =
  | "INVALID_JSON"
  | "INVALID_REQUEST"
  | "INVALID_BATCH"
  | "INVALID_FORMAT"
  | "BATCH_PROCESSING"
  | "RUN_NOT_FOUND"
  | "NOT_VALIDATED"
  | "NOT_ANALYZABLE"
  | "ALREADY_SUBMITTED"
  | "NOT_COMPLETE"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "AUTH_NOT_CONFIGURED"
  | "INTERNAL";

/** Every error response: `{ error: { code, message, details? } }` with a matching status code. */
export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; details?: unknown };
}

// --- Shared pieces -----------------------------------------------------------------------

/** The validation report as clients see it: labels (`expected`) stay server-side. */
export type ValidationReport = Omit<BatchReport, "expected">;

export type FileStatus = "done" | "failed" | "skipped" | "processing";

/** What the worker wrote for a file: a schema result, or `{status: "failed", error}`. */
export type WorkerResult = Record<string, unknown> & { status?: string; error?: string };

export interface FileView {
  name: string;
  inCsv: boolean; // a row of the given CSV (only these go into the output)
  status: FileStatus;
  result?: WorkerResult;
  error?: string; // skipped and failed files
}

export type RunCounts = Record<"total" | FileStatus, number>;

// --- POST /runs --------------------------------------------------------------------------

export interface CreateRunFile {
  name: string;
  size: number;
  contentType?: string;
}

export interface CreateRunRequest {
  files: CreateRunFile[]; // 1-1000
}

export interface UploadTarget {
  name: string;
  url: string; // presigned PUT
  headers: Record<string, string>; // send exactly these with the PUT
}

/** 201. Files skipped before upload (report.skipped) get no upload URL. */
export interface CreateRunResponse {
  runId: string;
  uploads: UploadTarget[];
  report: ValidationReport;
}

// --- POST /runs/{runId}/validate ---------------------------------------------------------

/** 200 */
export type ValidateRunResponse = ValidationReport;

// --- POST /runs/{runId}/analyze ----------------------------------------------------------

/** 202 */
export interface AnalyzeRunResponse {
  runId: string;
  submittedAt: string;
  counts: { submitted: number; invokeFailed: number; skipped: number };
}

// --- GET /runs/{runId} -------------------------------------------------------------------

/** 200. Files are in manifest order: the CSV's rows, then uploads the CSV doesn't list. */
export interface RunView {
  runId: string;
  createdAt: string;
  labeled: boolean;
  submitted: boolean;
  counts: RunCounts;
  complete: boolean;
  files: FileView[];
}

export type GetRunResponse = RunView;

// --- GET /runs/{runId}/output?format=csv|json[&partial=true] -----------------------------

export type OutputFormat = "csv" | "json";

/** 200. `url` downloads `name,result_json` rows (CSV) or `[{name, result}]` (JSON). */
export interface GetOutputResponse {
  url: string;
  complete: boolean;
}

// --- GET /runs ---------------------------------------------------------------------------

export type RunSummary =
  | { runId: string; createdAt: string; validated: false; submitted: false; complete: false }
  | {
      runId: string;
      createdAt: string;
      validated: true;
      labeled: boolean;
      submitted: boolean;
      counts: RunCounts;
      complete: boolean;
    };

/** 200, newest first */
export interface ListRunsResponse {
  runs: RunSummary[];
}
