# Deploying the API Lambda

Region `us-east-2`, account `995371346723`. All commands are for zsh and use `${VAR}` with
braces. Run them from `api/` with an AWS CLI profile that can manage IAM, Lambda, API Gateway
and the bucket.

```zsh
export AWS_REGION=us-east-2
export ACCOUNT_ID=995371346723
export BUCKET=audio-analyzer-s3-bucket
export WORKER_FUNCTION_NAME=autoace-worker
export API_FUNCTION_NAME=autoace-api
export ROLE_NAME=autoace-api-lambda
export DEV_ORIGIN=http://localhost:5173
```

> **Warning.** While `AUTH_MODE=dev` the API has no authentication: anyone with its URL can
> create runs, upload files and read results (all as `DEV_USER_ID`). Keep the URL private, and
> switch to `AUTH_MODE=jwt` with `SUPABASE_URL` (see `src/auth.ts`) before sharing the
> dashboard. The token is checked in the Lambda, not by an API Gateway authorizer, so it also
> covers requests that reach the Lambda through a `$default` route.

## 1. IAM role `autoace-api-lambda`

```zsh
cat > /tmp/autoace-api-trust.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Principal": { "Service": "lambda.amazonaws.com" }, "Action": "sts:AssumeRole" }]
}
EOF

aws iam create-role --role-name "${ROLE_NAME}" \
  --assume-role-policy-document file:///tmp/autoace-api-trust.json

aws iam attach-role-policy --role-name "${ROLE_NAME}" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

cat > /tmp/autoace-api-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "RunObjects",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::${BUCKET}/runs/*"
    },
    {
      "Sid": "ListRuns",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::${BUCKET}",
      "Condition": { "StringLike": { "s3:prefix": "runs/*" } }
    },
    {
      "Sid": "InvokeWorker",
      "Effect": "Allow",
      "Action": "lambda:InvokeFunction",
      "Resource": [
        "arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:${WORKER_FUNCTION_NAME}",
        "arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:${WORKER_FUNCTION_NAME}:*"
      ]
    }
  ]
}
EOF

aws iam put-role-policy --role-name "${ROLE_NAME}" --policy-name autoace-api-access \
  --policy-document file:///tmp/autoace-api-policy.json
```

The presigned URLs the API hands out (browser uploads, worker downloads, result downloads)
are signed with this role, so its `s3:PutObject` / `s3:GetObject` are what they use.
`DeleteObject` covers `DeleteObjects` (the retention rule).

## 2. The Lambda function

Build the bundle. `api/` is an npm workspace, so install from the repo root (one lockfile
there); esbuild bundles `@autoace/shared` into the zip.

```zsh
(cd .. && npm ci)
npm test
npm run zip        # -> dist/function.zip
```

Environment variables. These go in a JSON file because `SUPPORTED_AUDIO` contains commas,
which the CLI's `Key=Value` shorthand can't hold. `AWS_REGION` is set by Lambda; don't add it.

```zsh
cat > /tmp/autoace-api-env.json <<EOF
{
  "Variables": {
    "BUCKET": "${BUCKET}",
    "WORKER_FUNCTION_NAME": "${WORKER_FUNCTION_NAME}",
    "AUTH_MODE": "dev",
    "DEV_USER_ID": "dev-user",
    "PUT_URL_EXPIRES": "900",
    "WORKER_URL_EXPIRES": "3600",
    "DOWNLOAD_URL_EXPIRES": "900",
    "MAX_AUDIO_MB": "500",
    "MAX_CSV_MB": "5",
    "SUPPORTED_AUDIO": ".wav,.mp3,.ogg,.m4a,.flac",
    "STALE_AFTER_SEC": "960"
  }
}
EOF
```

Create it (first time). A new role can take ~10 s to become usable; if this fails with
"The role defined for the function cannot be assumed by Lambda", wait and retry.

```zsh
aws lambda create-function --function-name "${API_FUNCTION_NAME}" \
  --runtime nodejs22.x --architectures arm64 --handler index.handler \
  --role "arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}" \
  --memory-size 512 --timeout 29 \
  --environment file:///tmp/autoace-api-env.json \
  --zip-file fileb://dist/function.zip
aws lambda wait function-active-v2 --function-name "${API_FUNCTION_NAME}"
```

Later deploys:

```zsh
npm test && npm run zip
aws lambda update-function-code --function-name "${API_FUNCTION_NAME}" --zip-file fileb://dist/function.zip
aws lambda wait function-updated-v2 --function-name "${API_FUNCTION_NAME}"
# only when the variables change:
aws lambda update-function-configuration --function-name "${API_FUNCTION_NAME}" --environment file:///tmp/autoace-api-env.json
```

### Worker settings this API relies on

The API invokes the worker asynchronously (`InvocationType: Event`). By default, Lambda
retries a failed async invocation twice. A retry can then write a result after
`STALE_AFTER_SEC`, so a file already shown as "timed out" would later turn into "done".
Turn retries off. The worker writes its own failure result for every error it can catch.

```zsh
aws lambda put-function-event-invoke-config --function-name "${WORKER_FUNCTION_NAME}" \
  --maximum-retry-attempts 0
```

`STALE_AFTER_SEC` (960) assumes the worker's timeout is 900 s. Also check how many workers
can run at once: each `/analyze` starts one per file, and events over the limit wait in
Lambda's queue, where they can pass `STALE_AFTER_SEC`.

```zsh
aws lambda get-function-configuration --function-name "${WORKER_FUNCTION_NAME}" --query Timeout
aws lambda get-account-settings --query 'AccountLimit.ConcurrentExecutions'
```

## 3. API Gateway HTTP API

CORS is configured here, on the API, not in the Lambda: the function returns no CORS headers,
and API Gateway answers browser preflight (`OPTIONS`) requests itself.

```zsh
export API_ID=$(aws apigatewayv2 create-api --name "${API_FUNCTION_NAME}" --protocol-type HTTP \
  --cors-configuration "{\"AllowOrigins\":[\"${DEV_ORIGIN}\"],\"AllowMethods\":[\"GET\",\"POST\"],\"AllowHeaders\":[\"content-type\",\"authorization\"],\"MaxAge\":3600}" \
  --query ApiId --output text)

export INTEGRATION_ID=$(aws apigatewayv2 create-integration --api-id "${API_ID}" \
  --integration-type AWS_PROXY --payload-format-version 2.0 \
  --integration-uri "arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:${API_FUNCTION_NAME}" \
  --query IntegrationId --output text)

for ROUTE_KEY in "POST /runs" "GET /runs" "POST /runs/{runId}/validate" "POST /runs/{runId}/analyze" \
                 "GET /runs/{runId}" "GET /runs/{runId}/output"; do
  aws apigatewayv2 create-route --api-id "${API_ID}" --route-key "${ROUTE_KEY}" \
    --target "integrations/${INTEGRATION_ID}" --query RouteKey --output text
done

aws apigatewayv2 create-stage --api-id "${API_ID}" --stage-name '$default' --auto-deploy

aws lambda add-permission --function-name "${API_FUNCTION_NAME}" \
  --statement-id apigateway-invoke --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:${AWS_REGION}:${ACCOUNT_ID}:${API_ID}/*/*"

export API_URL=$(aws apigatewayv2 get-api --api-id "${API_ID}" --query ApiEndpoint --output text)
echo "${API_URL}"
curl -s "${API_URL}/runs"     # -> {"runs":[]}
```

## 4. S3 bucket CORS

Browsers upload straight to S3 with the presigned PUT URLs, so the bucket needs its own CORS
rule. `put-bucket-cors` **replaces** the bucket's whole CORS configuration, so check for an
existing one first and merge it in if there is one:

```zsh
aws s3api get-bucket-cors --bucket "${BUCKET}"   # "NoSuchCORSConfiguration" = none yet

cat > /tmp/autoace-bucket-cors.json <<EOF
{
  "CORSRules": [{
    "AllowedOrigins": ["${DEV_ORIGIN}"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }]
}
EOF
aws s3api put-bucket-cors --bucket "${BUCKET}" --cors-configuration file:///tmp/autoace-bucket-cors.json
```

When the dashboard gets a real domain, add it to `AllowOrigins` (step 3, with
`aws apigatewayv2 update-api --api-id "${API_ID}" --cors-configuration ...`) and to
`AllowedOrigins` here.

## 5. End-to-end check

With a folder holding the three calls and their CSV:

```zsh
API_URL="${API_URL}" scripts/e2e.sh ~/Downloads/autoace-batch
```

It prints the validation report and the counts every 5 s, then writes
`out/results_<runId>.csv`. Each row's `result_json` should equal the worker's
`runs/dev-user/<runId>/results/<name>.json`:

```zsh
aws s3 cp "s3://${BUCKET}/runs/dev-user/<runId>/results/call_001.ogg.json" -
```

## Logs

One JSON line per request (`route`, `runId`, `status`, `durationMs`, `requestId`); presigned
URLs, request bodies and file contents are never logged.

```zsh
aws logs tail "/aws/lambda/${API_FUNCTION_NAME}" --follow
```
