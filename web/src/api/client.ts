import type {
  AnalyzeRunResponse,
  ApiErrorCode,
  CreateRunRequest,
  CreateRunResponse,
  GetOutputResponse,
  GetRunResponse,
  ListRunsResponse,
  OutputFormat,
  UploadTarget,
  ValidateRunResponse,
} from "@autoace/shared/api-types";

/** One method per API route, plus the presigned upload. Implemented by live.ts and mock.ts. */
export interface ApiClient {
  readonly mode: "mock" | "live";
  /** POST /runs */
  createRun(body: CreateRunRequest): Promise<CreateRunResponse>;
  /** PUT to a presigned URL from createRun, with exactly the headers it returned. */
  upload(target: UploadTarget, file: Blob, onProgress?: (fraction: number) => void): Promise<void>;
  /** POST /runs/{runId}/validate */
  validateRun(runId: string): Promise<ValidateRunResponse>;
  /** POST /runs/{runId}/analyze */
  analyzeRun(runId: string): Promise<AnalyzeRunResponse>;
  /** GET /runs/{runId} */
  getRun(runId: string): Promise<GetRunResponse>;
  /** GET /runs/{runId}/output?format=csv|json[&partial=true] */
  getOutput(runId: string, format: OutputFormat, partial?: boolean): Promise<GetOutputResponse>;
  /** GET /runs */
  listRuns(): Promise<ListRunsResponse>;
}

/** An error response from the API (`{error: {code, message, details?}}`) or a network failure. */
export class ApiError extends Error {
  constructor(
    readonly status: number, // 0 for network errors
    readonly code: ApiErrorCode | "NETWORK" | "UPLOAD_FAILED",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
