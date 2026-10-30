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

Everything runs in one region. The steps are for a first deploy; steps 3 to 5 also show how
to deploy updates. The values below are the current deployment's. Bucket names are global, so
a new deployment needs its own.

```
browser ──> CloudFront ──> S3 site bucket          (the dashboard: static files)
   │
   ├──> Supabase                                   (sign-in; issues the access token)
   ├──> API Gateway ──> API Lambda ──> worker Lambda (one invocation per file)
   └──> S3 audio bucket (presigned PUT/GET)  <──────┘ results and metrics
```

You need: an AWS CLI profile that can manage IAM, S3, ECR, Lambda, API Gateway and
CloudFront; Docker; Node 22+; a Hugging Face token from an account that accepted the
pyannote model terms (for the worker image); and a Supabase project. Commands are zsh, run
from the repo root unless a step says otherwise.

```zsh
export AWS_REGION=us-east-2
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export BUCKET=audio-analyzer-s3-bucket        # audio uploads, results, run manifests
export SITE_BUCKET=autoace-dashboard-web      # the dashboard's static files
export WORKER_FUNCTION_NAME=autoace-worker
export WORKER_ROLE_NAME=autoace-worker-lambda
export ECR_REPO=autoace/audio-worker
export DEV_ORIGIN=http://localhost:5173
export SUPABASE_URL=https://<project-ref>.supabase.co
```

### 1. Supabase

In the Supabase dashboard:

1. **JWT signing key.** The API verifies tokens against the project's public keys, so the
   current signing key must be asymmetric (ES256 or RS256), not the legacy shared secret.
   This should list at least one key:
   `curl -s "${SUPABASE_URL}/auth/v1/.well-known/jwks.json"`.
2. **Who can sign in.** Turn off new user sign-ups and anonymous sign-ins. Anyone who can
   get an account can use the API, and the dashboard has no sign-up page by design.
3. **Users.** Create each user under Authentication → Users, with an email and password,
   and mark the email as confirmed.
4. Note the project URL and the **anon** (or publishable) key for step 5. Never use the
   `service_role` key in the dashboard.

### 2. Audio bucket

Holds everything under `runs/{userId}/{runId}/`: uploads, the run manifest, results,
metrics and output files ([api/README.md](api/README.md#s3-layout)). It stays private: the
browser and the worker only use short-lived presigned URLs.

```zsh
aws s3api create-bucket --bucket "${BUCKET}" --region "${AWS_REGION}" \
  --create-bucket-configuration LocationConstraint="${AWS_REGION}"
# New buckets already block public access, encrypt with SSE-S3 and disable ACLs; this makes the block explicit
aws s3api put-public-access-block --bucket "${BUCKET}" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

CORS for the browser's presigned uploads and downloads. `put-bucket-cors` replaces the
whole configuration; step 6 adds the dashboard's CloudFront origin.

```zsh
aws s3api put-bucket-cors --bucket "${BUCKET}" --cors-configuration "{\"CORSRules\":[{
  \"AllowedOrigins\":[\"${DEV_ORIGIN}\"],\"AllowedMethods\":[\"PUT\",\"GET\"],
  \"AllowedHeaders\":[\"*\"],\"ExposeHeaders\":[\"ETag\"],\"MaxAgeSeconds\":3000}]}"
```

Optional, and not set on the current deployment: expire runs after 30 days, so call
recordings aren't kept indefinitely. This also deletes a user's latest batch once it is 30
days old.

```zsh
aws s3api put-bucket-lifecycle-configuration --bucket "${BUCKET}" --lifecycle-configuration \
  '{"Rules":[{"ID":"expire-runs","Status":"Enabled","Filter":{"Prefix":"runs/"},"Expiration":{"Days":30}}]}'
```

### 3. Worker Lambda

The worker is a container image (about 4 GB compressed, models included). Image details:
[worker/README_worker.md](worker/README_worker.md#docker-image).

**Role.** Read uploads, write results and metrics, write logs:

```zsh
cat > /tmp/autoace-lambda-trust.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Principal": { "Service": "lambda.amazonaws.com" }, "Action": "sts:AssumeRole" }]
}
EOF
aws iam create-role --role-name "${WORKER_ROLE_NAME}" --assume-role-policy-document file:///tmp/autoace-lambda-trust.json
aws iam attach-role-policy --role-name "${WORKER_ROLE_NAME}" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

cat > /tmp/autoace-worker-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::${BUCKET}/runs/*" },
    { "Effect": "Allow", "Action": "s3:PutObject", "Resource": [
        "arn:aws:s3:::${BUCKET}/runs/*/results/*", "arn:aws:s3:::${BUCKET}/runs/*/metrics/*" ] }
  ]
}
EOF
aws iam put-role-policy --role-name "${WORKER_ROLE_NAME}" --policy-name autoace-worker-s3 \
  --policy-document file:///tmp/autoace-worker-policy.json
```

**Image.** Build for the Lambda's architecture (`linux/amd64` for x86_64, the current
deployment) and push to ECR. `--provenance=false` keeps the image a single-platform
manifest, which Lambda requires.

```zsh
aws ecr create-repository --repository-name "${ECR_REPO}"     # first time only
aws ecr get-login-password | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

export IMAGE="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}:$(git rev-parse --short HEAD)"
export HF_TOKEN=hf_...                  # or: export $(grep ^HF_TOKEN= worker/.env)
(cd worker && docker build --platform linux/amd64 --provenance=false \
  --secret id=hf_token,env=HF_TOKEN -t "${IMAGE}" .)
docker push "${IMAGE}"
```

**Function.** 10 GB of memory (Lambda's CPU share grows with memory), the 15-minute
maximum timeout and 4 GB of `/tmp`. New accounts can have lower limits, such as 3008 MB of
memory or 10 concurrent executions, and reserving 20 executions needs at least 100 others left
unreserved. Check `aws lambda get-account-settings` and request quota increases if needed.
An image function takes a few minutes to become active.

```zsh
aws lambda create-function --function-name "${WORKER_FUNCTION_NAME}" \
  --package-type Image --code ImageUri="${IMAGE}" --architectures x86_64 \
  --role "arn:aws:iam::${ACCOUNT_ID}:role/${WORKER_ROLE_NAME}" \
  --memory-size 10240 --timeout 900 --ephemeral-storage Size=4096 \
  --environment "Variables={BUCKET=${BUCKET},TORCH_NUM_THREADS=6,CUSTOMER_CHANNEL=1}"
aws lambda wait function-active-v2 --function-name "${WORKER_FUNCTION_NAME}"

# No automatic retries (the API marks a file "timed out" after 16 min; a late retry would
# overwrite that), and at most 20 files analyzed at once
aws lambda put-function-event-invoke-config --function-name "${WORKER_FUNCTION_NAME}" \
  --maximum-retry-attempts 0 --maximum-event-age-in-seconds 3600
aws lambda put-function-concurrency --function-name "${WORKER_FUNCTION_NAME}" --reserved-concurrent-executions 20
```

**Update:** build and push a new tag as above, then
`aws lambda update-function-code --function-name "${WORKER_FUNCTION_NAME}" --image-uri "${IMAGE}"`.

### 4. API Lambda and API Gateway

Follow [api/DEPLOY.md](api/DEPLOY.md) steps 1–3 (role, function, HTTP API) in the same
shell. Its commands run from `api/`, so `cd ..` back to the repo root afterwards. Its
variable block adds `API_FUNCTION_NAME` and `ROLE_NAME`, and its step 3 sets `API_ID` and
`API_URL`, which steps 5 to 7 here use. Step 4 there (bucket CORS) is already done in step 2
here. Use `AUTH_MODE=jwt` with `SUPABASE_URL` from the start; `AUTH_MODE=dev` leaves the API
open to anyone with its URL.

### 5. Dashboard (S3 + CloudFront)

A private bucket for the built files, served only through CloudFront (Origin Access
Control). The bucket is separate from the audio bucket.

```zsh
aws s3api create-bucket --bucket "${SITE_BUCKET}" --region "${AWS_REGION}" \
  --create-bucket-configuration LocationConstraint="${AWS_REGION}"

export OAC_ID=$(aws cloudfront create-origin-access-control --origin-access-control-config \
  "Name=${SITE_BUCKET},SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3" \
  --query OriginAccessControl.Id --output text)
```

The distribution: HTTP redirected to HTTPS, the managed CachingOptimized cache policy, and 403/404 mapped
to `/index.html` with status 200 so links like `/runs/<id>` reach the app's router instead
of S3's error page.

```zsh
cat > /tmp/autoace-distribution.json <<EOF
{
  "CallerReference": "autoace-dashboard-$(date +%s)",
  "Comment": "AutoAce dashboard",
  "Enabled": true,
  "DefaultRootObject": "index.html",
  "HttpVersion": "http2",
  "Origins": { "Quantity": 1, "Items": [{
    "Id": "site",
    "DomainName": "${SITE_BUCKET}.s3.${AWS_REGION}.amazonaws.com",
    "OriginAccessControlId": "${OAC_ID}",
    "S3OriginConfig": { "OriginAccessIdentity": "" }
  }]},
  "DefaultCacheBehavior": {
    "TargetOriginId": "site",
    "ViewerProtocolPolicy": "redirect-to-https",
    "CachePolicyId": "658327ea-f89d-4fab-a63d-7e88639e58f6",
    "Compress": true,
    "AllowedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] }
  },
  "CustomErrorResponses": { "Quantity": 2, "Items": [
    { "ErrorCode": 403, "ResponsePagePath": "/index.html", "ResponseCode": "200", "ErrorCachingMinTTL": 10 },
    { "ErrorCode": 404, "ResponsePagePath": "/index.html", "ResponseCode": "200", "ErrorCachingMinTTL": 10 }
  ]}
}
EOF
export DISTRIBUTION_ID=$(aws cloudfront create-distribution --distribution-config file:///tmp/autoace-distribution.json \
  --query Distribution.Id --output text)
export SITE_ORIGIN="https://$(aws cloudfront get-distribution --id "${DISTRIBUTION_ID}" --query Distribution.DomainName --output text)"

# Only this distribution may read the site bucket
aws s3api put-bucket-policy --bucket "${SITE_BUCKET}" --policy "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Effect\": \"Allow\",
    \"Principal\": { \"Service\": \"cloudfront.amazonaws.com\" },
    \"Action\": \"s3:GetObject\",
    \"Resource\": \"arn:aws:s3:::${SITE_BUCKET}/*\",
    \"Condition\": { \"ArnLike\": { \"AWS:SourceArn\": \"arn:aws:cloudfront::${ACCOUNT_ID}:distribution/${DISTRIBUTION_ID}\" } }
  }]
}"
```

**Build and upload** (also how to update the dashboard). `VITE_*` values are compiled into
the JavaScript and are public by design; variables set on the command line override
`web/.env.local`. Hashed assets are cached for a year; `index.html` is always revalidated.

```zsh
VITE_API_MODE=live VITE_API_URL="${API_URL}" VITE_AUTH_MODE=supabase \
VITE_SUPABASE_URL="${SUPABASE_URL}" VITE_SUPABASE_ANON_KEY="<anon key>" \
  npm run build -w web

aws s3 sync web/dist "s3://${SITE_BUCKET}" --delete --exclude index.html \
  --cache-control "public,max-age=31536000,immutable"
aws s3 cp web/dist/index.html "s3://${SITE_BUCKET}/index.html" --cache-control "no-cache"
aws cloudfront create-invalidation --distribution-id "${DISTRIBUTION_ID}" --paths /index.html
```

### 6. Allow the dashboard's origin

The browser calls the API and the audio bucket from `${SITE_ORIGIN}`, so both CORS lists
need it, alongside the local dev server. Without it the dashboard shows "could not reach the
API". With a custom domain, add `https://<that domain>` too.

```zsh
aws apigatewayv2 update-api --api-id "${API_ID}" --cors-configuration \
  "AllowOrigins=${DEV_ORIGIN},${SITE_ORIGIN},AllowMethods=GET,POST,OPTIONS,AllowHeaders=content-type,authorization,MaxAge=3600"

aws s3api put-bucket-cors --bucket "${BUCKET}" --cors-configuration "{\"CORSRules\":[{
  \"AllowedOrigins\":[\"${DEV_ORIGIN}\",\"${SITE_ORIGIN}\"],\"AllowedMethods\":[\"PUT\",\"GET\"],
  \"AllowedHeaders\":[\"*\"],\"ExposeHeaders\":[\"ETag\"],\"MaxAgeSeconds\":3000}]}"
```

### 7. Check it

```zsh
curl -s "${API_URL}/runs"     # -> 401 {"error":{"code":"UNAUTHORIZED","message":"sign in required"}}
```

Then open `${SITE_ORIGIN}` and [run a batch](#run-a-batch), or run one from the command line
with a token ([api/DEPLOY.md](api/DEPLOY.md#5-end-to-end-check)). Logs:
`aws logs tail /aws/lambda/autoace-api --follow` and
`aws logs tail /aws/lambda/${WORKER_FUNCTION_NAME} --follow`.

## Run a batch

1. **Sign in.** Open the dashboard (the CloudFront URL, or http://localhost:5173 with
   `npm run dev` and `web/.env.local` set up as in
   [web/README.md](web/README.md#against-the-deployed-api)) and sign in with the email and
   password of a Supabase user. There is no sign-up page; users are created in Supabase.
2. **Prepare the files.** One folder with the audio files (`.wav`, `.mp3`, `.ogg`, `.m4a`,
   `.flac`; up to 500 MB each) and exactly one CSV listing them. The `name` column must match
   each file name exactly. The optional `result_json` column holds the expected result as
   JSON in the result schema (`confidence` may be left out); labeled rows show up in an
   Expected table below the results. Files the CSV doesn't list are skipped.

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
`GET /runs/{runId}` for the Expected table, and never sent to the worker. Tests:
`shared/tests/validation.test.ts`, `npm test -w shared`.

The worker's results for the three labeled sample calls are checked separately by
`worker/tests/test_calls.py`; see [worker/README_worker.md](worker/README_worker.md#tests).
