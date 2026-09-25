"""The resident loopback service: ``GET /health/*``, ``GET /v1/capabilities``, ``POST /v1/decide``.

Design constraints this file exists to satisfy:

* Bind is a loopback literal chosen at startup. Nothing a request contains can
  move it, and a non-loopback bind is refused rather than warned about.
* One worker owns the checkpoint. Extra requests queue, and the queue is bounded
  so overload is a retryable 429 rather than a pile of half-answered requests.
* A caller sends its *remaining* deadline. Queueing consumes it, and a request
  that arrives already out of time is answered TIMEOUT instead of starting work
  nobody is waiting for.
* Cancellation is discard-only, because llama.cpp cannot interrupt a decode in
  flight. We stop serving the result and say we could not stop computing it.
* Liveness loads nothing and needs no token; readiness reports that it is not
  ready without leaking the reason; capabilities are refused rather than invented.
"""

from __future__ import annotations

import argparse
import hmac
import json
import os
import queue
import re
import signal
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .lock import Lock, load_lock
from .protocol import ProtocolError, SCHEMA_VERSION, loads, parse_request
from .scoring import LocalScorer, ReadyError, evaluate

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8732
DEFAULT_TOKEN_ENV = "JEY_LOCAL_TOKEN"
DEFAULT_MAX_INPUT_BYTES = 32768
DEFAULT_QUEUE_DEPTH = 4
#: Bounds the read phase of a slow request. It is not a model timeout; that is the
#: caller's deadline, which is what actually limits a forward pass.
DEFAULT_SLOW_REQUEST_S = 10.0
LIVE_PATH = "/health/live"
PATHS = frozenset({LIVE_PATH, "/health/ready", "/v1/capabilities", "/v1/decide"})
LOOPBACK_IPV4 = re.compile(r"^127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$")


class ServiceError(Exception):
    def __init__(self, status: int, code: str, message: str, retryable: bool = False,
                 paths=None, request_id: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.retryable = retryable
        self.paths = list(paths or [])
        self.request_id = request_id

    def body(self) -> dict:
        # Field paths only: request content must never ride out inside an error.
        return {
            "schemaVersion": SCHEMA_VERSION,
            "requestId": self.request_id,
            "error": {"code": self.code, "retryable": self.retryable, "paths": self.paths},
        }


def is_loopback_host(host: str) -> bool:
    """Literal loopback only, matching ``isLoopbackEndpoint`` in the TypeScript client.

    ``localhost`` is deliberately excluded: it is resolver-dependent, and a guard that
    depends on the resolver is a guard that can be moved by /etc/hosts.
    """
    value = (host or "").strip().lower()
    if value.startswith("[") and value.endswith("]"):
        value = value[1:-1]
    return value == "::1" or bool(LOOPBACK_IPV4.match(value))


def host_without_port(header: str) -> str:
    """Bare host from a Host header, keeping an IPv6 literal intact."""
    value = (header or "").strip().lower()
    if value.startswith("["):
        end = value.find("]")
        return value if end < 0 else value[: end + 1]
    host, separator, port = value.partition(":")
    return host if separator and port.isdigit() else value


def stderr_line(text: str) -> None:
    print(text, file=sys.stderr, flush=True)


class Job:
    __slots__ = ("request", "deadline", "enqueued", "response", "error", "done", "abandoned")

    def __init__(self, request: dict, deadline: float):
        self.request = request
        self.deadline = deadline
        self.enqueued = time.monotonic()
        self.response: dict | None = None
        self.error: ServiceError | None = None
        self.done = threading.Event()
        self.abandoned = False


class Decider:
    """The single compute lane in front of one loaded checkpoint."""

    def __init__(self, scorer: LocalScorer | None, queue_depth: int):
        self.scorer = scorer
        self.pending: queue.Queue = queue.Queue(maxsize=max(0, queue_depth))
        self.stop = threading.Event()
        self.thread: threading.Thread | None = None
        self.served = 0
        self.late = 0
        self.discarded = 0

    def start(self) -> None:
        if self.scorer is None:
            return
        self.thread = threading.Thread(target=self._loop, name="jey-decider", daemon=True)
        self.thread.start()

    def _loop(self) -> None:
        while not self.stop.is_set():
            try:
                job = self.pending.get(timeout=0.25)
            except queue.Empty:
                continue
            self.run(job)
            self.pending.task_done()

    def run(self, job: Job) -> None:
        queued_ms = (time.monotonic() - job.enqueued) * 1000
        remaining = job.deadline - time.monotonic()
        if remaining <= 0:
            # Starting the forward pass here would spend a budget nobody is left to
            # collect an answer with.
            self.late += 1
            job.error = ServiceError(504, "TIMEOUT",
                                     "the deadline was already spent when the request reached the worker",
                                     paths=["budget.maxElapsedMs"],
                                     request_id=job.request.get("requestId"))
            job.done.set()
            return
        request_id = job.request.get("requestId")
        try:
            job.response = evaluate(self.scorer, job.request, queued_ms, job.enqueued, job.deadline)
            self.served += 1
        except ProtocolError as error:
            status = 422 if error.code == "UNSUPPORTED_CAPABILITY" else 400
            job.error = ServiceError(status, error.code, str(error), error.retryable, error.paths,
                                     request_id=request_id)
        except Exception as error:  # one bad decision must not take the service down
            job.error = ServiceError(502, "INVALID_RESPONSE", f"scoring failed: {error}",
                                     request_id=request_id)
        job.done.set()
        if job.abandoned:
            # We finished computing something nobody asked for. Reporting this as a
            # cancellation would be a lie, so it is counted separately.
            self.discarded += 1

    def submit(self, job: Job) -> None:
        try:
            self.pending.put_nowait(job)
        except queue.Full as error:
            raise ServiceError(429, "QUEUE_FULL",
                               f"{self.pending.maxsize} decisions are already queued",
                               retryable=True, paths=["queue"],
                               request_id=job.request.get("requestId")) from error

    def shutdown(self) -> None:
        self.stop.set()
        if self.thread is not None:
            self.thread.join(timeout=5)
        if self.scorer is not None:
            self.scorer.close()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "jey-local-decider"
    sys_version = ""

    # Configuration lives on the server; these keep the handlers readable while making
    # it impossible for one request to mutate what the next one sees.
    @property
    def decider(self) -> Decider:
        return self.server.decider

    @property
    def token(self) -> str:
        return self.server.token

    @property
    def max_input_bytes(self) -> int:
        return self.server.max_input_bytes

    def setup(self) -> None:
        # A per-connection read timeout, so a slow body cannot hold a worker hostage.
        # It bounds reading, not the model: the caller's deadline does that.
        self.timeout = self.server.slow_request_s
        super().setup()

    def version_string(self) -> str:  # no Python version on the wire
        return "jey-local-decider"

    def log_message(self, fmt, *args) -> None:  # replaced by the one-line access log
        pass

    def _access(self, status: int, path: str, code: str | None, ms: float) -> None:
        # Status, endpoint, code, latency. Never the state, the questions, or anything
        # else that could turn an operational log into a copy of what was asked.
        self.server.log(f"jey-local {status} {path} {code or '-'} {ms:.1f}ms")

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # The caller stopped listening. The computation, if any, already happened.
            self.server.decider.discarded += 1

    def _fail(self, error: ServiceError, path: str, started: float) -> None:
        self._send(error.status, error.body())
        self._access(error.status, path, error.code, (time.monotonic() - started) * 1000)

    def _guard(self, method: str) -> tuple[str, ServiceError | None]:
        """Everything that must be rejected before a body is read or parsed."""
        path = (self.path or "/").split("?", 1)[0]
        if path not in PATHS:
            return path, ServiceError(404, "INVALID_INPUT", "unknown endpoint", paths=["path"])
        if not is_loopback_host(host_without_port(self.headers.get("host"))):
            # The local origin is configured, not discovered from a header.
            return path, ServiceError(400, "EGRESS_DENIED", "Host is not the configured loopback origin",
                                      paths=["host"])
        if self.headers.get("origin") is not None:
            return path, ServiceError(403, "EGRESS_DENIED", "cross-origin calls are not enabled",
                                      paths=["origin"])
        expected = {"GET": {LIVE_PATH, "/health/ready", "/v1/capabilities"}, "POST": {"/v1/decide"}}
        if path not in expected[method]:
            return path, ServiceError(405, "INVALID_INPUT", f"{method} is not allowed on {path}",
                                      paths=["method"])
        if path != LIVE_PATH and not self._authorized():
            return path, ServiceError(401, "AUTH", "missing or incorrect bearer token", paths=["authorization"])
        return path, None

    def _authorized(self) -> bool:
        header = self.headers.get("authorization") or ""
        prefix = "Bearer "
        if not header.startswith(prefix):
            return False
        supplied = header[len(prefix):].encode("utf-8")
        wanted = self.token.encode("utf-8")
        return hmac.compare_digest(supplied, wanted)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler naming
        path, error = self._guard("GET")
        started = time.monotonic()
        if error is not None:
            return self._fail(error, path, started)
        if path == LIVE_PATH:
            self._send(200, {"live": True})
            self._access(200, path, None, (time.monotonic() - started) * 1000)
            return
        if path == "/health/ready":
            ready = self.decider.scorer is not None
            status = 200 if ready else 503
            self._send(status, {"ready": ready} if ready else {"ready": False, "code": "LOCAL_NOT_READY"})
            self._access(status, path, None if ready else "LOCAL_NOT_READY",
                         (time.monotonic() - started) * 1000)
            return
        if self.decider.scorer is None:
            # A model we do not have cannot be described: no placeholder identity.
            error = ServiceError(503, "LOCAL_NOT_READY", "capabilities require a loaded model",
                                 retryable=True, paths=["provider"])
            return self._fail(error, path, started)
        self._send(200, self.decider.scorer.capabilities(self.max_input_bytes))
        self._access(200, path, None, (time.monotonic() - started) * 1000)

    def do_POST(self) -> None:  # noqa: N802
        path, error = self._guard("POST")
        started = time.monotonic()
        if error is not None:
            return self._fail(error, path, started)
        decider = self.decider
        length = self.headers.get("content-length")
        if length is None:
            error = ServiceError(411, "INVALID_INPUT", "content-length is required", paths=["content-length"])
            return self._fail(error, path, started)
        try:
            size = int(length)
        except ValueError:
            return self._fail(ServiceError(400, "INVALID_INPUT", "content-length is not a number",
                                           paths=["content-length"]), path, started)
        if size < 0 or size > self.max_input_bytes:
            error = ServiceError(413, "INVALID_INPUT",
                                 f"body is {size} bytes, over the {self.max_input_bytes} byte service bound",
                                 paths=["body"])
            return self._fail(error, path, started)
        try:
            body = self.rfile.read(size)
        except socket.timeout:
            return self._fail(ServiceError(408, "TIMEOUT", "body arrived too slowly", paths=["body"]),
                              path, started)
        if len(body) != size:
            return self._fail(ServiceError(400, "INVALID_INPUT", "body is shorter than content-length",
                                           paths=["body"]), path, started)

        request_id: str | None = None
        try:
            request = parse_request(loads(body))
            request_id = request["requestId"]
            # The effective bound is the stricter of the service config and what the
            # caller says it can afford. A larger number in the request is not a grant.
            bound = min(self.max_input_bytes, int(request["budget"]["maxInputBytes"]))
            if size > bound:
                raise ServiceError(413, "INVALID_INPUT",
                                   f"body is {size} bytes, over the {bound} byte effective bound",
                                   paths=["budget.maxInputBytes"], request_id=request_id)
        except ProtocolError as error:
            return self._fail(ServiceError(400, error.code, str(error), error.retryable, error.paths,
                                           request_id=request_id), path, started)
        except ServiceError as error:
            return self._fail(error, path, started)

        if decider.scorer is None or decider.thread is None:
            error = ServiceError(503, "LOCAL_NOT_READY", "no model is loaded", retryable=True,
                                 paths=["provider"], request_id=request_id)
            return self._fail(error, path, started)

        deadline_s = min(float(request["budget"]["maxElapsedMs"]), MAX_DEADLINE_MS) / 1000.0
        job = Job(request, time.monotonic() + deadline_s)
        try:
            decider.submit(job)
        except ServiceError as error:
            error.request_id = request_id
            return self._fail(error, path, started)
        # A small grace period so a worker that is mid-decode can still be read; the
        # client is measuring its own latency and will not wait for us.
        if not job.done.wait(deadline_s + GRACE_S):
            job.abandoned = True
            decider.discarded += 1
            error = ServiceError(504, "TIMEOUT", "the decision did not finish inside the remaining deadline",
                                 paths=["budget.maxElapsedMs"], request_id=request_id)
            return self._fail(error, path, started)
        if job.error is not None:
            return self._fail(job.error, path, started)
        self._send(200, job.response)
        self._access(200, path, job.response["status"], (time.monotonic() - started) * 1000)


#: A response is written this long after the caller's own deadline at most; past it the
#: answer is dropped rather than held.
GRACE_S = 0.25
#: Server-side ceiling on a caller-supplied deadline. Configuration can only tighten a
#: budget, never widen one, so a request cannot ask for an unbounded forward pass.
#: 60000 matches `limits.deadlineMs.maximum` in config/config.schema.json: above that,
#: the client could not have been configured to ask in the first place.
MAX_DEADLINE_MS = int(os.environ.get("JEY_LOCAL_MAX_DEADLINE_MS", "60000"))


def serve(host: str, port: int, decider: Decider, token: str, max_input_bytes: int,
          slow_request_s: float, log=stderr_line) -> ThreadingHTTPServer:
    if not is_loopback_host(host):
        raise ValueError(f"refusing to bind {host!r}: the local service is loopback-only")
    if not token:
        raise ValueError("refusing to serve without a token")
    server = ThreadingHTTPServer((host, port), Handler)
    server.decider = decider
    server.token = token
    server.max_input_bytes = max_input_bytes
    server.slow_request_s = slow_request_s
    server.log = log
    server.daemon_threads = True
    return server


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Jey local decider (loopback-only)")
    parser.add_argument("--host", default=os.environ.get("JEY_LOCAL_HOST", DEFAULT_HOST))
    parser.add_argument("--port", type=int, default=int(os.environ.get("JEY_LOCAL_PORT", DEFAULT_PORT)))
    parser.add_argument("--token-env", default=os.environ.get("JEY_LOCAL_TOKEN_ENV", DEFAULT_TOKEN_ENV))
    parser.add_argument("--max-input-bytes", type=int,
                        default=int(os.environ.get("JEY_LOCAL_MAX_INPUT_BYTES", DEFAULT_MAX_INPUT_BYTES)))
    parser.add_argument("--queue-depth", type=int,
                        default=int(os.environ.get("JEY_LOCAL_QUEUE_DEPTH", DEFAULT_QUEUE_DEPTH)))
    parser.add_argument("--slow-request-s", type=float,
                        default=float(os.environ.get("JEY_LOCAL_SLOW_REQUEST_S", DEFAULT_SLOW_REQUEST_S)))
    parser.add_argument("--lock", type=Path, default=None)
    parser.add_argument("--repo-root", type=Path, default=None)
    args = parser.parse_args(argv)

    if not is_loopback_host(args.host):
        print(f"refusing to bind {args.host!r}: the local service is loopback-only", file=sys.stderr)
        return 2
    token = os.environ.get(args.token_env, "")
    if not token:
        # An unauthenticated local service is one browser page away from anyone on the
        # host, so there is no "just this once" mode here.
        print(f"refusing to start: {args.token_env} is unset or empty", file=sys.stderr)
        return 2
    if args.max_input_bytes < 1024:
        print("refusing to start: --max-input-bytes below 1 KiB cannot carry a decision", file=sys.stderr)
        return 2

    lock: Lock = load_lock(args.lock)
    repo_root = args.repo_root or lock.path.parents[1]
    try:
        scorer = LocalScorer.load(lock, repo_root)
    except ReadyError as error:
        print(f"not ready: {error}", file=sys.stderr)
        scorer = None

    decider = Decider(scorer, args.queue_depth)
    decider.start()
    server = serve(args.host, args.port, decider, token, args.max_input_bytes, args.slow_request_s)

    def stop(signum, frame) -> None:  # noqa: ARG001
        raise KeyboardInterrupt

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    print(f"jey-local listening on http://{args.host}:{server.server_address[1]} "
          f"ready={scorer is not None} weights={lock.weights_file}", file=sys.stderr, flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()
        decider.shutdown()
        print(f"jey-local closed served={decider.served} late={decider.late} discarded={decider.discarded}",
              file=sys.stderr, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
