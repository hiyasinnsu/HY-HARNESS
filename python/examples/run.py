#!/usr/bin/env python3
"""Run one prompt through HY-HARNESS and print the streamed events.

    python examples/run.py --cli ../../packages/hy-cli/dist/main.js \
        --cwd . --mock --yes "Create the demo file"
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from hy_harness import Client  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="HY-HARNESS Python SDK example")
    parser.add_argument("message", nargs="?", default="Create the demo file")
    parser.add_argument("--cli", default=os.environ.get("HY_HARNESS_CLI", "hy"), help="path to hy-cli dist/main.js or an installed hy")
    parser.add_argument("--cwd", default=".")
    parser.add_argument("--mock", action="store_true", help="use the deterministic mock provider")
    parser.add_argument("--yes", action="store_true", help="auto-approve prompt decisions")
    parsed = parser.parse_args()

    args = []
    if parsed.mock:
        args.append("--mock")
    if parsed.yes:
        args.append("--yes")

    with Client(cli=parsed.cli, cwd=parsed.cwd, args=args) as client:
        info = client.initialize()
        print(f"server: {info.name} {info.version} (protocol {info.protocol_version}) in {info.cwd}")

        def on_event(event: dict) -> None:
            kind = event.get("type")
            if kind == "tool-start":
                print(f"  tool-start  {event.get('name')} {event.get('args')}")
            elif kind == "tool":
                print(f"  tool        {event.get('name')} done")
            elif kind == "tool-error":
                print(f"  tool-error  {event.get('name')}: {str(event.get('message'))[:120]}")
            elif kind == "retry":
                print(f"  retry       {event.get('reason')}")

        session = client.session_create()
        try:
            final = client.prompt(session, parsed.message, on_event=on_event)
            print("final:", final)
            return 0
        finally:
            client.session_close(session)


if __name__ == "__main__":
    sys.exit(main())
