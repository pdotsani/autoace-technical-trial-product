import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

import { getUserId } from "./auth";
import { ApiError, errorResponse, json, readJson } from "./http";
import { match } from "./router";

/** Lambda entry point for the API Gateway HTTP API (payload format 2.0). */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const started = Date.now();
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  let route = `${method} ${path}`;
  let runId: string | undefined;
  let response: APIGatewayProxyResultV2;

  try {
    const found = match(method, path);
    if (found.kind === "not_found") throw new ApiError(404, "NOT_FOUND", `no route for ${method} ${path}`);
    if (found.kind === "method_not_allowed") throw new ApiError(405, "METHOD_NOT_ALLOWED", `${method} is not allowed on ${path}`);
    route = `${found.route.method} ${found.route.pattern}`;
    runId = found.params.runId;

    const userId = getUserId(event);
    const result = await found.route.handler({
      userId,
      params: found.params,
      query: event.queryStringParameters ?? {},
      body: () => readJson(event),
      now: new Date(),
    });
    response = json(result.status, result.body);
  } catch (err) {
    if (err instanceof ApiError) {
      response = errorResponse(err);
    } else {
      // Log the error type and message only: never request bodies, file contents or URLs
      console.error(JSON.stringify({ level: "error", route, runId, error: (err as Error).name, message: (err as Error).message }));
      response = errorResponse(new ApiError(500, "INTERNAL", "internal error"));
    }
  }

  const status = typeof response === "object" ? response.statusCode : 200;
  console.log(JSON.stringify({ route, runId, status, durationMs: Date.now() - started, requestId: event.requestContext.requestId }));
  return response;
}
