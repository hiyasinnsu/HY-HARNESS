"""Drive HY-HARNESS from Python (harness SDK, WP-51).

The client speaks the harness's JSON-RPC 2.0 protocol over the stdio server
(``hy serve --sdk``). It only needs the standard library: a ``subprocess`` plus
two threads (one reads replies, one is unnecessary but kept simple).

    from hy_harness import Client

    with Client(cli="hy", cwd="/path/to/repo", args=["--mock", "--yes"]) as client:
        client.initialize()
        session = client.session_create()
        final = client.prompt(session, "SAY hello", on_event=lambda event: None)
        print(final)
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Optional


class HarnessError(RuntimeError):
    """The server answered with a JSON-RPC error."""


class Timeout(HarnessError):
    """A request did not get an answer in time."""


@dataclass
class ServerInfo:
    protocol_version: int
    name: str
    version: str
    cwd: str
    capabilities: dict


class Client:
    """A blocking client for one ``hy serve --sdk`` process."""

    def __init__(
        self,
        cli: Optional[str] = None,
        cwd: Optional[str] = None,
        args: Optional[Iterable[str]] = None,
        env: Optional[dict] = None,
        node: Optional[str] = None,
    ) -> None:
        self.cli = cli or os.environ.get("HY_HARNESS_CLI") or "hy"
        self.cwd = cwd
        self.args = list(args or [])
        self.env = dict(env or os.environ)
        self.node = node
        self._proc: Optional[subprocess.Popen] = None
        self._next_id = 1
        self._lock = threading.Lock()
        self._responses: "queue.Queue[dict]" = queue.Queue()
        self._events: "dict[str, list[Callable[[dict], None]]]" = {}
        self._reader: Optional[threading.Thread] = None
        self._stderr: list[str] = []

    # -- process ---------------------------------------------------------
    def start(self) -> "Client":
        command = self._command()
        self._proc = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=self.cwd,
            env=self.env,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self._reader = threading.Thread(target=self._read_stdout, daemon=True)
        self._reader.start()
        threading.Thread(target=self._read_stderr, daemon=True).start()
        return self

    def _command(self) -> "list[str]":
        cli = self.cli
        # A `.js` path means "run it with node"; otherwise the CLI is an exe on PATH.
        if cli.endswith(".js"):
            return [self.node or "node", cli, "serve", "--sdk", *self.args]
        return [cli, "serve", "--sdk", *self.args]

    def __enter__(self) -> "Client":
        return self.start()

    def __exit__(self, *_exc: Any) -> None:
        self.close()

    def close(self, timeout: float = 10.0) -> None:
        if self._proc is None:
            return
        try:
            self.request("shutdown", timeout=2.0)
        except Exception:
            pass
        try:
            if self._proc.stdin:
                self._proc.stdin.close()
        except Exception:
            pass
        try:
            self._proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self._proc.kill()
        self._proc = None

    def _read_stdout(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        for line in self._proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if message.get("id") is not None and message.get("method") is None:
                self._responses.put(message)
            elif message.get("method") == "session/event":
                params = message.get("params") or {}
                for callback in list(self._events.get(params.get("sessionId", ""), [])):
                    try:
                        callback(params.get("event") or {})
                    except Exception:
                        pass
            elif message.get("method") == "session/status":
                params = message.get("params") or {}
                for callback in list(self._events.get(params.get("sessionId", ""), [])):
                    try:
                        callback({"type": "status", **params})
                    except Exception:
                        pass

    def _read_stderr(self) -> None:
        assert self._proc is not None and self._proc.stderr is not None
        for line in self._proc.stderr:
            self._stderr.append(line)
            if len(self._stderr) > 200:
                del self._stderr[:100]

    # -- JSON-RPC --------------------------------------------------------
    def _write(self, message: dict) -> None:
        if self._proc is None or self._proc.stdin is None:
            raise HarnessError("the client is not started")
        self._proc.stdin.write(json.dumps(message) + "\n")
        self._proc.stdin.flush()

    def request(self, method: str, params: Optional[dict] = None, timeout: float = 300.0) -> Any:
        with self._lock:
            request_id = self._next_id
            self._next_id += 1
        self._write({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}})
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise Timeout(f"{method}: no answer in {timeout:.0f}s (stderr: {''.join(self._stderr[-5:])})")
            try:
                message = self._responses.get(timeout=min(remaining, 0.5))
            except queue.Empty:
                # A server that died will never answer: fail now, with its stderr.
                if self._proc is not None and self._proc.poll() is not None:
                    raise HarnessError(f"{method}: the server exited ({self._proc.returncode}): {''.join(self._stderr[-5:]).strip()}") from None
                continue
            if message.get("id") != request_id:
                # A late answer to an earlier request: keep it for that caller.
                self._responses.put(message)
                continue
            if "error" in message:
                raise HarnessError(str(message["error"].get("message", "request failed")))
            return message.get("result")

    # -- protocol --------------------------------------------------------
    def initialize(self) -> ServerInfo:
        result = self.request("initialize")
        return ServerInfo(
            protocol_version=result["protocolVersion"],
            name=result["serverInfo"]["name"],
            version=result["serverInfo"]["version"],
            cwd=result.get("cwd", ""),
            capabilities=result.get("capabilities", {}),
        )

    def session_create(self, cwd: Optional[str] = None) -> str:
        result = self.request("session.create", {"cwd": cwd} if cwd else {})
        return result["sessionId"]

    def session_resume(self, session_id: str) -> dict:
        return self.request("session.resume", {"sessionId": session_id})

    def prompt(
        self,
        session_id: str,
        message: str,
        images: Optional[list] = None,
        on_event: Optional[Callable[[dict], None]] = None,
        timeout: float = 600.0,
    ) -> str:
        if on_event is not None:
            self._events.setdefault(session_id, []).append(on_event)
        try:
            result = self.request(
                "session.prompt",
                {"sessionId": session_id, "message": message, **({"images": images} if images else {})},
                timeout=timeout,
            )
            return result["final"]
        finally:
            if on_event is not None:
                self._events.get(session_id, []).remove(on_event)

    def cancel(self, session_id: str) -> None:
        self.request("session.cancel", {"sessionId": session_id})

    def session_close(self, session_id: str) -> None:
        self.request("session.close", {"sessionId": session_id})
        self._events.pop(session_id, None)


class ProtocolClient(Client):
    """A blocking client for hy-protocol/1 (CP-30), the surface the CLI, the
    daemon and ACP share. It runs ``hy protocol serve`` over stdio.

        with ProtocolClient(cli="hy", cwd="/repo", args=["--mock"],
                            on_approval=lambda req: req["command"].startswith("npm test")) as c:
            c.initialize()
            result = c.turn("SAY hello", on_event=print)
            c.set_model("qwen2.5:7b")

    For the resident daemon (named pipe, WebSocket) use the TypeScript SDK
    (``connectDaemon``); Python's standard library has no WebSocket client.
    """

    def __init__(self, *args: Any, on_approval: Optional[Callable[[dict], bool]] = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.on_approval = on_approval
        self._turn_events: "dict[str, Callable[[dict, str], None]]" = {}
        self._tag = 0

    def _command(self) -> "list[str]":
        cli = self.cli
        if cli.endswith(".js"):
            return [self.node or "node", cli, "protocol", "serve", *self.args]
        return [cli, "protocol", "serve", *self.args]

    def close(self, timeout: float = 10.0) -> None:
        if self._proc is None:
            return
        try:
            if self._proc.stdin:
                self._proc.stdin.close()
        except Exception:
            pass
        try:
            self._proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self._proc.kill()
        self._proc = None

    def _read_stdout(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        for line in self._proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            method = message.get("method")
            if message.get("id") is not None and method is None:
                self._responses.put(message)
            elif method == "approval/request":
                threading.Thread(target=self._answer_approval, args=(message.get("params") or {},), daemon=True).start()
            elif method == "turn/event":
                params = message.get("params") or {}
                callback = self._turn_events.get(params.get("tag", ""))
                if callback is not None:
                    try:
                        callback(params.get("event") or {}, params.get("threadId", ""))
                    except Exception:
                        pass

    def _answer_approval(self, params: dict) -> None:
        approved = False
        if self.on_approval is not None:
            try:
                approved = bool(self.on_approval(params))
            except Exception:
                approved = False
        try:
            self.request("approval/respond", {"id": params.get("id"), "approved": approved}, timeout=30.0)
        except Exception:
            pass

    # -- hy-protocol/1 ----------------------------------------------------
    def initialize(self) -> ServerInfo:  # type: ignore[override]
        result = self.request("initialize", {"protocolVersion": "hy-protocol/1"})
        return ServerInfo(
            protocol_version=result["protocolVersion"],
            name=result["serverInfo"]["name"],
            version=result["serverInfo"]["version"],
            cwd="",
            capabilities=result.get("capabilities", {}),
        )

    def threads(self, limit: Optional[int] = None) -> "list[dict]":
        return self.request("thread/list", {} if limit is None else {"limit": limit})["threads"]

    def read_thread(self, thread_id: str, offset: Optional[int] = None, limit: Optional[int] = None) -> dict:
        params: dict = {"threadId": thread_id}
        if offset is not None:
            params["offset"] = offset
        if limit is not None:
            params["limit"] = limit
        return self.request("thread/read", params)

    def turn(
        self,
        message: str,
        thread_id: Optional[str] = None,
        images: Optional[list] = None,
        on_event: Optional[Callable[[dict, str], None]] = None,
        timeout: float = 600.0,
    ) -> dict:
        """Runs one turn; returns {"threadId", "final"}."""
        with self._lock:
            self._tag += 1
            tag = f"py-{os.getpid()}-{self._tag}"
        if on_event is not None:
            self._turn_events[tag] = on_event
        try:
            params: dict = {"message": message, "tag": tag}
            if thread_id:
                params["threadId"] = thread_id
            if images:
                params["images"] = images
            return self.request("turn/start", params, timeout=timeout)
        finally:
            self._turn_events.pop(tag, None)

    def cancel(self, thread_id: str) -> None:  # type: ignore[override]
        self.request("turn/cancel", {"threadId": thread_id})

    def steer(self, thread_id: str, message: str) -> None:
        self.request("turn/steer", {"threadId": thread_id, "message": message})

    def status(self, thread_id: str) -> dict:
        return self.request("turn/status", {"threadId": thread_id})

    def config_get(self) -> dict:
        return self.request("config/get")

    def config_set(self, key: str, value: Any) -> dict:
        return self.request("config/set", {"key": key, "value": value})

    def set_model(self, model: str, thread_id: Optional[str] = None) -> dict:
        params: dict = {"model": model}
        if thread_id:
            params["threadId"] = thread_id
        return self.request("model/set", params)

    def reload_mcp(self) -> dict:
        return self.request("mcpServer/reload")

    def reload_plugins(self) -> dict:
        return self.request("plugin/reload")


def run(cli: str, message: str, cwd: Optional[str] = None, args: Optional[Iterable[str]] = None) -> str:
    """One-shot helper: start a server, run one prompt, return the answer."""
    with Client(cli=cli, cwd=cwd, args=args) as client:
        client.initialize()
        session = client.session_create()
        try:
            return client.prompt(session, message)
        finally:
            client.session_close(session)


def main(argv: Optional[list] = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Run one prompt through HY-HARNESS")
    parser.add_argument("message")
    parser.add_argument("--cli", default=os.environ.get("HY_HARNESS_CLI", "hy"))
    parser.add_argument("--cwd", default=None)
    parser.add_argument("--mock", action="store_true")
    parser.add_argument("--yes", action="store_true")
    parsed = parser.parse_args(argv)
    args = []
    if parsed.mock:
        args.append("--mock")
    if parsed.yes:
        args.append("--yes")
    print(run(parsed.cli, parsed.message, cwd=parsed.cwd, args=args))
    return 0


if __name__ == "__main__":
    sys.exit(main())
