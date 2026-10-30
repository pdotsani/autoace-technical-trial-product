import type { ApiErrorBody, OutputFormat, UploadTarget } from "@autoace/shared/api-types";

import { ApiError, type ApiClient } from "./client";

/**
 * The deployed API (API Gateway HTTP API). Every request carries "Authorization: Bearer
 * <token>" from the auth context. Presigned URLs are never logged.
 */
export function createLiveApi(baseUrl: string, getToken: () => Promise<string | null>): ApiClient {
  async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    if (!baseUrl) throw new ApiError(0, "NETWORK", "VITE_API_URL is not set (needed when VITE_API_MODE=live)");
    const headers: Record<string, string> = {};
    const token = await getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, "NETWORK", "could not reach the API: check your connection");
    }
    const text = await res.text();
    const data: unknown = text ? safeJson(text) : null;
    if (!res.ok) {
      const error = (data as ApiErrorBody | null)?.error;
      throw new ApiError(res.status, error?.code ?? "INTERNAL", error?.message ?? `HTTP ${res.status}`, error?.details);
    }
    return data as T;
  }

  return {
    mode: "live",
    createRun: (body) => request("POST", "/runs", body),
    upload: (target, file, onProgress) => putWithProgress(target, file, onProgress),
    validateRun: (runId) => request("POST", `/runs/${encodeURIComponent(runId)}/validate`),
    analyzeRun: (runId) => request("POST", `/runs/${encodeURIComponent(runId)}/analyze`),
    getRun: (runId) => request("GET", `/runs/${encodeURIComponent(runId)}`),
    getOutput: (runId: string, format: OutputFormat, partial = false) =>
      request("GET", `/runs/${encodeURIComponent(runId)}/output?format=${format}${partial ? "&partial=true" : ""}`),
    listRuns: () => request("GET", "/runs"),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** XMLHttpRequest rather than fetch: fetch has no upload progress events. */
function putWithProgress(target: UploadTarget, file: Blob, onProgress?: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", target.url);
    for (const [name, value] of Object.entries(target.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve();
      } else {
        const hint = xhr.status === 403 ? " (upload link expired or invalid)" : "";
        reject(new ApiError(xhr.status, "UPLOAD_FAILED", `upload failed: HTTP ${xhr.status}${hint}`));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "UPLOAD_FAILED", "upload failed: network error or blocked by CORS"));
    xhr.onabort = () => reject(new ApiError(0, "UPLOAD_FAILED", "upload cancelled"));
    xhr.send(file);
  });
}
