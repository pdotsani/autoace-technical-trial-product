# LLM baseline (archived)

An early experiment: classify each call with an audio-capable LLM instead of the hybrid
worker in `worker/`. It is kept for reference only and is **not used in production**.

## What was tried

- **Model:** Qwen2.5-Omni-7B (`Qwen/Qwen2.5-Omni-7B`), served by vLLM's OpenAI-compatible API
  on a RunPod GPU pod (`vllm serve Qwen/Qwen2.5-Omni-7B --port 8000`).
- **Prompt approach:** one request per call, single pass, no few-shot examples.
  - The whole audio file is sent inline as a base64 `audio_url` data URL.
  - Qwen's default system prompt is used, plus instructions that embed
    `shared/schema/result.schema.json` and field guidelines: tone and intensity describe the
    customer, `""` and `none` when there is no noise, what counts as overlap and long silence.
  - `temperature` 0, `max_tokens` 512.
  - vLLM guided decoding (`response_format: json_schema`) keeps the output on-schema. The reply
    is then validated against the schema again.

## How to rerun it

1. Start a RunPod pod with vLLM serving Qwen2.5-Omni-7B (command above).
2. Configure:
   ```bash
   cd experiments/llm_baseline
   cp .env.example .env    # set RUNPOD_POD_ID (or RUNPOD_BASE_URL), VLLM_API_KEY if used, OUTPUT_DIR
   pip install -r requirements.txt
   ```
3. Run it on each file (from the repo root):
   ```bash
   python experiments/llm_baseline/analyze_audio_llm.py path/to/call_001.wav
   ```
   It prints the result JSON, and also writes `<OUTPUT_DIR>/<audio-name>.json` when `OUTPUT_DIR`
   is set.

## Outputs on the labelled calls

TODO: no outputs were saved in this folder (`OUTPUT_DIR` was empty). Add where the results for
call_001, call_002 and call_003 are kept, or paste them here.

## Outcome

Underperformed the hybrid worker on the labelled calls; not used in production.

TODO: exact numbers, e.g. fields correct per call versus the hybrid worker, and time and cost
per call.

| Call | Fields matching the labels (LLM) | Fields matching the labels (hybrid) |
|---|---|---|
| call_001 | TODO | 8 / 8 |
| call_002 | TODO | 8 / 8 |
| call_003 | TODO | 8 / 8 |

The hybrid column is from `worker/tests/test_calls.py`: all 8 labelled fields (confidence excluded).
