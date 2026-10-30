import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";

import { config } from "./config";
import { ApiError } from "./http";

// Supabase user IDs are UUIDs. The ID becomes part of S3 keys, so nothing else is accepted.
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Kept across warm invocations. jose caches the keys and refetches when a token names a key
// ID it hasn't seen, so Supabase key rotation needs no redeploy.
let keys: JWTVerifyGetKey | undefined;

/**
 * The caller's user ID. Every route gets the user ID ONLY from here, never from the request
 * body or path.
 *
 * AUTH_MODE=jwt: the `sub` of a Supabase access token from "Authorization: Bearer <token>",
 * verified here against the project's published keys (JWKS), issuer and audience. This runs
 * in the Lambda rather than in an API Gateway JWT authorizer because the API's $default route
 * (made by quick create) can't be deleted or given an authorizer, so it would let requests
 * through unchecked. AUTH_MODE=dev: no auth, every request is DEV_USER_ID.
 */
export async function getUserId(event: APIGatewayProxyEventV2): Promise<string> {
  if (config.AUTH_MODE === "dev") return config.DEV_USER_ID;

  const token = /^Bearer (\S+)$/i.exec(event.headers?.authorization ?? "")?.[1];
  if (!token) throw new ApiError(401, "UNAUTHORIZED", "sign in required");

  const issuer = `${config.SUPABASE_URL}/auth/v1`;
  keys ??= createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  let payload;
  try {
    ({ payload } = await jwtVerify(token, keys, { issuer, audience: config.JWT_AUDIENCE, algorithms: ["ES256", "RS256"] }));
  } catch (err) {
    // A bad, expired or foreign token is the caller's problem; failing to fetch the keys is ours
    if (err instanceof errors.JOSEError && !(err instanceof errors.JWKSTimeout)) {
      throw new ApiError(401, "UNAUTHORIZED", "invalid or expired token");
    }
    throw err;
  }
  if (payload.is_anonymous === true) throw new ApiError(401, "UNAUTHORIZED", "anonymous sign-ins are not allowed");
  if (typeof payload.sub !== "string" || !USER_ID.test(payload.sub)) throw new ApiError(401, "UNAUTHORIZED", "invalid token subject");
  return payload.sub;
}
