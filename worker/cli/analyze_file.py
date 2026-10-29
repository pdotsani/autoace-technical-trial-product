"""Analyze one local audio file and print its result as JSON.

The Lambda worker (adapters/lambda_handler.py) saves the same result_json to S3.

Usage (from worker/):
    python -m cli.analyze_file path/to/file.wav [--pretty]
"""

import argparse
import contextlib
import json
import sys
import time
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("path", help="Audio file to analyze")
    parser.add_argument("--pretty", action="store_true", help="Indent the JSON output")
    args = parser.parse_args(argv)

    # Model libraries print to stdout while loading; keep stdout for the JSON only
    with contextlib.redirect_stdout(sys.stderr):
        from audioace import pipeline

        started = time.perf_counter()
        result = pipeline.analyze(args.path)
    output = {"name": Path(args.path).name, "total_seconds": round(time.perf_counter() - started, 3),
              "result_json": result}  # fmt: skip

    print(json.dumps(output, indent=2 if args.pretty else None, ensure_ascii=False))
    return 1 if output["result_json"].get("status") == "failed" else 0


if __name__ == "__main__":
    sys.exit(main())
