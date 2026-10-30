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
npm run dev          # the dashboard on http://localhost:5173 with the mock API
npm test             # shared, api and web
npm run typecheck
npm run gen:schema   # after changing shared/schema/result.schema.json
```

Dashboard details: [web/README.md](web/README.md). For the worker (Python), see
[worker/README_worker.md](worker/README_worker.md#run-locally).

## Deploy worker

Build and run the image locally, plus suggested Lambda settings:
[worker/README_worker.md](worker/README_worker.md#docker-image). TODO: push to ECR and create the Lambda. Event contract, S3 layout and IAM:
[worker/README_worker.md](worker/README_worker.md#lambda-worker). Libraries:
[worker/README_libraries.md](worker/README_libraries.md).

## Deploy API

See [api/DEPLOY.md](api/DEPLOY.md); routes and S3 layout in [api/README.md](api/README.md).

## Reproduce validation

TODO. The labelled sample calls are checked by `worker/tests/test_calls.py`; see
[worker/README_worker.md](worker/README_worker.md#tests).
