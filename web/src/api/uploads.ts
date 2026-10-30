import type { UploadTarget } from "@autoace/shared/api-types";

import { errorMessage, type ApiClient } from "./client";

export const UPLOAD_CONCURRENCY = 4;

/** Upload every target, at most UPLOAD_CONCURRENCY at a time; returns {name: error} for failures. */
export async function uploadAll(
  client: ApiClient,
  targets: UploadTarget[],
  fileFor: (name: string) => Blob | undefined,
  onProgress: (name: string, fraction: number) => void,
): Promise<Record<string, string>> {
  const failures: Record<string, string> = {};
  let next = 0;
  async function lane() {
    while (next < targets.length) {
      const target = targets[next++]!;
      const file = fileFor(target.name);
      if (!file) {
        failures[target.name] = "file is no longer staged";
        continue;
      }
      try {
        await client.upload(target, file, (f) => onProgress(target.name, f));
      } catch (err) {
        failures[target.name] = errorMessage(err);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, targets.length) }, lane));
  return failures;
}
