import type {
  CreateRunResponse,
  ListRunsResponse,
  OutputFormat,
  RunSummary,
  RunView,
  WorkerResult,
} from "@autoace/shared/api-types";
import { isProcessing, manifestFiles, outputRows, runView, type Manifest } from "@autoace/shared/runs";
import type { Result } from "@autoace/shared/schema";
import { extensionOf, isIgnoredEntry, nameProblem, validateBatch, type BatchReport } from "@autoace/shared/validation";

import { ApiError, type ApiClient } from "./client";
import { toCsv } from "./csv";

/**
 * In-memory stand-in for the API, with the same contract: the same validation, manifest and
 * status rules (from @autoace/shared), the same error codes, and one run per user. State lives
 * in this browser tab only; a reload starts empty.
 *
 * After /analyze each valid file finishes 10-20 s later. When a batch has two or more files,
 * the last one fails the way the worker reports undecodable audio.
 */
export interface MockOptions {
  now?: () => number;
  random?: () => number;
  processingMs?: [min: number, max: number];
  uploadMs?: number; // simulated time per upload
  latencyMs?: number; // simulated time per API call
}

export const MOCK_DECODE_ERROR = "decode failed: audio could not be decoded";

// Same defaults as the API (api/src/config.ts)
const LIMITS = { supportedAudio: [".wav", ".mp3", ".ogg", ".m4a", ".flac"], maxAudioBytes: 500 * 1024 * 1024, maxCsvBytes: 5 * 1024 * 1024 };
const STALE_AFTER_SEC = 960;
const CONTENT_TYPES: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".csv": "text/csv",
};

interface MockRun {
  runId: string;
  inputs: Map<string, Blob>;
  manifest: Manifest | null;
  finishAt: Map<string, number>; // valid file -> time its result appears
  failing: string | null;
}

export function createMockApi(getUserId: () => Promise<string | null>, options: MockOptions = {}): ApiClient {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const [minMs, maxMs] = options.processingMs ?? [10_000, 20_000];
  const uploadMs = options.uploadMs ?? 1200;
  const latencyMs = options.latencyMs ?? 150;
  const users = new Map<string, MockRun[]>();

  async function user(): Promise<string> {
    await sleep(latencyMs);
    const id = await getUserId();
    if (!id) throw new ApiError(401, "AUTH_NOT_CONFIGURED", "not signed in");
    return id;
  }

  function findRun(userId: string, runId: string): MockRun {
    const run = users.get(userId)?.find((r) => r.runId === runId);
    if (!run) throw new ApiError(404, "RUN_NOT_FOUND", "run not found");
    return run;
  }

  function requireManifest(run: MockRun): Manifest {
    if (!run.manifest) throw new ApiError(409, "NOT_VALIDATED", "run has not been validated yet: call POST /runs/{runId}/validate");
    return run.manifest;
  }

  function results(run: MockRun): Map<string, WorkerResult> {
    const out = new Map<string, WorkerResult>();
    for (const [name, at] of run.finishAt) {
      if (at > now()) continue;
      out.set(name, name === run.failing ? { status: "failed", error: MOCK_DECODE_ERROR } : mockResult(name));
    }
    return out;
  }

  function view(run: MockRun): RunView {
    return runView(requireManifest(run), results(run), new Date(now()), STALE_AFTER_SEC);
  }

  return {
    mode: "mock",

    async createRun({ files }) {
      const userId = await user();
      if (!files.length) throw new ApiError(400, "INVALID_REQUEST", "files: Too small: expected array to have >=1 items");
      const report = validateBatch({ files }, LIMITS);
      if (report.blocking.length) throw new ApiError(400, "INVALID_BATCH", report.blocking.join("; "), publicReport(report));

      for (const run of users.get(userId) ?? []) {
        if (run.manifest && isProcessing(run.manifest, new Set(results(run).keys()), new Date(now()), STALE_AFTER_SEC)) {
          throw new ApiError(409, "BATCH_PROCESSING", "an earlier batch is still processing; try again when it is complete");
        }
      }
      const runId = newRunId(new Date(now()));
      users.set(userId, [{ runId, inputs: new Map(), manifest: null, finishAt: new Map(), failing: null }]);

      const skipped = new Set(report.skipped.map((s) => s.name));
      const uploads = files
        .filter((f) => !isIgnoredEntry(f.name) && !skipped.has(f.name))
        .map((f) => {
          const contentType = f.contentType || CONTENT_TYPES[extensionOf(f.name)] || "application/octet-stream";
          return { name: f.name, url: `mock://upload/${userId}/${runId}/${encodeURIComponent(f.name)}`, headers: { "Content-Type": contentType } };
        });
      return { runId, uploads, report: publicReport(report) } satisfies CreateRunResponse;
    },

    async upload(target, file, onProgress) {
      const match = /^mock:\/\/upload\/([^/]+)\/([^/]+)\/(.+)$/.exec(target.url);
      if (!match) throw new ApiError(403, "UPLOAD_FAILED", "upload failed: HTTP 403 (upload link expired or invalid)");
      const [, userId, runId, name] = match;
      const steps = 10;
      for (let i = 1; i <= steps; i++) {
        await sleep(uploadMs / steps);
        onProgress?.(i / steps);
      }
      // Like S3, a PUT to a deleted run's URL still "works" but the run is gone
      users.get(userId!)?.find((r) => r.runId === runId)?.inputs.set(decodeURIComponent(name!), file);
    },

    async validateRun(runId) {
      const run = findRun(await user(), runId);
      if (run.manifest?.submittedAt) throw new ApiError(409, "ALREADY_SUBMITTED", "run was already submitted for analysis");
      const files = [...run.inputs].map(([name, blob]) => ({ name, size: blob.size }));
      if (files.length === 0 && !run.manifest) throw new ApiError(404, "RUN_NOT_FOUND", "run not found, or no files were uploaded");

      const csvFiles = files.filter((f) => extensionOf(f.name) === ".csv" && !isIgnoredEntry(f.name) && !nameProblem(f.name));
      const csv = csvFiles.length === 1 && csvFiles[0]!.size <= LIMITS.maxCsvBytes ? csvFiles[0]! : null;
      const csvText = csv ? await run.inputs.get(csv.name)!.text() : undefined;
      const report = validateBatch({ files, csvText }, LIMITS);
      run.manifest = {
        runId,
        createdAt: runCreatedAt(runId),
        csvName: report.csvName,
        labeled: report.labeled,
        blocking: report.blocking,
        warnings: report.warnings,
        files: manifestFiles(report, csvText),
        submittedAt: null,
      };
      return publicReport(report);
    },

    async analyzeRun(runId) {
      const run = findRun(await user(), runId);
      const manifest = requireManifest(run);
      if (manifest.submittedAt) throw new ApiError(409, "ALREADY_SUBMITTED", "run was already submitted for analysis");
      const valid = manifest.files.filter((f) => f.status === "valid");
      if (manifest.blocking.length || valid.length === 0) {
        throw new ApiError(409, "NOT_ANALYZABLE", manifest.blocking.join("; ") || "no valid audio files to analyze");
      }
      manifest.submittedAt = new Date(now()).toISOString();
      for (const f of valid) run.finishAt.set(f.name, now() + minMs + random() * (maxMs - minMs));
      run.failing = valid.length >= 2 ? valid[valid.length - 1]!.name : null;
      return {
        runId,
        submittedAt: manifest.submittedAt,
        counts: { submitted: valid.length, invokeFailed: 0, skipped: manifest.files.length - valid.length },
      };
    },

    async getRun(runId) {
      return view(findRun(await user(), runId));
    },

    async getOutput(runId: string, format: OutputFormat, partial = false) {
      const current = view(findRun(await user(), runId));
      if (!current.complete && !partial) {
        throw new ApiError(409, "NOT_COMPLETE", "run is not complete; pass partial=true for the results so far");
      }
      const blob = new Blob([outputBody(current, format)], { type: format === "csv" ? "text/csv;charset=utf-8" : "application/json" });
      return { url: URL.createObjectURL(blob), complete: current.complete };
    },

    async listRuns() {
      const userId = await user();
      const runs = (users.get(userId) ?? []).map((run): RunSummary => {
        if (!run.manifest) return { runId: run.runId, createdAt: runCreatedAt(run.runId), validated: false, submitted: false, complete: false };
        const v = view(run);
        return { runId: v.runId, createdAt: v.createdAt, validated: true, labeled: v.labeled, submitted: v.submitted, counts: v.counts, complete: v.complete };
      });
      return { runs: runs.reverse() } satisfies ListRunsResponse;
    },
  };
}

/** The download body, formatted like the API's: CSV `name,result_json` with CRLF, or JSON `[{name, result}]`. */
export function outputBody(view: RunView, format: OutputFormat): string {
  const rows = outputRows(view);
  return format === "csv"
    ? toCsv([["name", "result_json"], ...rows.map((r) => [r.name, JSON.stringify(r.result)])])
    : JSON.stringify(rows);
}

function publicReport({ expected: _expected, ...report }: BatchReport) {
  return report;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** Same format as api/src/runId.ts: YYYYMMDDTHHMMSSZ- plus 20 random hex characters. */
function newRunId(date: Date): string {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `${stamp}-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function runCreatedAt(runId: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(runId)!;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

// Results shaped like the worker's, picked by file name so a name always gets the same one.
const SAMPLE_RESULTS: Result[] = [
  {
    emotional_tone: "upset",
    emotional_intensity: "high",
    background_noise_present: false,
    background_noise_type: "",
    background_noise_severity: "none",
    audio_quality: "clear",
    speaker_overlap_present: true,
    long_silence_present: false,
    confidence: 0.898,
  },
  {
    emotional_tone: "neutral",
    emotional_intensity: "medium",
    background_noise_present: true,
    background_noise_type: "television",
    background_noise_severity: "medium",
    audio_quality: "slightly_impaired",
    speaker_overlap_present: false,
    long_silence_present: false,
    confidence: 0.886,
  },
  {
    emotional_tone: "satisfied",
    emotional_intensity: "medium",
    background_noise_present: true,
    background_noise_type: "sharp static",
    background_noise_severity: "medium",
    audio_quality: "slightly_impaired",
    speaker_overlap_present: false,
    long_silence_present: true,
    confidence: 0.885,
  },
  {
    emotional_tone: "frustrated",
    emotional_intensity: "low",
    background_noise_present: true,
    background_noise_type: "traffic",
    background_noise_severity: "low",
    audio_quality: "clear",
    speaker_overlap_present: true,
    long_silence_present: false,
    confidence: 0.742,
  },
];

function mockResult(name: string): Result {
  const digits = /(\d+)/.exec(name)?.[1];
  const index = digits ? Number(digits) - 1 : [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  return { ...SAMPLE_RESULTS[((index % SAMPLE_RESULTS.length) + SAMPLE_RESULTS.length) % SAMPLE_RESULTS.length]! };
}
