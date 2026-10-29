"""Call the Lambda worker's handler() in this process, the way the API Lambda would.

Usage (from worker/):
    # S3: presign s3://$BUCKET/<key> with your AWS profile, then write results/ and metrics/ to S3
    BUCKET=my-bucket python scripts/invoke_local.py --key uploads/call_001.wav --run-id r1 --user-id u1
    # Fully local: no AWS, writes ./out/<run-id or "local">/{results,metrics}/<name>.json
    python scripts/invoke_local.py --audio-path ~/Downloads/call_001.ogg

--profile defaults to $AWS_PROFILE (or the default profile).
"""

import argparse
import contextlib
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any

WORKER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER_DIR))

PRESIGN_EXPIRES_SEC = 3600
LAMBDA_TIMEOUT_SEC = 900  # the longest Lambda timeout; drives the handler's timeout alarm


class LocalContext:
    """The parts of the Lambda context object the handler reads."""

    aws_request_id = "local"
    memory_limit_in_mb = None

    def __init__(self, timeout_sec: float):
        self._deadline = time.monotonic() + timeout_sec

    def get_remaining_time_in_millis(self) -> int:
        return int((self._deadline - time.monotonic()) * 1000)


def _presign(profile: str | None, bucket: str, key: str) -> str:
    import boto3

    s3 = boto3.Session(profile_name=profile).client("s3")
    return s3.generate_presigned_url("get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=PRESIGN_EXPIRES_SEC)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--key", help="S3 key of the audio in $BUCKET")
    source.add_argument("--audio-path", type=Path, help="local audio file (skips S3 entirely)")
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--user-id", default=None)
    parser.add_argument("--name", help="file name to report (default: last part of --key / --audio-path)")
    parser.add_argument("--profile", default=os.environ.get("AWS_PROFILE"))
    parser.add_argument("--timeout", type=float, default=LAMBDA_TIMEOUT_SEC, help="simulated Lambda timeout, s")
    args = parser.parse_args()

    event: dict[str, Any] = {"run_id": args.run_id, "user_id": args.user_id}
    if args.key:
        bucket = os.environ.get("BUCKET")
        if not bucket:
            parser.error("--key needs BUCKET set in the environment")
        if not (args.run_id and args.user_id):
            parser.error("--key needs --run-id and --user-id")
        if args.profile:
            os.environ["AWS_PROFILE"] = args.profile  # the handler's own S3 client uses it too
        event["name"] = args.name or args.key.rsplit("/", 1)[-1]
        event["audio_url"] = _presign(args.profile, bucket, args.key)
    else:
        event["name"] = args.name or args.audio_path.name
        event["audio_path"] = str(args.audio_path.expanduser().resolve())

    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stderr)
    with contextlib.redirect_stdout(sys.stderr):  # model libraries print while loading
        from adapters.lambda_handler import handler

        returned = handler(event, LocalContext(args.timeout))

    print(json.dumps(returned, indent=2, ensure_ascii=False))
    if returned.get("result_key"):
        written = returned["result_key"]
        metrics = written.replace("/results/", "/metrics/", 1)
        where = f"s3://{os.environ['BUCKET']}/" if args.key else ""
        print(f"result : {where}{written}\nmetrics: {where}{metrics}")
    return 0 if returned["status"] == "done" else 1


if __name__ == "__main__":
    sys.exit(main())
