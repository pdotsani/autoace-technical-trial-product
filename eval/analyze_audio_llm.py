"""Analyze an audio file with Qwen2.5-Omni-7B running on a RunPod pod.

Assumes the pod serves the model through vLLM's OpenAI-compatible API, e.g.:

    vllm serve Qwen/Qwen2.5-Omni-7B --port 8000

Configuration is read from eval/.env (see eval/.env.example).

Usage:
    python eval/analyze_audio_llm.py path/to/call.wav
"""

import argparse
import base64
import json
import mimetypes
import os
import re
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv
from jsonschema import ValidationError, validate

load_dotenv(Path(__file__).resolve().parent / ".env")

MODEL = os.environ.get("MODEL", "Qwen/Qwen2.5-Omni-7B")
SCHEMA_PATH = Path(__file__).resolve().parent.parent / "shared" / "schema" / "result.schema.json"

SYSTEM_PROMPT = (
    "You are Qwen, a virtual human developed by the Qwen Team, Alibaba Group, "
    "capable of perceiving auditory and visual inputs, as well as generating text and speech."
)

INSTRUCTIONS = """Listen to this customer call recording and analyze it.

Return ONLY a JSON object that matches this JSON Schema:

{schema}

Guidelines:
- emotional_tone and emotional_intensity describe the CUSTOMER, not the agent.
- background_noise_type is a short description (e.g. "traffic", "TV", "crying baby"); use "" when there is no background noise.
- If background_noise_present is false, background_noise_severity must be "none".
- speaker_overlap_present is true when speakers talk over each other.
- long_silence_present is true when there is a noticeable silence of several seconds.
- confidence is your overall confidence in this analysis, from 0 to 1.
"""


def load_schema() -> dict:
    with open(SCHEMA_PATH) as f:
        return json.load(f)


def audio_data_url(path: Path) -> str:
    mime, _ = mimetypes.guess_type(path.name)
    if not mime or not mime.startswith("audio/"):
        mime = "audio/wav"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def extract_json(text: str) -> dict:
    """Parse JSON from the model output, tolerating code fences or surrounding prose."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if not match:
            raise
        return json.loads(match.group(0))


def analyze(audio_path: Path, base_url: str, api_key: str | None, timeout: int) -> dict:
    schema = load_schema()
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": [{"type": "text", "text": SYSTEM_PROMPT}]},
            {
                "role": "user",
                "content": [
                    {"type": "audio_url", "audio_url": {"url": audio_data_url(audio_path)}},
                    {"type": "text", "text": INSTRUCTIONS.format(schema=json.dumps(schema, indent=2))},
                ],
            },
        ],
        "temperature": 0,
        "max_tokens": 512,
        # vLLM guided decoding keeps the output on-schema
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": schema.get("title", "result"), "schema": schema},
        },
    }

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    resp = requests.post(
        f"{base_url.rstrip('/')}/chat/completions",
        headers=headers,
        json=payload,
        timeout=timeout,
    )
    resp.raise_for_status()
    content = resp.json()["choices"][0]["message"]["content"]

    result = extract_json(content)
    validate(instance=result, schema=schema)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("audio", type=Path, help="Path to the audio file (wav, mp3, flac, ...)")
    args = parser.parse_args()

    if not args.audio.is_file():
        parser.error(f"audio file not found: {args.audio}")

    base_url = os.environ.get("RUNPOD_BASE_URL")
    if not base_url:
        pod_id = os.environ.get("RUNPOD_POD_ID")
        if not pod_id:
            parser.error("set RUNPOD_BASE_URL or RUNPOD_POD_ID in eval/.env")
        port = os.environ.get("RUNPOD_PORT", "8000")
        base_url = f"https://{pod_id}-{port}.proxy.runpod.net/v1"

    api_key = os.environ.get("VLLM_API_KEY") or None
    timeout = int(os.environ.get("REQUEST_TIMEOUT", 300))
    output_dir = os.environ.get("OUTPUT_DIR")

    try:
        result = analyze(args.audio, base_url, api_key, timeout)
    except requests.HTTPError as e:
        print(f"Request failed: {e}\n{e.response.text}", file=sys.stderr)
        return 1
    except (json.JSONDecodeError, ValidationError) as e:
        print(f"Model output did not match schema: {e}", file=sys.stderr)
        return 1

    output = json.dumps(result, indent=2)
    print(output)
    if output_dir:
        out_path = Path(output_dir) / f"{args.audio.stem}.json"
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(output + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
