# API Lambda

TypeScript Lambda (Node.js 22) behind an API Gateway HTTP API (payload format 2.0). It creates
runs, hands out presigned upload URLs, validates the batch against its CSV, fans the audio out
to the worker Lambda (`autoace-worker`), and reports status and results. Deployment:
[DEPLOY.md](DEPLOY.md).

## Routes

Errors are `{ "error": { "code", "message", "details"? } }` with a matching status code.
The user ID comes only from `src/auth.ts`. With `AUTH_MODE=jwt` it is the `sub` of the Supabase
access token in `Authorization: Bearer <token>`, verified in the Lambda against the project's
JWKS (issuer `${SUPABASE_URL}/auth/v1`, audience `JWT_AUDIENCE`); a missing or invalid token
gets 401 `UNAUTHORIZED`. With `AUTH_MODE=dev` every request is `DEV_USER_ID` (no auth).

| Route | Does | Notable responses |
|---|---|---|
| `POST /runs` `{files: [{name, size, contentType}]}` | Checks names, types, sizes and the CSV count; deletes the user's earlier runs; returns `{runId, uploads: [{name, url, headers}], report}` | 400 `INVALID_BATCH`, 409 `BATCH_PROCESSING` |
| `POST /runs/{runId}/validate` | Reads the uploaded CSV, matches it to the uploaded audio, writes `manifest.json`, returns the report | 404 `RUN_NOT_FOUND`, 409 `ALREADY_SUBMITTED` |
| `POST /runs/{runId}/analyze` | Invokes the worker once per valid file (async, ≤ 10 in flight); returns counts | 409 `NOT_VALIDATED`, `NOT_ANALYZABLE`, `ALREADY_SUBMITTED` |
| `GET /runs/{runId}` | Per-file `done` / `failed` / `skipped` / `processing`, counts, `complete` | 409 `NOT_VALIDATED` |
| `GET /runs/{runId}/output?format=csv\|json[&partial=true]` | Writes `outputs/results_{runId}.csv\|json` with exactly the given CSV's rows, in its order (`name,result_json`, the prediction as compact JSON); returns `{url}` (presigned download) | 409 `NOT_COMPLETE` |
| `GET /runs` | The user's runs, newest first, with counts | |

- **Retention:** each user keeps one run. `POST /runs` deletes everything under
  `runs/{userId}/` unless an earlier run still has a file processing (submitted, no result,
  younger than `STALE_AFTER_SEC`).
- **Timed out:** a submitted file with no result after `STALE_AFTER_SEC` reports
  `failed` / `timed out`.
- **Labels:** the CSV's `result_json` labels are stored in the manifest as `expected` (for
  scoring later). `GET /runs/{runId}` returns them per file, so the dashboard can show them
  next to the results. They are never sent to the worker.
- **CORS:** no CORS headers come from the Lambda. API Gateway's CORS configuration handles
  them, and the bucket has its own CORS rule for the presigned PUTs (see DEPLOY.md).

## S3 layout

```
runs/{userId}/{runId}/input/{name}           uploaded audio and the CSV
runs/{userId}/{runId}/manifest.json          written by /validate, updated by /analyze
runs/{userId}/{runId}/results/{name}.json    written by the worker
runs/{userId}/{runId}/metrics/{name}.json    written by the worker
runs/{userId}/{runId}/outputs/results_{runId}.csv|json
```

`runId` is `YYYYMMDDTHHMMSSZ-` plus 20 random hex characters: sortable by time and unguessable.

## Code

```
src/index.ts         Lambda handler: routing, errors, one JSON log line per request
src/router.ts        method + path matching for the six routes
src/routes.ts        route handlers
src/manifest.ts      re-exports the manifest types and status rules from @autoace/shared/runs
src/store.ts         S3 key layout and helpers (list, delete, get/put JSON, presign)
src/config.ts        env vars, validated with zod at cold start
src/auth.ts          getUserId (Supabase JWT, or dev mode)
```

Shared with the web app, in [`shared/`](../shared) (`@autoace/shared`):

```
shared/src/api-types.ts   request and response types of every route (routes.ts checks its bodies with `satisfies`)
shared/src/runs.ts        manifest, status rules (done / failed / skipped / processing / timed out), output rows
shared/src/validation/    batch and CSV validation: pure TypeScript, no AWS imports
shared/src/schema.ts      GENERATED from shared/schema/result.schema.json (npm run gen:schema)
```

## Scripts

`api/` is an npm workspace: install from the repo root, which has the one lockfile.

```bash
npm ci                          # at the repo root
npm run gen:schema              # at the root: regenerate shared/src/schema.ts after changing result.schema.json
cd api
npm run typecheck
npm test             # vitest; S3 and Lambda mocked with aws-sdk-client-mock
npm run build        # esbuild -> dist/index.mjs
npm run zip          # build + dist/function.zip
API_URL=... scripts/e2e.sh <folder>   # full flow against a deployed API (curl + jq)
```
