"""Wire validation for Jey's loopback decision protocol.

The TypeScript client (`packages/provider-local`) validates responses; this
module is the server-side mirror of `packages/core/src/validate.ts` for
requests. The two must agree, because a request one of them accepts and the
other rejects shows up as a provider error rather than a clean 400.
"""

from __future__ import annotations

import json
from typing import Any

SCHEMA_VERSION = "1"

PURPOSES = frozenset({
    "tool-assessment", "tool-relevance", "evidence-check", "explicit-query",
})
QUESTION_KINDS = ("boolean", "choice", "score")
PROVIDER_KINDS = frozenset({"mock", "local", "typesafe"})
ERROR_CODES = frozenset({
    "INVALID_INPUT", "UNSUPPORTED_CAPABILITY", "AUTH", "RATE_LIMIT", "OVERLOADED",
    "TIMEOUT", "CANCELLED", "QUEUE_FULL", "BUDGET_EXCEEDED", "INVALID_RESPONSE",
    "INSUFFICIENT_CONTEXT", "STALE_SNAPSHOT", "LOCAL_NOT_READY", "EGRESS_DENIED",
})
ANSWER_STATUSES = frozenset({"answered", "abstained", "error"})


class ProtocolError(Exception):
    """A rejection with the code, retryability, and field paths a client needs."""

    def __init__(self, code: str, paths: list[str], message: str, retryable: bool = False):
        super().__init__(message)
        if code not in ERROR_CODES:
            raise ValueError(f"refusing to emit unknown error code {code!r}")
        self.code = code
        self.paths = list(paths)
        self.retryable = retryable

    def body(self, request_id: str | None = None) -> dict:
        # Paths are field names only. Raw prompts, arguments, and state never cross
        # this boundary in an error, so an error log cannot become a content leak.
        return {
            "schemaVersion": SCHEMA_VERSION,
            "requestId": request_id,
            "error": {"code": self.code, "retryable": self.retryable, "paths": self.paths},
        }


class _Collector:
    def __init__(self) -> None:
        self.paths: list[str] = []

    def want(self, ok: bool, path: str) -> bool:
        if not ok:
            self.paths.append(path)
        return ok


def _is_object(value) -> bool:
    return isinstance(value, dict)


def _is_str(value) -> bool:
    return isinstance(value, str)


def _is_num(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value \
        and abs(value) != float("inf")


def _is_int(value) -> bool:
    return _is_num(value) and float(value).is_integer() and value >= 0


def _finite_constant(name: str):
    # json.loads accepts NaN/Infinity by default; JSON has no such literal and the
    # TypeScript validator rejects both, so reject them at the parse step.
    raise ProtocolError("INVALID_INPUT", [f"$.{name}"], f"{name} is not valid JSON")


def loads(body: bytes) -> Any:
    """Parse a request body the way the boundary contract says to parse it."""
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ProtocolError("INVALID_INPUT", ["<body>"], f"body is not valid UTF-8: {error}") from error
    try:
        return json.loads(text, parse_constant=_finite_constant)
    except RecursionError as error:
        raise ProtocolError("INVALID_INPUT", ["<body>"], "body is nested too deeply") from error
    except ProtocolError:
        raise
    except ValueError as error:
        raise ProtocolError("INVALID_INPUT", ["<body>"], f"body is not JSON: {error}") from error


def parse_snapshot(value, path: str) -> dict:
    mark = _Collector()
    if not _is_object(value):
        raise ProtocolError("INVALID_INPUT", [path], "snapshot must be an object")
    for key, test in (
        ("sessionId", _is_str), ("agentId", _is_str), ("turn", _is_int), ("step", _is_int),
        ("generation", _is_int), ("taskVersion", _is_int), ("policyVersion", _is_str),
        ("catalogDigest", lambda v: _is_str(v) and v != ""),
        ("observationSequence", _is_int),
    ):
        mark.want(test(value.get(key)), f"{path}.{key}")
    digest = value.get("callDigest")
    if digest is not None and not _is_str(digest):
        mark.paths.append(f"{path}.callDigest")
    if mark.paths:
        raise ProtocolError("INVALID_INPUT", mark.paths, "invalid snapshot")
    return value


def is_json_value(value) -> bool:
    if value is None or isinstance(value, (bool, str)):
        return True
    if isinstance(value, (int, float)):
        return _is_num(value)
    if isinstance(value, list):
        return all(is_json_value(item) for item in value)
    if isinstance(value, dict):
        return all(isinstance(k, str) and is_json_value(v) for k, v in value.items())
    return False


def parse_question(value, path: str) -> dict:
    if not _is_object(value):
        raise ProtocolError("INVALID_INPUT", [path], "question must be an object")
    mark = _Collector()
    mark.want(_is_str(value.get("id")), f"{path}.id")
    mark.want(_is_str(value.get("instructions")), f"{path}.instructions")
    kind = value.get("kind")
    if kind == "boolean":
        pass
    elif kind == "choice":
        options = value.get("options")
        if not isinstance(options, list) or len(options) < 2:
            mark.paths.append(f"{path}.options")
        else:
            for index, option in enumerate(options):
                if not _is_object(option) or not _is_str(option.get("id")) or not _is_str(option.get("description")):
                    mark.paths.append(f"{path}.options[{index}]")
    elif kind == "score":
        levels = value.get("levels")
        if not isinstance(levels, list) or len(levels) < 2 or not all(_is_str(l) for l in levels):
            mark.paths.append(f"{path}.levels")
    else:
        mark.paths.append(f"{path}.kind")
    if mark.paths:
        raise ProtocolError("INVALID_INPUT", mark.paths, "invalid question")
    return value


def parse_request(raw) -> dict:
    """Return the request unchanged once it is known to match the contract."""
    if not _is_object(raw):
        raise ProtocolError("INVALID_INPUT", ["$"], "request must be an object")
    mark = _Collector()
    if raw.get("schemaVersion") != SCHEMA_VERSION:
        mark.paths.append("schemaVersion")
    request_id = raw.get("requestId")
    mark.want(_is_str(request_id) and request_id != "", "requestId")
    if raw.get("purpose") not in PURPOSES:
        mark.paths.append("purpose")
    questions = raw.get("questions")
    if not isinstance(questions, list) or not questions:
        mark.paths.append("questions")
    budget = raw.get("budget")
    if not _is_object(budget):
        mark.paths.append("budget")
    else:
        mark.want(_is_num(budget.get("maxElapsedMs")), "budget.maxElapsedMs")
        mark.want(_is_num(budget.get("maxInputBytes")), "budget.maxInputBytes")
    try:
        parse_snapshot(raw.get("snapshot"), "snapshot")
    except ProtocolError as error:
        mark.paths.extend(error.paths)
    if mark.paths:
        raise ProtocolError("INVALID_INPUT", mark.paths, "invalid request")

    parsed = [parse_question(q, f"questions[{index}]") for index, q in enumerate(questions)]
    ids = [q["id"] for q in parsed]
    if len(set(ids)) != len(ids):
        raise ProtocolError("INVALID_INPUT", ["questions"], "duplicate question id")
    if not is_json_value(raw.get("state")):
        raise ProtocolError("INVALID_INPUT", ["state"], "request state is not finite JSON")
    if budget["maxElapsedMs"] <= 0 or budget["maxInputBytes"] <= 0:
        raise ProtocolError("INVALID_INPUT", ["budget"], "budget must be positive")
    return raw
