import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { s3 } from "./aws";
import { config } from "./config";

// S3 layout, all under runs/{userId}/{runId}/:
//   input/{name}  manifest.json  results/{name}.json  metrics/{name}.json  outputs/results_{runId}.csv|json
export const keys = {
  user: (userId: string) => `runs/${userId}/`,
  run: (userId: string, runId: string) => `runs/${userId}/${runId}/`,
  input: (userId: string, runId: string, name = "") => `runs/${userId}/${runId}/input/${name}`,
  manifest: (userId: string, runId: string) => `runs/${userId}/${runId}/manifest.json`,
  results: (userId: string, runId: string) => `runs/${userId}/${runId}/results/`,
  output: (userId: string, runId: string, ext: string) => `runs/${userId}/${runId}/outputs/results_${runId}.${ext}`,
};

export interface ListedObject {
  key: string;
  size: number;
}

export async function listObjects(prefix: string): Promise<ListedObject[]> {
  const objects: ListedObject[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: config.BUCKET, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of page.Contents ?? []) if (o.Key) objects.push({ key: o.Key, size: o.Size ?? 0 });
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return objects;
}

/** The immediate "sub-folders" of prefix, e.g. run IDs under runs/{userId}/. */
export async function listFolders(prefix: string): Promise<string[]> {
  const folders: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: config.BUCKET, Prefix: prefix, Delimiter: "/", ContinuationToken: token }),
    );
    for (const p of page.CommonPrefixes ?? []) if (p.Prefix) folders.push(p.Prefix.slice(prefix.length, -1));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return folders;
}

export async function prefixExists(prefix: string): Promise<boolean> {
  const page = await s3.send(new ListObjectsV2Command({ Bucket: config.BUCKET, Prefix: prefix, MaxKeys: 1 }));
  return (page.KeyCount ?? page.Contents?.length ?? 0) > 0;
}

export async function deletePrefix(prefix: string): Promise<number> {
  const objects = await listObjects(prefix);
  for (let i = 0; i < objects.length; i += 1000) {
    const batch = objects.slice(i, i + 1000);
    const out = await s3.send(
      new DeleteObjectsCommand({
        Bucket: config.BUCKET,
        Delete: { Objects: batch.map((o) => ({ Key: o.key })), Quiet: true },
      }),
    );
    if (out.Errors?.length) throw new Error(`could not delete ${out.Errors.length} objects under ${prefix}`);
  }
  return objects.length;
}

function isMissing(err: unknown): boolean {
  // With s3:ListBucket limited by a prefix condition, S3 can answer 403 instead of 404 for a
  // missing key; both mean "not there" for our own keys.
  return err instanceof S3ServiceException && [403, 404].includes(err.$metadata.httpStatusCode ?? 0);
}

export async function getText(key: string): Promise<{ text: string; etag?: string } | null> {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: config.BUCKET, Key: key }));
    return { text: (await out.Body?.transformToString("utf-8")) ?? "", etag: out.ETag };
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

export async function getJson<T>(key: string): Promise<{ value: T; etag?: string } | null> {
  const got = await getText(key);
  return got ? { value: JSON.parse(got.text) as T, etag: got.etag } : null;
}

export class PreconditionFailed extends Error {}

/** Write compact JSON. With ifMatch, fail with PreconditionFailed if the object changed meanwhile. */
export async function putJson(key: string, value: unknown, ifMatch?: string): Promise<void> {
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: config.BUCKET,
        Key: key,
        Body: JSON.stringify(value),
        ContentType: "application/json",
        IfMatch: ifMatch,
      }),
    );
  } catch (err) {
    if (err instanceof S3ServiceException && [409, 412].includes(err.$metadata.httpStatusCode ?? 0)) {
      throw new PreconditionFailed(key);
    }
    throw err;
  }
}

export async function putText(key: string, body: string, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: config.BUCKET, Key: key, Body: body, ContentType: contentType }));
}

export function presignPut(key: string, contentType: string): Promise<string> {
  return getSignedUrl(s3, new PutObjectCommand({ Bucket: config.BUCKET, Key: key, ContentType: contentType }), {
    expiresIn: config.PUT_URL_EXPIRES,
  });
}

export function presignGet(key: string, expiresIn: number, download?: { filename: string; contentType: string }): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: config.BUCKET,
      Key: key,
      ResponseContentDisposition: download ? `attachment; filename="${download.filename}"` : undefined,
      ResponseContentType: download?.contentType,
    }),
    { expiresIn },
  );
}

/** Run fn over items with at most `limit` calls in flight; results keep the input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}
