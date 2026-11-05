"""Run one turn over hy-protocol/1 and switch the model (CP-30 example).

    python protocol_run.py --cli path/to/main.js --cwd path/to/repo --mock "SAY hi"
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hy_harness import ProtocolClient  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("message")
    parser.add_argument("--cli", default=os.environ.get("HY_HARNESS_CLI", "hy"))
    parser.add_argument("--cwd", default=None)
    parser.add_argument("--mock", action="store_true")
    parsed = parser.parse_args()
    args = ["--mock"] if parsed.mock else []
    events = []
    with ProtocolClient(cli=parsed.cli, cwd=parsed.cwd, args=args, on_approval=lambda req: False) as client:
        info = client.initialize()
        print(f"protocol: {info.protocol_version}")
        result = client.turn(parsed.message, on_event=lambda event, thread: events.append(event.get("type")))
        print(f"thread: {result['threadId']}")
        print(f"final: {result['final']}")
        print(f"events: {len(events)}")
        threads = [t["threadId"] for t in client.threads()]
        print(f"listed: {result['threadId'] in threads}")
        print(f"model: {client.set_model('mock-2')['model']['model']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
