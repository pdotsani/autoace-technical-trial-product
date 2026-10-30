import { afterEach, describe, expect, it, vi } from "vitest";

import { resultSchema } from "@autoace/shared/schema";

import { ApiError } from "../src/api/client";
import { MOCK_DECODE_ERROR } from "../src/api/mock";
import { file, testApi } from "./helpers";

const CSV = 'name,result_json\ncall_002.ogg,\n"call, 003.ogg",\nmissing.ogg,\ncall_001.ogg,\n';

async function submittedBatch() {
  const { api, clock } = testApi();
  const created = await api.createRun({
    files: ["labels.csv", "call_001.ogg", "call_002.ogg", "call, 003.ogg", "extra.ogg"].map((name) => ({ name, size: 100 })),
  });
  for (const target of created.uploads) {
    await api.upload(target, target.name === "labels.csv" ? file(target.name, CSV) : file(target.name));
  }
  const report = await api.validateRun(created.runId);
  await api.analyzeRun(created.runId);
  return { api, clock, runId: created.runId, report };
}

afterEach(() => vi.unstubAllGlobals());

describe("mock API", () => {
  it("processes every file within 20 s; one fails like undecodable audio", async () => {
    const { api, clock, runId, report } = await submittedBatch();
    expect(report.matched).toEqual(["call_002.ogg", "call, 003.ogg", "call_001.ogg"]);

    const started = await api.getRun(runId);
    expect(started.complete).toBe(false);
    expect(started.counts).toEqual({ total: 5, done: 0, failed: 0, skipped: 2, processing: 3 });

    clock.advance(20_001);
    const view = await api.getRun(runId);
    expect(view.complete).toBe(true);
    expect(view.counts).toEqual({ total: 5, done: 2, failed: 1, skipped: 2, processing: 0 });
    expect(view.files.map((f) => [f.name, f.status])).toEqual([
      ["call_002.ogg", "done"],
      ["call, 003.ogg", "done"],
      ["missing.ogg", "skipped"],
      ["call_001.ogg", "failed"],
      ["extra.ogg", "skipped"],
    ]);
    expect(view.files.find((f) => f.status === "failed")!.error).toBe(MOCK_DECODE_ERROR);
    for (const done of view.files.filter((f) => f.status === "done")) expect(resultSchema.safeParse(done.result).success).toBe(true);
  });

  it("refuses a new batch with 409 BATCH_PROCESSING while one is running", async () => {
    const { api, clock } = await submittedBatch();
    const again = api.createRun({ files: [{ name: "labels.csv", size: 10 }] });
    await expect(again).rejects.toMatchObject({ status: 409, code: "BATCH_PROCESSING" });
    await expect(again).rejects.toBeInstanceOf(ApiError);

    clock.advance(20_001);
    await expect(api.createRun({ files: [{ name: "labels.csv", size: 10 }] })).resolves.toHaveProperty("runId");
    expect((await api.listRuns()).runs).toHaveLength(1); // the old batch was deleted
  });

  it("needs partial=true before the batch is complete", async () => {
    const { api, runId } = await submittedBatch();
    await expect(api.getOutput(runId, "csv")).rejects.toMatchObject({ status: 409, code: "NOT_COMPLETE" });
  });

  it("downloads a CSV with name,result_json rows in manifest order", async () => {
    const blobs: Blob[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: (b: Blob) => (blobs.push(b), "blob:mock/1") }));
    const { api, clock, runId } = await submittedBatch();
    clock.advance(20_001);

    const { url, complete } = await api.getOutput(runId, "csv");
    expect(url).toBe("blob:mock/1");
    expect(complete).toBe(true);
    const text = await blobs[0]!.text();
    const lines = text.split("\r\n");
    expect(lines[0]).toBe("name,result_json");
    expect(lines.slice(1, -1).map((l) => (l.startsWith('"') ? l.slice(0, l.indexOf('",') + 1) : l.split(",")[0]))).toEqual([
      "call_002.ogg",
      '"call, 003.ogg"',
      "missing.ogg",
      "call_001.ogg",
    ]);
    expect(lines.at(-1)).toBe(""); // CRLF after the last row; extra.ogg isn't in the CSV
    expect(text).toContain('missing.ogg,"{""status"":""skipped"",""error"":""missing audio""}"');
    expect(text).toContain(`call_001.ogg,"{""status"":""failed"",""error"":""${MOCK_DECODE_ERROR}""}"`);

    const first = JSON.parse(lines[1]!.slice("call_002.ogg,".length).slice(1, -1).replace(/""/g, '"'));
    expect(resultSchema.safeParse(first).success).toBe(true);
  });
});
