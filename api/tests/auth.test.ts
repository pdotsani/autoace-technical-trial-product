// AUTH_MODE=jwt: Supabase access tokens verified in the Lambda against the project's JWKS.
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { handler } from "../src/index";

const SUPABASE_URL = "https://test-project.supabase.co";
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const SUB = "3f0c6a8e-1b2d-4c5e-8f9a-0b1c2d3e4f5a";
const KID = "test-key";

const s3Mock = mockClient(S3Client);
let privateKey: CryptoKey;
let otherKey: CryptoKey; // signs tokens the JWKS doesn't know

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair("ES256")).privateKey;
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: KID, alg: "ES256", use: "sig" }] };
  vi.stubGlobal("fetch", async (url: string | URL) => {
    if (String(url) !== `${ISSUER}/.well-known/jwks.json`) throw new Error(`unexpected fetch ${String(url)}`);
    return new Response(JSON.stringify(jwks), { headers: { "content-type": "application/json" } });
  });
  Object.assign(config, { AUTH_MODE: "jwt", SUPABASE_URL });
});

afterAll(() => {
  vi.unstubAllGlobals();
  Object.assign(config, { AUTH_MODE: "dev", SUPABASE_URL: undefined });
});

beforeEach(() => {
  s3Mock.reset();
  s3Mock.on(ListObjectsV2Command).resolves({ CommonPrefixes: [], Contents: [] });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

function token({ key = privateKey, issuer = ISSUER, audience = "authenticated", sub = SUB, expiresIn = "1h", claims = {} } = {}) {
  return new SignJWT({ role: "authenticated", ...claims })
    .setProtectedHeader({ alg: "ES256", kid: KID })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

async function call(method: string, path: string, authorization?: string) {
  const event = {
    rawPath: path,
    headers: authorization === undefined ? {} : { authorization },
    isBase64Encoded: false,
    requestContext: { http: { method }, requestId: "req-1" },
  } as unknown as APIGatewayProxyEventV2;
  const res = (await handler(event)) as APIGatewayProxyStructuredResultV2;
  return { status: res.statusCode, body: res.body ? JSON.parse(String(res.body)) : undefined };
}

describe("AUTH_MODE=jwt", () => {
  it("uses the verified token's sub as the user ID", async () => {
    const res = await call("GET", "/runs", `Bearer ${await token()}`);
    expect(res.status).toBe(200);
    expect(s3Mock.commandCalls(ListObjectsV2Command)[0]!.args[0].input.Prefix).toBe(`runs/${SUB}/`);
  });

  it("refuses a request without a token", async () => {
    const res = await call("GET", "/runs");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
    expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
  });

  // Functions, because the keys only exist once beforeAll has run
  it.each([
    ["an unknown signing key", () => ({ key: otherKey })],
    ["another issuer", () => ({ issuer: "https://other.supabase.co/auth/v1" })],
    ["another audience", () => ({ audience: "anon" })],
    ["an expired token", () => ({ expiresIn: "-1m" })],
    ["an anonymous user", () => ({ claims: { is_anonymous: true } })],
    ["a subject that isn't a UUID", () => ({ sub: "../other-user" })],
  ])("refuses %s", async (_name, options) => {
    const res = await call("GET", "/runs", `Bearer ${await token(options())}`);
    expect(res.status).toBe(401);
    expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
  });

  it("refuses a malformed header", async () => {
    expect((await call("GET", "/runs", "Bearer not-a-jwt")).status).toBe(401);
    expect((await call("GET", "/runs", `Basic ${await token()}`)).status).toBe(401);
  });

  it("still answers browser preflights without a token", async () => {
    expect((await call("OPTIONS", "/runs")).status).toBe(204);
  });
});
