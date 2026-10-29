import type { APIGatewayProxyEventV2 } from "aws-lambda";

import { config } from "./config";
import { ApiError } from "./http";

/**
 * The caller's user ID. Every route gets the user ID ONLY from here, never from the request
 * body or path.
 *
 * TODO(auth): replace dev mode with event.requestContext.authorizer.jwt.claims.sub, the
 * Supabase user ID from a JWT verified by an API Gateway JWT authorizer (the event type then
 * becomes APIGatewayProxyEventV2WithJWTAuthorizer). Until then the API is open to anyone with
 * its URL.
 */
export function getUserId(_event: APIGatewayProxyEventV2): string {
  if (config.AUTH_MODE === "dev") return config.DEV_USER_ID;
  throw new ApiError(500, "AUTH_NOT_CONFIGURED", "auth not configured");
}
