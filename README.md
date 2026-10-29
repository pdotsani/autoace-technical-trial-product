# AutoAce call audio analysis (backend)

Backend for analyzing customer call recordings. An API Lambda accepts uploads and starts a
run; for each audio file it invokes the worker Lambda, which analyzes the file with a hybrid
pipeline of audio models (no LLM) and writes a JSON result matching
`shared/schema/result.schema.json` to S3: the customer's tone and intensity, background
noise, audio quality, speaker overlap and long silences. The frontend lives in a separate repo.

## Layout

```
worker/                  Python hybrid worker: the analysis pipeline and its Lambda adapter
api/                     API Lambda (TypeScript): runs, uploads, validation, worker fan-out, results
docs/                    memo and reports, coming later
shared/schema/           result.schema.json, the output contract shared by worker, API and frontend
experiments/
  llm_baseline/          archived LLM experiment (Qwen2.5-Omni-7B); not used in production
README.md
.gitignore
```

## Setup

TODO. For the worker, see [worker/README_worker.md](worker/README_worker.md#run-locally).

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
