import { InvokeCommand } from "@aws-sdk/client-lambda";
import { stringify } from "csv-stringify/sync";
import { z } from "zod";

import { lambda } from "./aws";
import { config, MB } from "./config";
import { ApiError, checkBody } from "./http";
import { isProcessing, runView, type Manifest, type ManifestFile, type RunView, type WorkerResult } from "./manifest";
import { isRunId, newRunId, runCreatedAt } from "./runId";
import {
  deletePrefix,
  getJson,
  getText,
  keys,
  listFolders,
  listObjects,
  mapLimit,
  prefixExists,
  PreconditionFailed,
  presignGet,
  presignPut,
  putJson,
  putText,
} from "./store";
import { extensionOf, isIgnoredEntry, nameProblem, parseManifestCsv, validateBatch, type BatchReport } from "./validation";

export interface RouteContext {
  userId: string;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: () => unknown;
  now: Date;
}

export interface RouteResult {
  status: number;
  body: unknown;
}

const INVOKE_CONCURRENCY = 10;
const READ_CONCURRENCY = 10;

const CONTENT_TYPES: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".csv": "text/csv",
};

function batchOptions() {
  return {
    supportedAudio: config.SUPPORTED_AUDIO,
    maxAudioBytes: config.MAX_AUDIO_MB * MB,
    maxCsvBytes: config.MAX_CSV_MB * MB,
  };
}

/** The report as returned to clients: labels stay server-side in the manifest. */
function publicReport({ expected: _expected, ...report }: BatchReport) {
  return report;
}

function runIdParam(ctx: RouteContext): string {
  const runId = ctx.params.runId ?? "";
  if (!isRunId(runId)) throw new ApiError(404, "RUN_NOT_FOUND", "run not found");
  return runId;
}

/** The run's manifest; 404 when the run does not exist for this user, 409 before /validate. */
async function requireManifest(userId: string, runId: string): Promise<{ manifest: Manifest; etag?: string }> {
  const got = await getJson<Manifest>(keys.manifest(userId, runId));
  if (got) return { manifest: got.value, etag: got.etag };
  if (await prefixExists(keys.run(userId, runId))) {
    throw new ApiError(409, "NOT_VALIDATED", "run has not been validated yet: call POST /runs/{runId}/validate");
  }
  throw new ApiError(404, "RUN_NOT_FOUND", "run not found");
}

async function resultNames(userId: string, runId: string): Promise<Set<string>> {
  const prefix = keys.results(userId, runId);
  const objects = await listObjects(prefix);
  return new Set(objects.filter((o) => o.key.endsWith(".json")).map((o) => o.key.slice(prefix.length, -".json".length)));
}

async function loadResults(userId: string, runId: string): Promise<Map<string, WorkerResult>> {
  const prefix = keys.results(userId, runId);
  const names = [...(await resultNames(userId, runId))];
  const values = await mapLimit(names, READ_CONCURRENCY, async (name) => (await getJson<WorkerResult>(`${prefix}${name}.json`))?.value);
  const results = new Map<string, WorkerResult>();
  names.forEach((name, i) => {
    const value = values[i];
    if (value) results.set(name, value);
  });
  return results;
}

async function loadView(userId: string, runId: string, now: Date): Promise<RunView> {
  const { manifest } = await requireManifest(userId, runId);
  return runView(manifest, await loadResults(userId, runId), now, config.STALE_AFTER_SEC);
}

// --- POST /runs --------------------------------------------------------------------------

const createRunBody = z.object({
  files: z
    .array(z.object({ name: z.string(), size: z.number().int().nonnegative(), contentType: z.string().optional() }))
    .min(1)
    .max(1000),
});

export async function createRun(ctx: RouteContext): Promise<RouteResult> {
  const { files } = checkBody(createRunBody, ctx.body());
  const report = validateBatch({ files }, batchOptions());
  if (report.blocking.length) {
    throw new ApiError(400, "INVALID_BATCH", report.blocking.join("; "), publicReport(report));
  }

  // Retention: a user keeps one run. Refuse while an earlier run is still processing.
  const userPrefix = keys.user(ctx.userId);
  for (const runId of (await listFolders(userPrefix)).filter(isRunId)) {
    const manifest = (await getJson<Manifest>(keys.manifest(ctx.userId, runId)))?.value;
    if (manifest && isProcessing(manifest, await resultNames(ctx.userId, runId), ctx.now, config.STALE_AFTER_SEC)) {
      throw new ApiError(409, "BATCH_PROCESSING", "an earlier batch is still processing; try again when it is complete");
    }
  }
  await deletePrefix(userPrefix);

  const runId = newRunId(ctx.now);
  const skipped = new Set(report.skipped.map((s) => s.name));
  const toUpload = files.filter((f) => !isIgnoredEntry(f.name) && !skipped.has(f.name));
  const uploads = await Promise.all(
    toUpload.map(async (f) => {
      const contentType = f.contentType || CONTENT_TYPES[extensionOf(f.name)] || "application/octet-stream";
      const url = await presignPut(keys.input(ctx.userId, runId, f.name), contentType);
      return { name: f.name, url, headers: { "Content-Type": contentType } };
    }),
  );
  return { status: 201, body: { runId, uploads, report: publicReport(report) } };
}

// --- POST /runs/{runId}/validate ---------------------------------------------------------

export async function validateRun(ctx: RouteContext): Promise<RouteResult> {
  const runId = runIdParam(ctx);
  const existing = await getJson<Manifest>(keys.manifest(ctx.userId, runId));
  if (existing?.value.submittedAt) throw new ApiError(409, "ALREADY_SUBMITTED", "run was already submitted for analysis");

  const inputPrefix = keys.input(ctx.userId, runId);
  const files = (await listObjects(inputPrefix)).map((o) => ({ name: o.key.slice(inputPrefix.length), size: o.size }));
  if (files.length === 0 && !existing) throw new ApiError(404, "RUN_NOT_FOUND", "run not found, or no files were uploaded");

  const csvFiles = files.filter((f) => extensionOf(f.name) === ".csv" && !isIgnoredEntry(f.name) && !nameProblem(f.name));
  const csv = csvFiles.length === 1 && csvFiles[0]!.size <= config.MAX_CSV_MB * MB ? csvFiles[0]! : null;
  const csvText = csv ? ((await getText(keys.input(ctx.userId, runId, csv.name)))?.text ?? "") : undefined;
  const report = validateBatch({ files, csvText }, batchOptions());

  const manifest: Manifest = {
    runId,
    createdAt: runCreatedAt(runId),
    csvName: report.csvName,
    labeled: report.labeled,
    blocking: report.blocking,
    warnings: report.warnings,
    files: manifestFiles(report, csvText),
    submittedAt: null,
  };
  await putJson(keys.manifest(ctx.userId, runId), manifest);
  return { status: 200, body: publicReport(report) };
}

/** CSV rows in CSV order (valid or skipped), then skipped files that have no CSV row. */
function manifestFiles(report: BatchReport, csvText: string | undefined): ManifestFile[] {
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

// --- POST /runs/{runId}/analyze ----------------------------------------------------------

export async function analyzeRun(ctx: RouteContext): Promise<RouteResult> {
  const runId = runIdParam(ctx);
  const { manifest, etag } = await requireManifest(ctx.userId, runId);
  if (manifest.submittedAt) throw new ApiError(409, "ALREADY_SUBMITTED", "run was already submitted for analysis");
  const valid = manifest.files.filter((f) => f.status === "valid");
  if (manifest.blocking.length || valid.length === 0) {
    throw new ApiError(409, "NOT_ANALYZABLE", manifest.blocking.join("; ") || "no valid audio files to analyze");
  }

  // Claim the run first (conditional write), so two concurrent calls can't both invoke workers
  manifest.submittedAt = ctx.now.toISOString();
  try {
    await putJson(keys.manifest(ctx.userId, runId), manifest, etag);
  } catch (err) {
    if (err instanceof PreconditionFailed) throw new ApiError(409, "ALREADY_SUBMITTED", "run was already submitted for analysis");
    throw err;
  }

  await mapLimit(valid, INVOKE_CONCURRENCY, async (file) => {
    try {
      const audioUrl = await presignGet(keys.input(ctx.userId, runId, file.name), config.WORKER_URL_EXPIRES);
      // Never include file.expected: labels stay out of the worker
      const payload = { run_id: runId, user_id: ctx.userId, name: file.name, audio_url: audioUrl };
      await lambda.send(
        new InvokeCommand({
          FunctionName: config.WORKER_FUNCTION_NAME,
          InvocationType: "Event",
          Payload: Buffer.from(JSON.stringify(payload)),
        }),
      );
    } catch (err) {
      file.invokeError = `could not start analysis: ${(err as Error).name || "error"}`;
    }
  });

  const failed = valid.filter((f) => f.invokeError).length;
  if (failed) await putJson(keys.manifest(ctx.userId, runId), manifest);
  return {
    status: 202,
    body: {
      runId,
      submittedAt: manifest.submittedAt,
      counts: { submitted: valid.length - failed, invokeFailed: failed, skipped: manifest.files.length - valid.length },
    },
  };
}

// --- GET /runs/{runId} -------------------------------------------------------------------

export async function getRun(ctx: RouteContext): Promise<RouteResult> {
  return { status: 200, body: await loadView(ctx.userId, runIdParam(ctx), ctx.now) };
}

// --- GET /runs/{runId}/output?format=csv|json[&partial=true] -----------------------------

export async function getOutput(ctx: RouteContext): Promise<RouteResult> {
  const runId = runIdParam(ctx);
  const format = ctx.query.format ?? "csv";
  if (format !== "csv" && format !== "json") throw new ApiError(400, "INVALID_FORMAT", "format must be csv or json");
  const partial = ctx.query.partial === "true";

  const view = await loadView(ctx.userId, runId, ctx.now);
  if (!view.complete && !partial) {
    throw new ApiError(409, "NOT_COMPLETE", "run is not complete; pass partial=true for the results so far");
  }

  // Exactly the given CSV's rows, in its order: uploads it doesn't list are left out
  const rows = view.files.filter((f) => f.inCsv).map((f) => ({ name: f.name, result: outputResult(f) }));
  const body =
    format === "csv"
      ? stringify([["name", "result_json"], ...rows.map((r) => [r.name, JSON.stringify(r.result)])], { record_delimiter: "\r\n" })
      : JSON.stringify(rows);
  const contentType = format === "csv" ? "text/csv; charset=utf-8" : "application/json";
  const key = keys.output(ctx.userId, runId, format);
  await putText(key, body, contentType);

  const url = await presignGet(key, config.DOWNLOAD_URL_EXPIRES, { filename: `results_${runId}.${format}`, contentType });
  return { status: 200, body: { url, complete: view.complete } };
}

function outputResult(f: RunView["files"][number]): Record<string, unknown> {
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

// --- GET /runs ---------------------------------------------------------------------------

export async function listRuns(ctx: RouteContext): Promise<RouteResult> {
  const runIds = (await listFolders(keys.user(ctx.userId))).filter(isRunId).sort().reverse();
  const runs = await mapLimit(runIds, READ_CONCURRENCY, async (runId) => {
    const manifest = (await getJson<Manifest>(keys.manifest(ctx.userId, runId)))?.value;
    if (!manifest) return { runId, createdAt: runCreatedAt(runId), validated: false, submitted: false, complete: false };
    const view = runView(manifest, await loadResults(ctx.userId, runId), ctx.now, config.STALE_AFTER_SEC);
    return {
      runId,
      createdAt: view.createdAt,
      validated: true,
      labeled: view.labeled,
      submitted: view.submitted,
      counts: view.counts,
      complete: view.complete,
    };
  });
  return { status: 200, body: { runs } };
}
