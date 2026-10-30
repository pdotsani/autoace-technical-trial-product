import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { parse } from "csv-parse/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handler } from "../src/index";
import type { Manifest } from "../src/manifest";

// --- In-memory S3 behind aws-sdk-client-mock ---------------------------------------------

const s3Mock = mockClient(S3Client);
const lambdaMock = mockClient(LambdaClient);
let store: Map<string, { body: string; etag: string }>;
let etagCounter = 0;

function installFakeS3(): void {
  store = new Map();
  s3Mock.reset();
  s3Mock.on(PutObjectCommand).callsFake((input) => {
    const current = store.get(input.Key);
    if (input.IfMatch && current?.etag !== input.IfMatch) {
      throw new S3ServiceException({ name: "PreconditionFailed", $fault: "client", $metadata: { httpStatusCode: 412 }, message: "precondition failed" });
    }
    store.set(input.Key, { body: String(input.Body), etag: `"${++etagCounter}"` });
    return {};
  });
  s3Mock.on(GetObjectCommand).callsFake((input) => {
    const obj = store.get(input.Key);
    if (!obj) throw new NoSuchKey({ message: "missing", $metadata: { httpStatusCode: 404 } });
    return { Body: { transformToString: async () => obj.body }, ETag: obj.etag };
  });
  s3Mock.on(ListObjectsV2Command).callsFake((input) => {
    const prefix = input.Prefix ?? "";
    const matching = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
    if (input.Delimiter) {
      const folders = [...new Set(matching.map((k) => k.slice(prefix.length)).filter((r) => r.includes("/")).map((r) => prefix + r.split("/")[0] + "/"))];
      return { CommonPrefixes: folders.map((Prefix) => ({ Prefix })), IsTruncated: false };
    }
    const contents = matching.slice(0, input.MaxKeys ?? 1000).map((Key) => ({ Key, Size: store.get(Key)!.body.length }));
    return { Contents: contents, KeyCount: contents.length, IsTruncated: false };
  });
  s3Mock.on(DeleteObjectsCommand).callsFake((input) => {
    for (const o of input.Delete.Objects) store.delete(o.Key);
    return {};
  });
  lambdaMock.reset();
  lambdaMock.on(InvokeCommand).resolves({ StatusCode: 202 });
}

function put(key: string, value: unknown): void {
  store.set(key, { body: typeof value === "string" ? value : JSON.stringify(value), etag: `"${++etagCounter}"` });
}

function readJson<T>(key: string): T {
  return JSON.parse(store.get(key)!.body) as T;
}

// --- Helpers -----------------------------------------------------------------------------

const USER = "dev-user";
const NOW = new Date("2026-10-30T12:00:00Z");

async function call(method: string, path: string, body?: unknown, query?: Record<string, string>) {
  const event = {
    rawPath: path,
    queryStringParameters: query,
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { http: { method }, requestId: "req-1" },
  } as unknown as APIGatewayProxyEventV2;
  const res = (await handler(event)) as APIGatewayProxyStructuredResultV2;
  return { status: res.statusCode, body: JSON.parse(String(res.body)) };
}

const RESULT = {
  emotional_tone: "neutral",
  emotional_intensity: "medium",
  background_noise_present: true,
  background_noise_type: "TV, \"loud\"",
  background_noise_severity: "medium",
  audio_quality: "clear",
  speaker_overlap_present: true,
  long_silence_present: false,
  confidence: 0.886,
};
const LABEL = { ...RESULT, confidence: undefined };

const RUN = "20261030T115000Z-0123456789abcdef0123";
const runKey = (rest: string, runId = RUN, user = USER) => `runs/${user}/${runId}/${rest}`;

function uploadBatch(runId = RUN): void {
  const label = JSON.stringify(LABEL).replace(/"/g, '""');
  put(runKey("input/labels.csv", runId), `name,result_json\r\nb call.wav,"${label}"\r\na.wav,\r\nmissing.wav,\r\n`);
  put(runKey("input/a.wav", runId), "RIFF....");
  put(runKey("input/b call.wav", runId), "RIFF....");
  put(runKey("input/extra.ogg", runId), "OggS....");
}

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    runId: RUN,
    createdAt: "2026-10-30T11:50:00Z",
    csvName: "labels.csv",
    labeled: true,
    blocking: [],
    warnings: [],
    files: [
      { name: "b call.wav", status: "valid", inCsv: true, expected: LABEL as never },
      { name: "a.wav", status: "valid", inCsv: true },
      { name: "c.wav", status: "valid", inCsv: true },
      { name: "missing.wav", status: "skipped", inCsv: true, reason: "missing audio" },
      { name: "extra.ogg", status: "skipped", inCsv: false, reason: "unmatched audio: no CSV row" },
    ],
    submittedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  installFakeS3();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// --- POST /runs --------------------------------------------------------------------------

describe("POST /runs", () => {
  const files = [
    { name: "labels.csv", size: 120, contentType: "text/csv" },
    { name: "a.wav", size: 1000, contentType: "audio/wav" },
    { name: "notes.txt", size: 5 },
    { name: ".DS_Store", size: 5 },
  ];

  it("returns a presigned PUT per uploadable file, with the content type fixed", async () => {
    const res = await call("POST", "/runs", { files });
    expect(res.status).toBe(201);
    expect(res.body.runId).toMatch(/^20261030T120000Z-[0-9a-f]{20}$/);
    expect(res.body.uploads.map((u: { name: string }) => u.name)).toEqual(["labels.csv", "a.wav"]);
    const upload = res.body.uploads[1];
    expect(upload.headers).toEqual({ "Content-Type": "audio/wav" });
    expect(upload.url).toContain(`runs/${USER}/${res.body.runId}/input/a.wav`);
    expect(upload.url).toContain("X-Amz-Signature=");
    expect(res.body.report.skipped).toEqual([{ name: "notes.txt", kind: "ignored", reason: "ignored: unsupported type" }]);
  });

  it("rejects a batch with blocking errors", async () => {
    const res = await call("POST", "/runs", { files: [{ name: "a.wav", size: 10 }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_BATCH");
    expect(res.body.error.details.blocking).toEqual([expect.stringContaining("no CSV")]);
  });

  it("refuses with 409 while an earlier batch is still processing", async () => {
    put(runKey("manifest.json"), manifest({ submittedAt: "2026-10-30T11:55:00Z" })); // 5 min ago
    put(runKey("results/b call.wav.json"), RESULT);
    const res = await call("POST", "/runs", { files });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("BATCH_PROCESSING");
    expect(store.has(runKey("manifest.json"))).toBe(true); // nothing deleted
  });

  it("deletes the user's earlier runs once they are finished or stale, and only theirs", async () => {
    put(runKey("manifest.json"), manifest({ submittedAt: "2026-10-30T11:00:00Z" })); // stale: 60 min ago
    put(runKey("input/a.wav"), "RIFF");
    put(runKey("results/a.wav.json"), RESULT);
    put("runs/other-user/20261030T110000Z-aaaaaaaaaaaaaaaaaaaa/manifest.json", manifest());
    const res = await call("POST", "/runs", { files });
    expect(res.status).toBe(201);
    expect([...store.keys()]).toEqual(["runs/other-user/20261030T110000Z-aaaaaaaaaaaaaaaaaaaa/manifest.json"]);
  });
});

// --- POST /runs/{runId}/validate ---------------------------------------------------------

describe("POST /runs/{runId}/validate", () => {
  it("reads the CSV, writes manifest.json and returns the report", async () => {
    uploadBatch();
    const res = await call("POST", `/runs/${RUN}/validate`);
    expect(res.status).toBe(200);
    expect(res.body.matched).toEqual(["b call.wav", "a.wav"]);
    expect(res.body.expected).toBeUndefined(); // labels stay server-side

    const written = readJson<Manifest>(runKey("manifest.json"));
    expect(written).toMatchObject({ runId: RUN, createdAt: "2026-10-30T11:50:00Z", csvName: "labels.csv", labeled: true, submittedAt: null });
    expect(written.files).toEqual([
      { name: "b call.wav", status: "valid", inCsv: true, expected: LABEL },
      { name: "a.wav", status: "valid", inCsv: true },
      { name: "missing.wav", status: "skipped", inCsv: true, reason: "missing audio" },
      { name: "extra.ogg", status: "skipped", inCsv: false, reason: "unmatched audio: no CSV row" },
    ]);
  });

  it("404s for a malformed run ID, an unknown run, or another user's run", async () => {
    uploadBatch("20261030T115000Z-ffffffffffffffffffff");
    for (const runId of ["not-a-run", "20261030T115000Z-ffffffffffffffffffff"]) {
      store.clear();
      put(runKey("input/a.wav", "20261030T115000Z-ffffffffffffffffffff", "other-user"), "RIFF");
      const res = await call("POST", `/runs/${runId}/validate`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("RUN_NOT_FOUND");
    }
  });
});

// --- POST /runs/{runId}/analyze ----------------------------------------------------------

describe("POST /runs/{runId}/analyze", () => {
  it("invokes the worker once per valid file with the right payload and no labels", async () => {
    uploadBatch();
    await call("POST", `/runs/${RUN}/validate`);
    const res = await call("POST", `/runs/${RUN}/analyze`);
    expect(res.status).toBe(202);
    expect(res.body.counts).toEqual({ submitted: 2, invokeFailed: 0, skipped: 2 });

    const calls = lambdaMock.commandCalls(InvokeCommand);
    expect(calls).toHaveLength(2);
    const payloads = calls.map((c) => {
      expect(c.args[0].input).toMatchObject({ FunctionName: "autoace-worker", InvocationType: "Event" });
      return JSON.parse(Buffer.from(c.args[0].input.Payload as Uint8Array).toString());
    });
    for (const [i, name] of ["b call.wav", "a.wav"].entries()) {
      const payload = payloads[i];
      expect(Object.keys(payload).sort()).toEqual(["audio_url", "name", "run_id", "user_id"]);
      expect(payload).toMatchObject({ run_id: RUN, user_id: USER, name });
      expect(payload.audio_url).toContain(`input/${encodeURIComponent(name).replace(/%20/g, "%20")}`);
      expect(payload.audio_url).toContain("X-Amz-Expires=3600");
      expect(JSON.stringify(payload)).not.toContain("emotional_tone");
    }
    expect(readJson<Manifest>(runKey("manifest.json")).submittedAt).toBe(NOW.toISOString());
  });

  it("409s when already submitted, and records per-file invoke errors", async () => {
    uploadBatch();
    await call("POST", `/runs/${RUN}/validate`);
    lambdaMock.on(InvokeCommand).rejectsOnce(Object.assign(new Error("throttled"), { name: "TooManyRequestsException" }));
    const first = await call("POST", `/runs/${RUN}/analyze`);
    expect(first.body.counts).toEqual({ submitted: 1, invokeFailed: 1, skipped: 2 });
    const failed = readJson<Manifest>(runKey("manifest.json")).files.filter((f) => f.invokeError);
    expect(failed).toEqual([expect.objectContaining({ invokeError: "could not start analysis: TooManyRequestsException" })]);

    const again = await call("POST", `/runs/${RUN}/analyze`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("ALREADY_SUBMITTED");
  });

  it("409s before validation", async () => {
    uploadBatch();
    const res = await call("POST", `/runs/${RUN}/analyze`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("NOT_VALIDATED");
  });
});

// --- GET /runs/{runId} and GET /runs -----------------------------------------------------

describe("GET /runs/{runId}", () => {
  it("reports done, failed, skipped and processing in manifest order", async () => {
    put(runKey("manifest.json"), manifest({ submittedAt: "2026-10-30T11:58:00Z" }));
    put(runKey("results/b call.wav.json"), RESULT);
    put(runKey("results/a.wav.json"), { status: "failed", error: "decode failed: corrupt" });
    const res = await call("GET", `/runs/${RUN}`);
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ total: 5, done: 1, failed: 1, skipped: 2, processing: 1 });
    expect(res.body.complete).toBe(false);
    expect(res.body.files).toEqual([
      { name: "b call.wav", inCsv: true, status: "done", result: RESULT, expected: LABEL },
      { name: "a.wav", inCsv: true, status: "failed", result: { status: "failed", error: "decode failed: corrupt" }, error: "decode failed: corrupt" },
      { name: "c.wav", inCsv: true, status: "processing" },
      { name: "missing.wav", inCsv: true, status: "skipped", error: "missing audio" },
      { name: "extra.ogg", inCsv: false, status: "skipped", error: "unmatched audio: no CSV row" },
    ]);
  });

  it("marks files without a result as timed out after STALE_AFTER_SEC", async () => {
    put(runKey("manifest.json"), manifest({ submittedAt: "2026-10-30T11:43:00Z" })); // 17 min > 960 s
    put(runKey("results/b call.wav.json"), RESULT);
    const res = await call("GET", `/runs/${RUN}`);
    expect(res.body.counts).toEqual({ total: 5, done: 1, failed: 2, skipped: 2, processing: 0 });
    expect(res.body.complete).toBe(true);
    expect(res.body.files[2]).toEqual({ name: "c.wav", inCsv: true, status: "failed", error: "timed out" });
  });

  it("lists runs newest first", async () => {
    put(runKey("manifest.json"), manifest({ submittedAt: "2026-10-30T11:58:00Z" }));
    put(runKey("input/a.wav", "20261030T115900Z-bbbbbbbbbbbbbbbbbbbb"), "RIFF");
    const res = await call("GET", "/runs");
    expect(res.body.runs.map((r: { runId: string }) => r.runId)).toEqual(["20261030T115900Z-bbbbbbbbbbbbbbbbbbbb", RUN]);
    expect(res.body.runs[0]).toMatchObject({ validated: false, complete: false });
    expect(res.body.runs[1]).toMatchObject({ validated: true, complete: false, counts: { total: 5, processing: 3 } });
  });
});

// --- GET /runs/{runId}/output ------------------------------------------------------------

describe("GET /runs/{runId}/output", () => {
  function completeRun(): void {
    put(runKey("manifest.json"), manifest({ submittedAt: "2026-10-30T11:58:00Z" }));
    put(runKey("results/b call.wav.json"), RESULT);
    put(runKey("results/a.wav.json"), { status: "failed", error: "decode failed: corrupt" });
    put(runKey("results/c.wav.json"), RESULT);
  }

  it("writes exactly the given CSV's rows, in its order, with RFC 4180 quoting and failed / skipped rows", async () => {
    completeRun();
    const res = await call("GET", `/runs/${RUN}/output`, undefined, { format: "csv" });
    expect(res.status).toBe(200);
    expect(res.body.url).toContain(`outputs/results_${RUN}.csv`);
    expect(decodeURIComponent(res.body.url)).toContain(`attachment; filename="results_${RUN}.csv"`);

    const csv = store.get(runKey(`outputs/results_${RUN}.csv`))!.body;
    expect(csv.split("\r\n")[0]).toBe("name,result_json");
    expect(csv).toContain('"{""emotional_tone"":""neutral""'); // quotes doubled inside a quoted field
    const rows = parse(csv, { columns: true }) as { name: string; result_json: string }[];
    expect(rows.map((r) => r.name)).toEqual(["b call.wav", "a.wav", "c.wav", "missing.wav"]); // no extra.ogg
    expect(rows.map((r) => JSON.parse(r.result_json))).toEqual([
      RESULT,
      { status: "failed", error: "decode failed: corrupt" },
      RESULT,
      { status: "skipped", error: "missing audio" },
    ]);
    expect(rows[0]!.result_json).toBe(JSON.stringify(RESULT)); // compact JSON
  });

  it("writes JSON, and 409s on an incomplete run unless partial=true", async () => {
    put(runKey("manifest.json"), manifest({ submittedAt: "2026-10-30T11:58:00Z" }));
    put(runKey("results/b call.wav.json"), RESULT);
    const refused = await call("GET", `/runs/${RUN}/output`, undefined, { format: "json" });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("NOT_COMPLETE");

    const partial = await call("GET", `/runs/${RUN}/output`, undefined, { format: "json", partial: "true" });
    expect(partial.status).toBe(200);
    expect(partial.body.complete).toBe(false);
    const rows = readJson<{ name: string; result: unknown }[]>(runKey(`outputs/results_${RUN}.json`));
    expect(rows.map((r) => r.name)).toEqual(["b call.wav", "a.wav", "c.wav", "missing.wav"]); // no extra.ogg
    expect(rows[2]!.result).toEqual({ status: "processing", error: "result not ready" });
  });
});

describe("routing", () => {
  it("returns JSON errors for unknown routes and wrong methods", async () => {
    expect((await call("GET", "/nope")).status).toBe(404);
    expect((await call("DELETE", "/runs")).body.error.code).toBe("METHOD_NOT_ALLOWED");
  });

  it("answers browser preflights with 204", async () => {
    const event = { rawPath: "/runs/abc/validate", requestContext: { http: { method: "OPTIONS" }, requestId: "req-1" } } as unknown as APIGatewayProxyEventV2;
    expect(((await handler(event)) as APIGatewayProxyStructuredResultV2).statusCode).toBe(204);
  });
});
