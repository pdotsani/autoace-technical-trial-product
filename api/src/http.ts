import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import type { z } from "zod";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function json(status: number, body: unknown): APIGatewayProxyResultV2 {
  // No CORS headers here: API Gateway's CORS configuration adds them.
  return { statusCode: status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export function errorResponse(err: ApiError): APIGatewayProxyResultV2 {
  const error: Record<string, unknown> = { code: err.code, message: err.message };
  if (err.details !== undefined) error.details = err.details;
  return json(err.status, { error });
}

export function readJson(event: APIGatewayProxyEventV2): unknown {
  try {
    const text = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "");
    return JSON.parse(text || "{}");
  } catch {
    throw new ApiError(400, "INVALID_JSON", "request body is not valid JSON");
  }
}

export function checkBody<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new ApiError(400, "INVALID_REQUEST", message);
  }
  return parsed.data;
}
