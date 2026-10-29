# Worker libraries

Every library the worker uses and what it does. Versions are pinned in `requirements.txt`.
The models they load are downloaded by `scripts/download_models.py` during the Docker build.

## Audio and models

| Library | Model it runs | What it does in the worker | Output fields it feeds |
|---|---|---|---|
| **ffmpeg** (system binary, `FFMPEG_BIN`) | — | Decodes any input format to 16 kHz float32 per channel (`preprocess.decode`), plus a 48 kHz mono copy for the static detector (`decode_fullband`) | all |
| **numpy** | — | Array maths throughout: loudness (dBFS), silence frames, clipping, the 14–20 kHz burst scan for sharp static | all |
| **torch** (CPU build, installed separately) | — | Runtime for silero-vad, pyannote, AST and emotion2vec; `TORCH_NUM_THREADS` sets its threads | all |
| **torchaudio** (CPU build, installed separately) | — | Not imported by the worker; a dependency of pyannote.audio (funasr also imports it in places) | — |
| **silero-vad** | Silero VAD (bundled in the package) | Finds where speech is, per channel | `long_silence_present`, `speaker_overlap_present` (stereo), and the speech segments every other stage uses |
| **pyannote.audio** | `pyannote/speaker-diarization-community-1` | Mono calls: splits the two speakers and picks the customer | `emotional_tone`, `emotional_intensity` |
| | `pyannote/segmentation-3.0` | Mono calls: second-speaker activation, i.e. crosstalk | `speaker_overlap_present` |
| **onnxruntime** | Microsoft DNSMOS P.835 (`sig_bak_ovr.onnx`) | Speech quality (SIG, OVRL) and background score (BAK) | `audio_quality`, `background_noise_*` |
| **transformers** | `MIT/ast-finetuned-audioset-10-10-0.4593` (AST) | Labels sounds in the gaps between speech, and the "Television" score across the whole call | `background_noise_present`, `_type`, `_severity` |
| **funasr** | emotion2vec_plus_base (`models/emotion2vec`) | Emotion scores for each 3–30 s chunk of customer speech | `emotional_tone`, `emotional_intensity`, `confidence` |
| | emotion2vec_plus_large (`models/emotion2vec_large`, optional) | Scores only the customer's last chunk; a neutral call becomes satisfied when "happy" ≥ `END_SATISFIED_HAPPY_MIN` | `emotional_tone`, `confidence` |
| **joblib** + **scikit-learn** | `models/custom/tone_classifier.joblib` (optional, not present) | Loads a trained tone classifier over emotion2vec embeddings. Unused until one is trained; kept for now | `emotional_tone`, `emotional_intensity` |
| **huggingface_hub** | — | Downloads the models at build time; at run time, transformers and pyannote read its offline cache (`models/hf`) | — |

## Everything else

| Library | What it does |
|---|---|
| **pydantic** | Output models (`audioace/schema.py`), the recorded `Signals`, and the Lambda event check |
| **requests** | Downloads the presigned audio URL in the Lambda handler, and DNSMOS at build time |
| **boto3** | Writes results and metrics to S3 (Lambda handler); presigns URLs in `scripts/invoke_local.py` |
| **python-dotenv** | Reads `HF_TOKEN` from `worker/.env` in `scripts/download_models.py` (build time only) |

Development only (`requirements-dev.txt`, not in the image): **pytest**, **jsonschema**
(checks results against `shared/schema/result.schema.json`) and **moto** (mocks S3 in the
handler tests).
