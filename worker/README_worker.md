# Audio analysis worker (hybrid, no LLM)

Analyzes ONE audio file and returns one JSON object matching
`shared/schema/result.schema.json`. The same code runs as a local script and as an AWS
Lambda handler (container image, CPU only). Nothing is downloaded at runtime: every
model loads from `MODELS_DIR`.

## Run locally

```bash
# from the repo root
python3 -m venv .venv && source .venv/bin/activate
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
pip install -r worker/requirements-dev.txt   # or requirements.txt without the test tools
brew install ffmpeg          # or set FFMPEG_BIN=/path/to/ffmpeg

cd worker
cp .env.example .env         # then set HF_TOKEN (needed for the gated pyannote models)
python scripts/download_models.py   # one-time, needs network
python -m cli.analyze_file path/to/call.wav --pretty
pytest
```

The CLI prints the result as JSON (the Lambda worker saves the same `result_json` to S3):

```json
{"name": "call.wav", "total_seconds": 1.42, "result_json": {...schema fields...}}
```

It exits 1 when `result_json` is a `FailedResult` (`{"status": "failed", "error": "..."}`).
A corrupt or unreadable file returns a FailedResult, it does not crash.

## Lambda worker

`adapters/lambda_handler.handler(event, context)` analyzes one file per invocation and saves
its own result. The API Lambda invokes it asynchronously.

**Event:**

```json
{
  "run_id": "abc123",
  "user_id": "<supabase user id>",
  "name": "call_001.wav",
  "audio_url": "<presigned S3 GET URL>"
}
```

- `name` is the exact original file name and may contain spaces. Names containing `/` or `\`,
  or starting with `.`, are rejected; so are such `run_id` / `user_id` values.
- For local testing, `{"name": "...", "audio_path": "/local/file.wav"}` replaces `audio_url`.
- A rejected event writes nothing (its name can't be used in a key). The handler returns
  `{"name", "status": "failed", "result_key": null, "error": "invalid event: ..."}`.

**What it does:**
1. Downloads `audio_url` to `/tmp/<uuid>/<name>` (streamed, 60 s timeout, at most
   `MAX_AUDIO_MB`). A 403 is reported as "presigned URL expired or invalid".
2. Runs the pipeline. Models load once per container, at import.
3. Always writes a result: the schema result, or `{"status": "failed", "error": "<reason>"}`
   for a download error, decode error, model error or timeout.
4. Stops 30 s before the Lambda timeout (`signal.alarm`) and writes
   "processing exceeded time limit".
5. Deletes `/tmp/<uuid>` whatever happens.
6. Logs one JSON line per invocation (run_id, name, status, durations, cold_start). The
   presigned URL is never logged or stored.
7. Returns `{"name", "status": "done" | "failed", "result_key"}`.

Silent or speech-free audio is not a failure: it is scored neutral / low with confidence 0.2.

**S3 layout** (bucket `BUCKET`, compact JSON, `ContentType: application/json`):

```
runs/{user_id}/{run_id}/results/{name}.json   result or failure object
runs/{user_id}/{run_id}/metrics/{name}.json   per-stage seconds, download/analyze/total seconds,
                                              audio duration and size, init seconds, cold_start,
                                              model ids, error_type, Lambda request id / memory
```

`error_type` is one of `null`, `url_expired`, `download_error`, `too_large`, `decode_error`,
`model_error`, `timeout`, `internal_error`.

**Local mode:** when `BUCKET` is unset or the event has `audio_path`, nothing goes to S3; the
same two files are written to `./out/{run_id or "local"}/results/` and `.../metrics/`.

**Environment variables:**

| Variable | Default | Meaning |
|---|---|---|
| `BUCKET` | unset (local mode) | S3 bucket for `runs/...` |
| `MAX_AUDIO_MB` | 500 | largest audio file downloaded |
| `TORCH_NUM_THREADS` | CPU count | torch / ONNX threads |
| `CUSTOMER_CHANNEL` | 1 | customer channel in stereo files |
| `EMOTION2VEC_LARGE_KEEP_LOADED` | 0 | 1 keeps emotion2vec_plus_large in memory after a neutral call (skips the ~1 s reload, but every call then needs memory for it) |

**Running it without deploying** (`scripts/invoke_local.py` calls `handler()` in-process):

```bash
# fully local: no AWS needed, writes ./out/local/{results,metrics}/call_001.wav.json
python scripts/invoke_local.py --audio-path path/to/call_001.wav

# against S3: presigns s3://$BUCKET/<key> with your AWS profile, writes runs/... to S3
BUCKET=my-bucket python scripts/invoke_local.py --key uploads/call_001.wav \
    --run-id test1 --user-id me [--profile my-profile]
```

It prints the handler's return value and the result / metrics keys it wrote. `--profile`
defaults to `$AWS_PROFILE`; `--timeout` sets the simulated Lambda timeout (default 900 s).

**IAM** (not created by this repo): the worker role needs `s3:GetObject` on `runs/*`,
`s3:PutObject` on `runs/*/results/*` and `runs/*/metrics/*`, and CloudWatch Logs
(`logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents`).

## Docker image

`worker/Dockerfile` builds the Lambda container image (build context: `worker/`).

- Base: `public.ecr.aws/lambda/python:3.12` (Amazon Linux 2023). The local venv is 3.11; the
  3.11 image is Amazon Linux 2, whose glibc is too old for current torch wheels.
- CPU-only torch / torchaudio, ffmpeg (static binary from `imageio-ffmpeg`), `requirements.txt`.
- Models are downloaded **during the build** by `scripts/download_models.py` into
  `/opt/models`, including the gated pyannote models and emotion2vec_plus_large. Nothing is
  copied from `worker/models/` (`.dockerignore` excludes it).
- The build ends by loading every model, so a missing or broken model fails the build.
- Library caches point at `/tmp` (the only writable path on Lambda); Hugging Face is forced
  offline and pyannote telemetry is off, so the worker makes no network calls except the
  audio download and the S3 writes.

**Build** (Docker running; `HF_TOKEN` from an account that accepted the pyannote terms):

```bash
cd worker
export HF_TOKEN=hf_...          # or: export $(grep ^HF_TOKEN= .env)
docker build --platform linux/arm64 --secret id=hf_token,env=HF_TOKEN -t auto-ace-worker .
```

The token is passed as a BuildKit secret, so it is not stored in any layer. The deployed
worker is arm64 (Graviton), which is 20% cheaper per second and ran faster on Lambda (see
[Measured on Lambda](#measured-on-lambda)). Use `--platform linux/amd64` for an x86_64 Lambda.
Add `--provenance=false` when the image is for Lambda, which needs a single-platform manifest
([DEPLOY.md](../DEPLOY.md#3-worker-lambda) has the push and deploy steps).

**Run it locally** (the base image includes the Lambda Runtime Interface Emulator):

```bash
docker run --rm -p 9000:8080 -v ~/Downloads:/audio:ro -v "$PWD/out:/var/task/out" auto-ace-worker
# in another terminal
curl -s localhost:9000/2015-03-31/functions/function/invocations \
  -d '{"name": "call_001.ogg", "audio_path": "/audio/call_001.ogg"}'
# -> {"name": "call_001.ogg", "status": "done", "result_key": "out/local/results/call_001.ogg.json"}
```

To test S3 from the container, also pass `-e BUCKET=... -e AWS_ACCESS_KEY_ID=...
-e AWS_SECRET_ACCESS_KEY=... -e AWS_SESSION_TOKEN=... -e AWS_REGION=...` and send an event
with `run_id`, `user_id` and a presigned `audio_url`.

**Lambda settings** (the deployed values):

| Setting | Value | Why |
|---|---|---|
| Architecture | arm64 (match `--platform`) | 20% cheaper per GB-second, and faster on this workload (below) |
| Memory | 10240 MB | Lambda's CPU share grows with memory (10 GB gives 6 vCPUs), and the run is CPU-bound. Peak memory on Lambda was 7.4–7.8 GB on arm64 and 6.8–7.7 GB on x86_64, with both emotion models loaded at start-up |
| Timeout | 900 s (the maximum) | a 172 s call took 113–121 s on arm64. Calls of up to about 15 minutes fit at that rate; the handler stops 30 s early to write a failure |
| Ephemeral storage (`/tmp`) | 4096 MB | downloads up to `MAX_AUDIO_MB` (500) plus library caches |
| Environment | `BUCKET`, `TORCH_NUM_THREADS=6` (one thread per vCPU), `CUSTOMER_CHANNEL=1`; optionally `MAX_AUDIO_MB` | see "Lambda worker" |
| Retries, concurrency | 0 retries, 20 reserved | see [DEPLOY.md](../DEPLOY.md#3-worker-lambda) |

Cold starts load every model except emotion2vec_plus_large during Lambda's init phase: 11 s in
the container under the local emulator, measured before that model became on-demand. Lambda allows 10 s for init; when it takes longer, Lambda reruns init as part
of the first invocation (counted against its timeout and billed), so the first call after a
cold start is about 11 s slower but still works. The image is 6.2 GB unpacked (4.0 GB
compressed), under Lambda's 10 GB limit; models are 3.7 GB of it and Python packages 2.2 GB.

Measured in the container (arm64, Docker Desktop on an M-series Mac, 12 CPUs): call_001
(31 s of audio) in 29 s and call_003 (172 s) in 111 s, 59 s of it speaker separation; both
results identical to the CLI.

### Measured on Lambda

Image `4577622` (both emotion models loaded at start-up), 10240 MB, the three sample calls.
On 2026-10-30, 15 invocations on x86_64 and 9 on arm64; the arm64 figures leave out the first
cold start after the image was deployed (about 237 s of model loading, while Lambda cached
the image). Prices are us-east-2: $0.0000166667 per GB-second on x86_64, $0.0000133334 on
arm64.

| | x86_64 | arm64 |
|---|---|---|
| Run time / audio time | 1.14 | 0.76 |
| call_003 (172 s of audio), median | 177 s (150 s speaker separation) | 117 s (94 s speaker separation) |
| Model loading per cold start, median | 38 s (31–42 s) | 30 s (20–67 s) |
| Cost per minute of audio | $0.0114 | $0.0061 |
| Cost per cold start | $0.0064 | $0.0039 |
| 3 calls in parallel, all cold: time to last result | 204–206 s | 134 s |

Every run on both architectures matched the three calls' expected labels on all eight fields.
**Confidence was not reproducible on arm64**: the same file scored differently between runs
(call_001: 0.898, 0.898, 0.729; call_002: 0.866, 0.866, 0.886), and call_003 scored 0.854
against x86_64's 0.885. x86_64 gave the same confidence on every run (0.898, 0.886, 0.885).
The cause is not known yet; arm64's math libraries and thread scheduling are the first
suspects. Lambda also logs harmless `Error in cpuinfo: failed to parse ...` lines on arm64.

## Model folder layout

What each library and model does: [README_libraries.md](README_libraries.md).

`MODELS_DIR` defaults to `worker/models` locally and `/opt/models` inside Lambda.

```
models/
  hf/                                   Hugging Face hub cache (read with HF_HUB_OFFLINE=1)
    models--MIT--ast-finetuned-audioset-10-10-0.4593/
    models--pyannote--segmentation-3.0/               gated: accept terms on HF
    models--pyannote--speaker-diarization-community-1/ gated: accept terms on HF
  emotion2vec/                          emotion2vec_plus_* folder (config.yaml, model.pt, tokens.txt)
  emotion2vec_large/                    optional emotion2vec_plus_large; see "Tone" below
  dnsmos/sig_bak_ovr.onnx               Microsoft DNSMOS P.835
  custom/tone_classifier.joblib         optional; see "Tone" below
```

Silero VAD ships inside the `silero-vad` pip package. A missing model does not stop the
worker from loading. The stage that needs it fails with a message naming the expected path.
The pyannote models are only needed for mono recordings.

## Configuration

Every threshold lives in `audioace/config.py`, can be overridden by an environment variable
of the same name, and is marked `TODO: calibrate on dev set`. Also:
`MODELS_DIR`, `FFMPEG_BIN`, `TORCH_NUM_THREADS` (default: CPU count), `CUSTOMER_CHANNEL`
(default 1; TODO confirm with data).

## How each field is computed

**Decoding.** ffmpeg converts the file to 16 kHz float32, one array per channel. Two
channels that are near-identical are averaged into mono. A stereo file with one dead
channel uses the live one. Only real two-sided stereo counts as `stereo`.

**Customer speech.**
- Stereo: the customer is channel `CUSTOMER_CHANNEL`.
- Mono: pyannote diarization runs, and the customer is the speaker who does NOT speak
  first (the most talk time among the rest). The customer channel counts as uncertain
  (see `confidence`).

**`long_silence_present`.** Silero VAD runs on every channel. This is true when the longest
stretch with no speech on ANY channel, and every channel quieter than `SILENCE_MAX_DBFS`
(−40 dBFS, measured in 100 ms frames), exceeds `LONG_SILENCE_SEC` (8 s). The loudness check
stops soft speech that VAD missed from counting as dead air. Leading and trailing
silence is ignored unless `LONG_SILENCE_INCLUDE_EDGES=1`.

**`speaker_overlap_present`.** True when overlapping speech totals more than `OVERLAP_SEC` (0.6 s).
- Stereo: overlap is time where both channels' VAD speech coincides.
- Mono: overlap comes from pyannote `segmentation-3.0`. A frame counts when the
  second-most-active speaker's activation exceeds `OVERLAP_ONSET`. This is what pyannote's
  removed OverlappedSpeechDetection pipeline did.

**`audio_quality`.**
- DNSMOS SIG and OVRL are computed on each channel's speech, plus the clipping ratio and the
  speech RMS level.
- Each channel is banded clear / slightly / severely impaired, and the worst channel wins.
- The DNSMOS background score (BAK) is never used here.

**`background_noise_*`.**
- The AudioSet classifier (AST) runs on non-speech gaps of every channel. Gaps are packed
  in time order into clips of at most 10 s (`AST_CHUNK_SEC`), because AST pads every input to
  10.24 s and one clip per short gap would cost a full pass each. Every gap in a clip gets
  that clip's score. A brief noise sharing a clip with quiet gaps scores lower than it would
  alone. Gaps under 0.5 s (`NOISE_MIN_GAP_SEC`) and digital silence are skipped.
- AST (the gap check and the TV check) is skipped entirely when its answer can't change the
  result: sharp static was found (static wins), or the lowest DNSMOS BAK is at least
  `BAK_NOISE_MAX` (no other noise can be reported). `Signals.ast_skipped` records why.
  Because this happens while measuring, changing `BAK_NOISE_MAX` or the static thresholds
  means re-recording the test fixtures.
- Speech, silence, room tone, signal artifacts (static, hum, white noise, distortion…), the
  speaker's own sounds (breathing, cough…) and phone-line tones are ignored. That way poor
  audio alone can never produce a noise verdict.
- The remaining labels map to: office chatter, music, TV, road noise, keyboard
  typing, wind, mechanical noise, other.
- `present` = best noise-type score > `NOISE_EVENT_MIN` AND the lowest per-channel DNSMOS BAK
  < `BAK_NOISE_MAX`.
- `severity` is banded from BAK. It moves up one band when noisy gaps border at least half
  the speech time, and down one band when they border under 10% of it. Noisy gaps bordering
  speech stand in for noise under speech.
- Background TV is mostly dialogue, so VAD marks it as speech and the gap check misses it.
  When the gap check finds no sound event, AST's "Television" score is also checked over
  the whole call (speech included, 10 s windows, 5 s hop). If it exceeds `TV_EVENT_MIN` and
  BAK < `BAK_NOISE_MAX`, noise is reported as `TV`. Severity uses the share of speech
  inside the windows where TV was heard.
- Sharp static (crackle) is checked first. Its 5 ms bursts sit above 8 kHz, which the 16 kHz
  analysis audio cannot contain, so the file is also decoded at 48 kHz. A burst is a frame
  whose 14–20 kHz energy is `STATIC_BURST_DB` (20 dB) above that band's median. More than
  `STATIC_RATE_MIN` (0.3) bursts/s → `sharp static`, with severity medium from 0.6/s and
  high from 2/s. DNSMOS BAK does not see intermittent crackle, so this check is not gated by
  BAK. Recordings with less than about 14 kHz of bandwidth can't show it.
- Order: sharp static, then sound events in the gaps, then TV.
- When noise is not present, `type` is `""` and `severity` is `none`. The schema also
  enforces this.

**`emotional_tone` / `emotional_intensity`.**
- Customer speech is merged into 3–30 s chunks, and each chunk is loudness-normalised so tone
  never follows volume.
- emotion2vec scores each chunk.
- If `models/custom/tone_classifier.joblib` exists (an sklearn-style model with `predict_proba`
  over the five tone names, trained on emotion2vec utterance embeddings), it is used.
- Otherwise the baseline mapping applies:
  - angry ≥ `ANGRY_UPSET_MIN` → upset, otherwise frustrated
  - disgusted → frustrated
  - happy → satisfied
  - sad → upset (`SAD_TONE`), fearful → distressed
  - everything else → neutral
- Aggregation: the tone with the highest summed probability wins. If that is neutral, a
  non-neutral tone that is the top class in 2+ chunks is promoted instead.
- Intensity comes from the largest probability margin (top tone minus runner-up) among the
  chunks where the final tone is on top: ≥ `INTENSITY_HIGH_MARGIN` (0.5) → high,
  ≥ `INTENSITY_MEDIUM_MARGIN` (0.1) → medium, otherwise low. A neutral tone gets `NEUTRAL_INTENSITY`
  (default medium), because the margin only measures how sure the model is that the call is neutral.
- End-of-call check: if the result is neutral and `models/emotion2vec_large` exists,
  emotion2vec_plus_large scores the last chunk. It is loaded only then (about 1 s) and freed
  right after, unless `EMOTION2VEC_LARGE_KEEP_LOADED=1`, so other calls never hold it in memory. When its "happy" share (with `<unk>` left out)
  is at least `END_SATISFIED_HAPPY_MIN` (0.9), the tone becomes satisfied, intensity is kept,
  and that share is the tone probability. The threshold comes from three labelled calls only.
- With under `TONE_MIN_SPEECH_SEC` of customer speech, the result is neutral / low.

**`confidence`.** The mean probability of the chosen tone across the chunks where it is on top,
minus 0.1 when the customer channel is uncertain, clamped to 0–1.
(TODO: replace with calibrated model.)

## Tests

`pipeline.analyze(path)` is `decide(measure(path))`. `measure()` runs the models and returns
`Signals` (plain numbers and time ranges); `decide()` applies the thresholds in `config.py`
and needs no audio or models.

`tests/test_calls.py` checks the expected result for each labelled sample call by running
`decide()` on its recorded Signals in `tests/fixtures/`. It runs in seconds without the audio.
Threshold changes are covered by it directly; after changing anything in the measuring step
(models, VAD, DNSMOS, sound events, static detection, emotion2vec), re-record the fixtures:

```bash
python scripts/record_signals.py call_001.ogg call_002.ogg call_003.ogg
```
