# AutoAce call audio analysis

Backend for analyzing customer call recordings. An API Lambda accepts uploads and starts a
run; for each audio file it invokes the worker Lambda, which analyzes the file with a hybrid
pipeline of audio models (no LLM) and writes a JSON result matching
`shared/schema/result.schema.json` to S3: the customer's tone and intensity, background
noise, audio quality, speaker overlap and long silences. The web dashboard in `web/` uploads
batches and shows the results.

## Layout

```
worker/                  Python hybrid worker: the analysis pipeline and its Lambda adapter
api/                     API Lambda (TypeScript): runs, uploads, validation, worker fan-out, results
web/                     dashboard (Vite + React): upload a batch, watch progress, download results
shared/                  @autoace/shared: generated Zod schema, batch validation, API types, run status rules
  schema/                result.schema.json, the output contract shared by worker, API and web
docs/                    memo and reports, coming later
experiments/
  llm_baseline/          archived LLM experiment (Qwen2.5-Omni-7B); not used in production
package.json             npm workspaces: shared, api, web (one lockfile at the root)
DEPLOY.md                AWS setup: Supabase, buckets, worker, API, dashboard hosting
README.md
.gitignore
```

## Setup

TypeScript packages (Node 22 or later), from the repo root:

```zsh
npm install
npm run dev          # the dashboard on http://localhost:5173 (mock API unless web/.env.local says otherwise)
npm test             # shared, api and web
npm run typecheck
npm run gen:schema   # after changing shared/schema/result.schema.json
```

Dashboard details: [web/README.md](web/README.md). For the worker (Python), see
[worker/README_worker.md](worker/README_worker.md#run-locally).

## Deploy to AWS

Step-by-step setup of Supabase, the audio bucket, the worker and API Lambdas, and the
dashboard on S3 + CloudFront: [DEPLOY.md](DEPLOY.md).

## Run a batch

1. **Sign in.** Open the dashboard (the CloudFront URL, or http://localhost:5173 with
   `npm run dev` and `web/.env.local` set up as in
   [web/README.md](web/README.md#against-the-deployed-api)) and sign in with the email and
   password of a Supabase user. There is no sign-up page; users are created in Supabase.
2. **Prepare the files.** One folder with the audio files (`.wav`, `.mp3`, `.ogg`, `.m4a`,
   `.flac`; up to 500 MB each) and exactly one CSV listing them. The `name` column must match
   each file name exactly. The optional `result_json` column holds the expected result as
   JSON in the result schema (`confidence` may be left out); labeled files are compared with
   their results (step 7). Files the CSV doesn't list are skipped.

   ```csv
   name,result_json
   call_001.ogg,"{""emotional_tone"":""upset"",""emotional_intensity"":""high"",""background_noise_present"":false,""background_noise_type"":"""",""background_noise_severity"":""none"",""audio_quality"":""clear"",""speaker_overlap_present"":false,""long_silence_present"":false}"
   call_002.ogg,
   ```

3. **Add them.** Go to **New batch** and use **Choose folder**, **Choose ZIP** or **Choose
   files**, or drag a folder, ZIP or files onto the page. Hidden files and `__MACOSX` are
   ignored, and a ZIP with a single top-level folder is flattened.
4. **Check the validation.** It runs in the browser before anything is uploaded. **Blocking**
   problems (no CSV or more than one, duplicate names, no audio file matching a CSV row) must
   be fixed; **warnings** (an invalid label, an empty row) don't stop the batch. Remove a file
   from the staged list with **Remove**.
5. **Replace the previous batch.** Each account keeps one batch. If you have one, download
   its results first, then tick "I understand my previous batch and its results will be
   deleted". A batch that is still processing can't be replaced; wait for it to finish.
6. **Analyze.** Uploads the files (4 at a time, with progress), validates them again on the
   server, starts one worker per file and opens the batch's results page.
7. **Watch it run.** The page refreshes every 3 seconds. Each file is `processing`, `done`,
   `failed` (with the reason) or `skipped`. A file usually takes one to a few minutes, longer
   on a cold start; one with no result after 16 minutes is marked `failed` / `timed out`.
   Confidence is shaded from amber (0%) to green (100%). In a labeled batch, each finished
   labeled file is compared with its label: matching fields are green, differing ones red
   with the expected value underneath, the **Matches** column counts matching fields (8 are
   compared, not confidence), and a **Matched** row totals each field across the labeled
   files. The noise type is free text, so case and outer spaces are ignored. The labels
   themselves are listed in an **Expected** table below.
8. **Download the results.** When every file has finished, **Download CSV** gives
   `name,result_json` rows in the CSV's order, and **Download JSON** the same as a list.
   Before that, **Download partial results (CSV)** gives what's done so far. Download links
   expire after 15 minutes; click again for a new one.
9. **Come back later** from **Results**, and **Sign out** from the header when you're done.

## Validation

A batch is checked by `validateBatch` in `shared/src/validation/`, the same code in two
places:

- **In the browser**, on the New batch page, as files are added and before anything is
  uploaded. Analyze stays disabled while there is a blocking error.
- **In the API**, on `POST /runs/{runId}/validate`, against what actually landed in S3. This
  report is the one that counts: the API writes the run manifest from it, and
  `/analyze` only starts files it matched. A client that skips the dashboard is still checked.

**Blocking** (nothing is analyzed until fixed):

| Check | Message |
|---|---|
| Exactly one CSV | `no CSV file: …` / `2 CSV files (…): the batch needs exactly one` |
| CSV size (5 MB, `MAX_CSV_MB`) | `CSV labels.csv is larger than 5 MB` |
| CSV parses and has a `name` column | `CSV could not be parsed: …` / `CSV is empty` / `CSV has no "name" column` |
| Unique names | `duplicate file name: …` / `duplicate name in CSV: …` |
| At least one audio file matches a CSV row | `no audio file matches a CSV row` |

**Skipped** (the rest of the batch still runs; each file shows its reason):

| Case | Reason shown |
|---|---|
| CSV row with no audio file | `missing audio` |
| Audio file with no CSV row | `unmatched audio: no CSV row` |
| Not `.wav` `.mp3` `.ogg` `.m4a` `.flac` (`SUPPORTED_AUDIO`) | `ignored: unsupported type` |
| Over 500 MB (`MAX_AUDIO_MB`), or empty | `larger than 500 MB` / `empty file` |
| Name contains `/` or `\`, or starts with `.` | `invalid name: …` |

Names must match exactly, including case and spaces. When they differ only in case, the
reason suggests the other name (`did you mean "Call_001.ogg"?`). Hidden files, `.DS_Store`
and `__MACOSX` entries are dropped without a report.

**Warnings** (don't stop the batch):

- A row with an empty `name` is ignored.
- A `result_json` that isn't valid JSON, or doesn't fit the label schema, is reported and
  that row is treated as unlabeled. The label schema is the result schema with `confidence`
  optional; when `background_noise_present` is false, `background_noise_type` must be `""`
  and `background_noise_severity` must be `none`.
- An all-empty `result_json` column makes the batch unlabeled.

Valid labels are stored in the run manifest as `expected`, returned per file by
`GET /runs/{runId}` for the results comparison and the Expected table, and never sent to
the worker. Tests:
`shared/tests/validation.test.ts`, `npm test -w shared`.

The worker's results for the three labeled sample calls are checked separately by
`worker/tests/test_calls.py`; see [worker/README_worker.md](worker/README_worker.md#tests).
