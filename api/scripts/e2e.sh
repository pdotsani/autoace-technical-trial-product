#!/usr/bin/env bash
# End-to-end run against a deployed API: create a run, upload a folder, validate, analyze,
# poll until complete, download the results CSV to ./out/.
#
# Usage: API_URL=https://<api-id>.execute-api.us-east-2.amazonaws.com [TOKEN=<jwt>] scripts/e2e.sh <folder>
#   <folder> holds audio files and exactly one CSV (name[,result_json]).
#   TOKEN: a Supabase access token, required when the API runs with AUTH_MODE=jwt.
# Needs: curl, jq. Optional: POLL_SEC (default 5), MAX_WAIT_SEC (default 1200).
set -euo pipefail

: "${API_URL:?set API_URL, e.g. https://abc123.execute-api.us-east-2.amazonaws.com}"
FOLDER="${1:?usage: scripts/e2e.sh <folder with audio files and one CSV>}"
POLL_SEC="${POLL_SEC:-5}"
MAX_WAIT_SEC="${MAX_WAIT_SEC:-1200}"
API_URL="${API_URL%/}"
AUTH=()
[[ -n "${TOKEN:-}" ]] && AUTH=(-H "Authorization: Bearer ${TOKEN}")
[[ -d "${FOLDER}" ]] || { echo "not a folder: ${FOLDER}" >&2; exit 1; }

content_type() {
  case "$(printf '%s' "${1##*.}" | tr '[:upper:]' '[:lower:]')" in
    wav) echo "audio/wav" ;; mp3) echo "audio/mpeg" ;; ogg) echo "audio/ogg" ;;
    m4a) echo "audio/mp4" ;; flac) echo "audio/flac" ;; csv) echo "text/csv" ;;
    *) echo "application/octet-stream" ;;
  esac
}

# api METHOD PATH [JSON_BODY]: prints the response body; exits on HTTP errors with the error JSON
api() {
  local method="$1" path="$2" body="${3:-}" response status
  if [[ -n "${body}" ]]; then
    response="$(curl -sS -w '\n%{http_code}' -X "${method}" ${AUTH[@]+"${AUTH[@]}"} -H 'Content-Type: application/json' -d "${body}" "${API_URL}${path}")"
  else
    response="$(curl -sS -w '\n%{http_code}' -X "${method}" ${AUTH[@]+"${AUTH[@]}"} "${API_URL}${path}")"
  fi
  status="${response##*$'\n'}"
  response="${response%$'\n'*}"
  if [[ "${status}" -ge 400 ]]; then
    echo "${method} ${path} -> HTTP ${status}" >&2
    echo "${response}" | jq . >&2 || echo "${response}" >&2
    exit 1
  fi
  printf '%s' "${response}"
}

# 1. Create the run: one entry per regular file in the folder (top level only)
files_json="$(
  find "${FOLDER}" -maxdepth 1 -type f -print0 | while IFS= read -r -d '' path; do
    name="$(basename "${path}")"
    jq -n --arg name "${name}" --argjson size "$(wc -c < "${path}" | tr -d ' ')" --arg ct "$(content_type "${name}")" \
      '{name: $name, size: $size, contentType: $ct}'
  done | jq -s '{files: .}'
)"
echo "== POST /runs ($(echo "${files_json}" | jq '.files | length') files)"
created="$(api POST /runs "${files_json}")"
RUN_ID="$(echo "${created}" | jq -r .runId)"
echo "run ${RUN_ID}"
echo "${created}" | jq -r '.report.skipped[]? | "  skipped before upload: \(.name): \(.reason)"'

# 2. Upload each file to its presigned PUT URL (URLs are never printed)
echo "== upload"
echo "${created}" | jq -c '.uploads[]' | while IFS= read -r upload; do
  name="$(echo "${upload}" | jq -r .name)"
  url="$(echo "${upload}" | jq -r .url)"
  ct="$(echo "${upload}" | jq -r '.headers["Content-Type"]')"
  status="$(curl -sS -o /dev/null -w '%{http_code}' -X PUT -H "Content-Type: ${ct}" --data-binary "@${FOLDER}/${name}" "${url}")"
  [[ "${status}" == "200" ]] || { echo "  upload of ${name} failed: HTTP ${status}" >&2; exit 1; }
  echo "  ${name}"
done

# 3. Validate
echo "== POST /runs/${RUN_ID}/validate"
report="$(api POST "/runs/${RUN_ID}/validate")"
echo "${report}" | jq '{summary, analyzable, labeled, matched, skipped, warnings, blocking}'
[[ "$(echo "${report}" | jq -r .analyzable)" == "true" ]] || { echo "batch is not analyzable" >&2; exit 1; }

# 4. Analyze
echo "== POST /runs/${RUN_ID}/analyze"
api POST "/runs/${RUN_ID}/analyze" | jq -c .counts

# 5. Poll until complete
echo "== GET /runs/${RUN_ID} every ${POLL_SEC}s"
waited=0
while :; do
  run="$(api GET "/runs/${RUN_ID}")"
  echo "  $(date +%H:%M:%S) $(echo "${run}" | jq -c .counts)"
  [[ "$(echo "${run}" | jq -r .complete)" == "true" ]] && break
  (( waited >= MAX_WAIT_SEC )) && { echo "not complete after ${MAX_WAIT_SEC}s" >&2; exit 1; }
  sleep "${POLL_SEC}"
  waited=$(( waited + POLL_SEC ))
done
echo "${run}" | jq -r '.files[] | select(.status != "done") | "  \(.name): \(.status) \(.error // "")"'

# 6. Download the CSV
mkdir -p out
url="$(api GET "/runs/${RUN_ID}/output?format=csv" | jq -r .url)"
curl -sS -o "out/results_${RUN_ID}.csv" "${url}"
echo "== wrote out/results_${RUN_ID}.csv"
cat "out/results_${RUN_ID}.csv"
