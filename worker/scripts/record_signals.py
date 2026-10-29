"""Record measured Signals for audio files as test fixtures (needs the audio and the models).

Usage (from worker/):
    python scripts/record_signals.py call_001.ogg call_002.ogg call_003.ogg

Writes tests/fixtures/<name>.signals.json. Re-run after changing anything in the measuring
step (models, VAD, DNSMOS, sound events, static, emotion2vec); changes that only touch
decision thresholds do not need new fixtures.
"""

import argparse
import contextlib
import sys
from pathlib import Path

WORKER_DIR = Path(__file__).resolve().parents[1]
FIXTURES_DIR = WORKER_DIR / "tests" / "fixtures"
sys.path.insert(0, str(WORKER_DIR))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("audio", nargs="+", type=Path)
    args = parser.parse_args()

    with contextlib.redirect_stdout(sys.stderr):  # model libraries print while loading
        from audioace import pipeline

    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    for path in args.audio:
        with contextlib.redirect_stdout(sys.stderr):
            signals = pipeline.measure(path)
        out = FIXTURES_DIR / f"{path.name}.signals.json"
        out.write_text(signals.model_dump_json(indent=1) + "\n")

        reloaded = pipeline.Signals.model_validate_json(out.read_text())
        if pipeline.decide(reloaded) != pipeline.decide(signals):
            print(f"{out}: result changed after the JSON round-trip", file=sys.stderr)
            return 1
        print(f"{out}  {pipeline.decide(signals)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
