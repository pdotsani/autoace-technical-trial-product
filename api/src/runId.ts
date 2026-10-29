import { randomBytes } from "node:crypto";

// e.g. 20261029T184359Z-3f9c0a7d1e5b42c8a6d0: sortable by time, 80 random bits after the dash
const RUN_ID = /^\d{8}T\d{6}Z-[0-9a-f]{20}$/;

export function newRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return `${stamp}-${randomBytes(10).toString("hex")}`;
}

export function isRunId(value: string): boolean {
  return RUN_ID.test(value);
}

/** The creation time encoded in a run ID, as ISO 8601. */
export function runCreatedAt(runId: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(runId);
  if (!m) throw new Error(`not a run ID: ${runId}`);
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}
