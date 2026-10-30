# AutoAce dashboard (web/)

Vite + React + TypeScript. Sign in, stage a batch (one CSV plus the audio files it lists),
see validation before anything is uploaded, run it, watch progress and download the results.

It talks to the API only through the `ApiClient` interface (`src/api/client.ts`). Two
implementations follow the same contract: `src/api/live.ts` (the deployed API) and
`src/api/mock.ts` (in memory, in the browser). `VITE_API_MODE` picks one.

## Run in mock mode

From the repo root (npm workspaces: `shared`, `api`, `web`):

```zsh
npm install
npm run dev -w web       # http://localhost:5173
```

With no `.env.local`, the app runs in mock mode. The header shows a **Mock API** badge.

- **Sign in** with any email and password.
- **New batch:** add one CSV and the audio files it lists. Use "Choose folder", "Choose ZIP"
  or "Choose files", or drag a folder, a ZIP or files onto the page. For example, put
  `call_001.ogg`, `call_002.ogg`, `call_003.ogg` and a `labels.csv` in one folder:

  ```csv
  name,result_json
  call_001.ogg,
  call_002.ogg,
  call_003.ogg,
  ```

- **Analyze:** creates the run, uploads the files with per-file progress (4 at a time),
  validates and starts the analysis, then opens the run page.
- **Run page:** polls every 3 s. Each file finishes 10–20 s after Analyze. With two or more
  files, the last one fails with `decode failed: audio could not be decoded`, so the failed
  state can be seen.
- **Download CSV / JSON:** the mock builds the file in the browser (a `blob:` URL), in the
  API's format: `name,result_json`, the CSV's rows in its order.

The mock keeps runs in memory, so reloading the page starts over. Like the API, it keeps one
batch per user and refuses a new one while a batch is processing (409 `BATCH_PROCESSING`).

```zsh
npm run test -w web        # vitest + Testing Library (jsdom)
npm run typecheck -w web
npm run lint -w web        # oxlint: typescript-eslint doesn't support TypeScript 7 yet
npm run build -w web       # -> web/dist
npm run preview -w web     # serve the build
```

## Environment

Copy `.env.example` to `.env.local` (ignored by git). Every `VITE_*` value is compiled into the
JavaScript bundle and anyone can read it, so only public values go here.

| Variable | Values | Meaning |
|---|---|---|
| `VITE_API_MODE` | `mock` (default), `live` | Which `ApiClient` to use |
| `VITE_API_URL` | `https://<api-id>.execute-api.us-east-2.amazonaws.com` | The API Gateway endpoint, for `live` |
| `VITE_AUTH_MODE` | `mock` (default), `supabase` | Fake sign-in, or Supabase email/password |
| `VITE_SUPABASE_URL` | `https://<project>.supabase.co` | For `supabase` auth |
| `VITE_SUPABASE_ANON_KEY` | the anon key | Public by design. Never the `service_role` key. |

`VITE_AUTH_MODE` is separate from `VITE_API_MODE`. An API with `AUTH_MODE=dev` ignores the
token, so mock sign-in works against it; an API with `AUTH_MODE=jwt` needs `supabase`.

## Against the deployed API

Set these in `.env.local` (Vite reads it at start-up, so restart `npm run dev` after a change):

```zsh
VITE_API_MODE=live
VITE_API_URL=https://<api-id>.execute-api.us-east-2.amazonaws.com
VITE_AUTH_MODE=supabase
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon or publishable key>
```

- **Auth.** `SupabaseAuthProvider` (`src/auth/AuthContext.tsx`) signs in with
  `signInWithPassword` and sends the session's access token as `Authorization: Bearer`.
  There is no sign-up page: users are created in the Supabase dashboard.
- **CORS.** The API and the audio bucket both allow `http://localhost:5173`. The dev server
  uses that port with `strictPort`, so a busy port fails instead of moving to an origin CORS
  doesn't allow.
- **No Mock API badge.** If the header still shows **Mock API**, `VITE_API_MODE` isn't
  `live`. An unknown value (a typo, or `supabase`) falls back to mock without an error, and
  the mock fails the last file of each batch on purpose.

## Deployment

The dashboard is served from a private S3 bucket through CloudFront. Creating the bucket and
distribution, the build command, the upload and the CORS origins are in the root
[DEPLOY.md](../DEPLOY.md#5-dashboard-s3--cloudfront).

## Code

```
src/api/client.ts         ApiClient interface (one method per route, plus upload) and ApiError
src/api/live.ts           fetch against VITE_API_URL; XMLHttpRequest PUTs for upload progress
src/api/mock.ts           in-memory API using @autoace/shared's validation and status rules
src/api/uploads.ts        uploads, 4 at a time
src/api/ApiContext.tsx    picks the implementation from VITE_API_MODE
src/auth/AuthContext.tsx  { user, getToken, signIn, signOut }: mock or Supabase
src/staging/files.ts      folder / ZIP / drag-and-drop to staged files (skips hidden files and __MACOSX,
                          flattens a single top-level folder)
src/staging/report.ts     summary line and the Analyze gating rules
src/pages/                Login, New batch, Run, Runs
src/styles.css            CSS variables, light and dark via prefers-color-scheme
```

The CSV is parsed by `@autoace/shared`'s validation, the same code the API runs.
`vite.config.ts` aliases `csv-parse/sync` to its browser build, because the default build
needs Node's `Buffer`.
