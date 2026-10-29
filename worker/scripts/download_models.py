"""Populate MODELS_DIR with every model the worker needs (build-time only; uses the network).

Usage (from worker/):
    python scripts/download_models.py [--no-emotion2vec-large]

HF_TOKEN is read from worker/.env (see worker/.env.example) or the environment.
The pyannote repos are gated: accept their terms on huggingface.co and set HF_TOKEN,
otherwise they are skipped (stereo files still work; mono files will fail).
"""

import argparse
import os
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv

WORKER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER_DIR))
load_dotenv(WORKER_DIR / ".env")

from audioace import config  # noqa: E402

DNSMOS_URL = "https://github.com/microsoft/DNS-Challenge/raw/master/DNSMOS/DNSMOS/sig_bak_ovr.onnx"
PYANNOTE_REPOS = [
    config.PYANNOTE_DIARIZATION_ID,
    config.PYANNOTE_SEGMENTATION_ID,
]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--emotion2vec", default="emotion2vec/emotion2vec_plus_base")
    parser.add_argument("--emotion2vec-large", default="emotion2vec/emotion2vec_plus_large")
    parser.add_argument("--no-emotion2vec-large", action="store_true", help="skip the end-of-call satisfied check model")
    args = parser.parse_args()

    # Imported here so HF_HUB_OFFLINE from a stray environment does not block downloads
    os.environ.pop("HF_HUB_OFFLINE", None)
    from huggingface_hub import snapshot_download
    from huggingface_hub.errors import GatedRepoError

    token = os.environ.get("HF_TOKEN")
    config.HF_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    print(f"AST -> {config.HF_CACHE_DIR}")
    snapshot_download(config.AST_MODEL_ID, cache_dir=config.HF_CACHE_DIR)

    print(f"{args.emotion2vec} -> {config.EMOTION2VEC_DIR}")
    snapshot_download(args.emotion2vec, local_dir=config.EMOTION2VEC_DIR)
    if not args.no_emotion2vec_large:
        print(f"{args.emotion2vec_large} -> {config.EMOTION2VEC_LARGE_DIR}")
        snapshot_download(args.emotion2vec_large, local_dir=config.EMOTION2VEC_LARGE_DIR)

    print(f"DNSMOS -> {config.DNSMOS_PATH}")
    config.DNSMOS_PATH.parent.mkdir(parents=True, exist_ok=True)
    resp = requests.get(DNSMOS_URL, timeout=120)
    resp.raise_for_status()
    config.DNSMOS_PATH.write_bytes(resp.content)

    if not token:
        print("HF_TOKEN not set in worker/.env: skipping gated pyannote models (needed for mono audio)")
        return 0
    failed = []
    for repo in PYANNOTE_REPOS:
        print(f"{repo} -> {config.HF_CACHE_DIR}")
        try:
            snapshot_download(repo, cache_dir=config.HF_CACHE_DIR, token=token)
        except GatedRepoError:
            print(f"  access denied: accept the terms at https://huggingface.co/{repo} with the account that owns HF_TOKEN")
            failed.append(repo)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
