"""HTTP behaviour of the loopback service, exercised over a real socket.

No model is loaded here: the scorer is a stub, so every assertion is about the
protocol surface (auth, origin, size, status codes, error shape, queueing). The
real checkpoint is covered by ``test_inference.py`` and by the TypeScript
end-to-end run, and nothing in this file is evidence about scoring quality.
"""

from __future__ import annotations

import http.client
import json
import threading
import time
import unittest

from local_decider.scoring import MAX_QUESTIONS, options_for
from local_decider.service import (
    GRACE_S, Decider, host_without_port, is_loopback_host, serve,
)

TOKEN = "local-token-value"
SECRET = "C:\\Users\\victim\\private\\ledger.txt"
SNAPSHOT = {
    "sessionId": "s", "agentId": "a", "turn": 1, "step": 2, "generation": 1,
    "taskVersion": 1, "policyVersion": "p", "catalogDigest": "d", "callDigest": None,
    "observationSequence": 3,
}


def decide(questions=None, state=None, budget_ms=30000, max_input_bytes=32768, request_id="r1",
           purpose="tool-assessment", schema_version="1"):
    return {
        "schemaVersion": schema_version, "requestId": request_id, "purpose": purpose,
        "snapshot": dict(SNAPSHOT),
        "state": state if state is not None else {"userTask": "find the failing test"},
        "questions": questions if questions is not None else
        [{"kind": "boolean", "id": "relevant", "instructions": "Is this call relevant?"}],
        "budget": {"maxElapsedMs": budget_ms, "maxInputBytes": max_input_bytes},
    }


class StubScorer:
    """A stand-in for a loaded checkpoint: identity plus canned probabilities."""

    def __init__(self, block: threading.Event | None = None, entered: threading.Event | None = None):
        self.identity = {
            "kind": "local", "providerVersion": "stub/1", "requestedModel": "repo@rev",
            "resolvedModel": "repo@rev#file.gguf", "modelRevision": "m" * 40,
            "weightsDigest": "w" * 64, "tokenizerRevision": "t" * 40, "templateDigest": "d" * 64,
            "quantization": "Q4_K_M", "synthetic": False,
        }
        self.block = block
        self.entered = entered
        self.calls = 0

    def capabilities(self, max_input_bytes: int) -> dict:
        return {
            "schemaVersion": "1", "provider": self.identity,
            "questionKinds": ["boolean", "choice", "score"], "maxInputBytes": max_input_bytes,
            "maxQuestions": MAX_QUESTIONS, "cancellation": "discard-only",
        }

    def score_question(self, question, state):
        self.calls += 1
        if self.entered is not None:
            self.entered.set()
        if self.block is not None:
            self.block.wait(5)
        ids = [option["id"] for option in options_for(question)]
        weight = 0.8
        return {"option_ids": ids, "probabilities": [weight] + [(1 - weight) / (len(ids) - 1)] * (len(ids) - 1),
                "input_tokens": 128}

    def close(self) -> None:
        pass


class ServiceCase(unittest.TestCase):
    scorer: StubScorer | None = None
    queue_depth = 4
    max_input_bytes = 32768

    def setUp(self) -> None:
        self.lines: list[str] = []
        self.lock = threading.Lock()
        self.decider = Decider(self.scorer, self.queue_depth)
        self.decider.start()
        self.server = serve("127.0.0.1", 0, self.decider, TOKEN, self.max_input_bytes, 5.0,
                            log=self._log)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05},
                                       daemon=True)
        self.thread.start()
        self.addCleanup(self.tearDown_service)

    def _log(self, text: str) -> None:
        with self.lock:
            self.lines.append(text)

    def logged(self, at_least: int) -> list[str]:
        """The access line is written after the response, so a client can outrun it."""
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            with self.lock:
                if len(self.lines) >= at_least:
                    return list(self.lines)
            time.sleep(0.01)
        self.fail(f"expected {at_least} access log lines, got {self.lines}")

    def tearDown_service(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.decider.shutdown()
        self.thread.join(timeout=5)

    def call(self, method: str, path: str, *, body=None, token=TOKEN, host=None,
             origin=None, content_length=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        self.addCleanup(connection.close)
        headers = {}
        if token is not None:
            headers["authorization"] = f"Bearer {token}" if not token.startswith("BadAuth") else token
        if origin is not None:
            headers["origin"] = origin
        payload = None
        if body is not None:
            payload = body if isinstance(body, bytes) else json.dumps(body).encode()
            headers["content-type"] = "application/json"
        if host is None:
            connection.request(method, path, body=payload, headers=headers)
        else:
            connection.putrequest(method, path, skip_host=True)
            for key, value in headers.items():
                connection.putheader(key, value)
            connection.putheader("Host", host)
            if content_length is not None:
                connection.putheader("Content-Length", str(content_length))
            connection.endheaders(payload)
        response = connection.getresponse()
        raw = response.read()
        return response, raw


class ReadyAndRejectionTest(ServiceCase):
    scorer = StubScorer()

    def test_live_needs_no_token_and_leaks_nothing(self) -> None:
        response, raw = self.call("GET", "/health/live", token=None)
        self.assertEqual((response.status, json.loads(raw)), (200, {"live": True}))
        self.assertNotIn("Traceback", raw.decode("utf-8", "replace"))

    def test_the_server_identifies_itself_without_a_python_version(self) -> None:
        response, _ = self.call("GET", "/health/live")
        self.assertEqual(response.getheader("server"), "jey-local-decider")
        self.assertIsNone(response.getheader("access-control-allow-origin"))

    def test_every_endpoint_but_live_requires_the_token(self) -> None:
        for method, path in (("GET", "/health/ready"), ("GET", "/v1/capabilities"), ("POST", "/v1/decide")):
            with self.subTest(path):
                body = decide() if method == "POST" else None
                for token in (None, "", "nope", TOKEN[:-1]):
                    response, raw = self.call(method, path, body=body, token=token)
                    self.assertEqual(response.status, 401, f"{path} accepted token {token!r}")
                    self.assertEqual(json.loads(raw)["error"]["code"], "AUTH")

    def test_a_foreign_host_header_is_refused_even_on_the_public_probe(self) -> None:
        for host in ("evil.example", "localhost", "0.0.0.0", "10.0.0.5", "[::ffff:127.0.0.1]"):
            with self.subTest(host):
                response, raw = self.call("GET", "/health/live", host=host, token=None)
                self.assertEqual(response.status, 400)
                self.assertEqual(json.loads(raw)["error"]["code"], "EGRESS_DENIED")

    def test_a_browser_origin_is_refused(self) -> None:
        response, raw = self.call("GET", "/health/ready", origin="http://127.0.0.1:8732")
        self.assertEqual(response.status, 403)
        self.assertEqual(json.loads(raw)["error"]["code"], "EGRESS_DENIED")

    def test_unknown_paths_and_wrong_methods_are_rejected_before_any_work(self) -> None:
        cases = [("GET", "/v1/decide", 405), ("POST", "/health/ready", 405), ("GET", "/admin", 404),
                 ("GET", "/v1/capabilities?x=1", 200)]
        for method, target, expected in cases:
            with self.subTest(target):
                response, _ = self.call(method, target, body=decide() if method == "POST" else None)
                self.assertEqual(response.status, expected)


class CapabilitiesTest(ServiceCase):
    scorer = StubScorer()

    def test_capabilities_describe_the_loaded_model_or_refuse_to_guess(self) -> None:
        _, raw = self.call("GET", "/v1/capabilities")
        payload = json.loads(raw)
        self.assertEqual(payload["cancellation"], "discard-only")
        self.assertEqual(payload["questionKinds"], ["boolean", "choice", "score"])
        self.assertEqual(payload["maxQuestions"], MAX_QUESTIONS)
        self.assertEqual(payload["maxInputBytes"], self.max_input_bytes)
        self.assertEqual(payload["provider"]["kind"], "local")
        self.assertFalse(payload["provider"]["synthetic"])
        for field in ("modelRevision", "tokenizerRevision", "weightsDigest", "templateDigest"):
            self.assertIsInstance(payload["provider"][field], str)
            self.assertTrue(payload["provider"][field])

    def test_an_unloaded_service_reports_not_ready_rather_than_a_placeholder_identity(self) -> None:
        for method, path in (("GET", "/health/ready"), ("GET", "/v1/capabilities"), ("POST", "/v1/decide")):
            with self.subTest(path):
                previous = self.decider.scorer
                self.decider.scorer = None
                try:
                    response, raw = self.call(method, path, body=decide() if method == "POST" else None)
                finally:
                    self.decider.scorer = previous
                self.assertEqual(response.status, 503)
                payload = json.loads(raw)
                code = payload["error"]["code"] if "error" in payload else payload.get("code")
                self.assertEqual(code, "LOCAL_NOT_READY")
                self.assertNotIn("provider", payload)


class DecideTest(ServiceCase):
    scorer = StubScorer()

    def test_a_valid_request_gets_a_full_observation_envelope(self) -> None:
        questions = [
            {"kind": "boolean", "id": "relevant", "instructions": "Relevant?"},
            {"kind": "choice", "id": "risk", "instructions": "Risky?",
             "options": [{"id": "low", "description": "Low"}, {"id": "high", "description": "High"}]},
            {"kind": "score", "id": "severity", "instructions": "How severe?",
             "levels": ["none", "minor", "major"]},
        ]
        response, raw = self.call("POST", "/v1/decide", body=decide(questions=questions))
        self.assertEqual(response.status, 200)
        payload = json.loads(raw)
        self.assertEqual(payload["schemaVersion"], "1")
        self.assertEqual(payload["requestId"], "r1")
        self.assertEqual(payload["snapshot"], SNAPSHOT)
        self.assertEqual(payload["status"], "ok")
        self.assertEqual([o["id"] for o in payload["outcomes"]], ["relevant", "risk", "severity"])
        boolean, choice, score = (o["answer"] for o in payload["outcomes"])
        self.assertAlmostEqual(boolean["pYes"], 0.8)
        self.assertEqual(boolean["probability"],
                         {"origin": "native-logits", "calibration": "uncalibrated", "calibrationId": None})
        self.assertEqual(sorted(choice["probabilities"]), ["high", "low"])
        self.assertEqual(choice["selected"], "low")
        self.assertEqual(list(score["probabilities"]), ["0", "1", "2"])
        self.assertAlmostEqual(score["expectedIndex"], 0.8 * 0 + 0.1 * 1 + 0.1 * 2)
        self.assertEqual(payload["usage"], {"inputTokens": 384, "outputTokens": 0,
                                            "costUsd": None, "costBasis": "unknown"})
        self.assertEqual(payload["egress"], {"occurred": False, "destinationId": None})
        for field in ("queueMs", "inferenceMs", "totalMs"):
            self.assertIsInstance(payload["timing"][field], int)

    def test_malformed_bodies_are_invalid_input_and_never_echo_content(self) -> None:
        not_json = b'{"schemaVersion": '
        with_nan = b'{"schemaVersion":"1","requestId":"r1","purpose":"tool-assessment",' \
                   b'"state":{"x":NaN},"questions":[{"kind":"boolean","id":"a","instructions":"?"}],' \
                   b'"budget":{"maxElapsedMs":1000,"maxInputBytes":1024},' \
                   b'"snapshot":{"sessionId":"s","agentId":"a","turn":1,"step":1,"generation":1,' \
                   b'"taskVersion":1,"policyVersion":"p","catalogDigest":"d","callDigest":null,' \
                   b'"observationSequence":1}}'
        cases = {
            "not json": not_json,
            "nan": with_nan,
            "no questions": json.dumps(decide(questions=[])).encode(),
            "duplicate ids": json.dumps(decide(questions=[
                {"kind": "boolean", "id": "a", "instructions": "?"},
                {"kind": "boolean", "id": "a", "instructions": "?"}])).encode(),
            "bad purpose": json.dumps(decide(purpose="vibes")).encode(),
            "wrong schema": json.dumps(decide(schema_version="2")).encode(),
            "not an object": b"[1,2,3]",
        }
        for label, body in cases.items():
            with self.subTest(label):
                response, raw = self.call("POST", "/v1/decide", body=body)
                self.assertEqual(response.status, 400, label)
                error = json.loads(raw)["error"]
                self.assertEqual(error["code"], "INVALID_INPUT")
                self.assertTrue(error["paths"], label)

    def test_a_body_larger_than_the_service_bound_is_rejected_before_parsing(self) -> None:
        big = decide(state={"blob": "x" * (self.max_input_bytes + 10)})
        response, raw = self.call("POST", "/v1/decide", body=big)
        self.assertEqual(response.status, 413)
        self.assertEqual(json.loads(raw)["error"]["paths"], ["body"])

    def test_a_caller_cannot_raise_the_bound_by_asking_for_one(self) -> None:
        body = decide(state={"blob": "x" * 2048}, max_input_bytes=1024)
        response, raw = self.call("POST", "/v1/decide", body=body)
        self.assertEqual(response.status, 413)
        error = json.loads(raw)["error"]
        self.assertEqual(error["paths"], ["budget.maxInputBytes"])
        self.assertNotIn("xxxxx", raw.decode())

    def test_missing_content_length_is_rejected(self) -> None:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        self.addCleanup(connection.close)
        connection.putrequest("POST", "/v1/decide", skip_host=True)
        connection.putheader("Host", f"127.0.0.1:{self.port}")
        connection.putheader("authorization", f"Bearer {TOKEN}")
        connection.putheader("content-type", "application/json")
        connection.endheaders()
        response = connection.getresponse()
        response.read()
        self.assertEqual(response.status, 411)

    def test_too_many_questions_is_a_capability_rejection(self) -> None:
        questions = [{"kind": "boolean", "id": f"q{i}", "instructions": "?"} for i in range(MAX_QUESTIONS + 1)]
        response, raw = self.call("POST", "/v1/decide", body=decide(questions=questions))
        self.assertEqual(response.status, 422)
        self.assertEqual(json.loads(raw)["error"]["code"], "UNSUPPORTED_CAPABILITY")

    def test_neither_the_error_body_nor_the_access_log_carries_request_content(self) -> None:
        self.call("POST", "/v1/decide", body=decide(state={"secretPath": SECRET}))
        self.call("POST", "/v1/decide", body=decide(state={"secretPath": SECRET + "2"}, questions=[]))
        joined = "\n".join(self.logged(2))
        self.assertNotIn(SECRET, joined)
        self.assertNotIn("secretPath", joined)
        self.assertNotIn("relevant", joined)
        self.assertIn(" 200 /v1/decide ok ", joined)
        self.assertIn(" 400 /v1/decide INVALID_INPUT ", joined)


class QueueTest(ServiceCase):
    def setUp(self) -> None:
        self.release = threading.Event()
        self.entered = threading.Event()
        self.scorer = StubScorer(block=self.release, entered=self.entered)
        self.queue_depth = 1
        super().setUp()

    def test_a_blocked_worker_turns_extra_load_into_a_bounded_429(self) -> None:
        busy = threading.Thread(target=self.call, args=("POST", "/v1/decide"),
                               kwargs={"body": decide(request_id="busy")})
        self.responses = []
        busy.start()
        self.assertTrue(self.entered.wait(5), "the worker never picked up the first request")
        second = threading.Thread(target=lambda: self.responses.append(
            self.call("POST", "/v1/decide", body=decide(request_id="queued"))))
        second.start()
        # Give the queued request a moment to land in the queue before the third arrives.
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and self.decider.pending.qsize() == 0:
            time.sleep(0.01)
        third_status = self.call("POST", "/v1/decide", body=decide(request_id="overflow"))[0].status
        self.release.set()
        busy.join(10)
        second.join(10)
        self.assertEqual(third_status, 429)
        queued, = self.responses
        self.assertEqual(queued[0].status, 200)
        self.assertEqual(json.loads(queued[1])["requestId"], "queued")
        self.assertEqual(self.decider.served, 2)

    def test_a_deadline_spent_while_queued_is_a_timeout_not_a_stalled_connection(self) -> None:
        self.entered.clear()
        blocked = threading.Thread(target=self.call, args=("POST", "/v1/decide"),
                                  kwargs={"body": decide(request_id="busy", budget_ms=30000)})
        blocked.start()
        self.assertTrue(self.entered.wait(5))
        started = time.monotonic()
        response, raw = self.call("POST", "/v1/decide", body=decide(request_id="late", budget_ms=5))
        elapsed = time.monotonic() - started
        self.release.set()
        blocked.join(10)
        self.assertEqual(response.status, 504)
        self.assertEqual(json.loads(raw)["error"]["code"], "TIMEOUT")
        # The caller learns "too late" in about its own deadline plus the grace period,
        # not after whatever the stuck forward pass happens to take.
        self.assertLess(elapsed, GRACE_S + 1.0)


class GuardTest(unittest.TestCase):
    """The two refusals that happen before a socket exists at all."""

    def test_a_non_loopback_bind_and_an_empty_token_are_refused(self) -> None:
        decider = Decider(None, 0)
        for host in ("0.0.0.0", "localhost", "::", "10.0.0.7", "evil.example"):
            with self.subTest(host):
                with self.assertRaises(ValueError):
                    serve(host, 0, decider, TOKEN, 32768, 5.0)
        with self.assertRaises(ValueError):
            serve("127.0.0.1", 0, decider, "", 32768, 5.0)

    def test_loopback_literals_are_recognised_and_names_are_not(self) -> None:
        for host in ("127.0.0.1", "127.0.0.42", "::1", "[::1]"):
            with self.subTest(host):
                self.assertTrue(is_loopback_host(host))
        for host in ("localhost", "127.evil.com", "0.0.0.0", "10.1.2.3", "[::ffff:7f00:1]", ""):
            with self.subTest(host):
                self.assertFalse(is_loopback_host(host))

    def test_a_host_header_is_reduced_to_its_origin_not_its_path(self) -> None:
        self.assertEqual(host_without_port("127.0.0.1:8732"), "127.0.0.1")
        self.assertEqual(host_without_port("[::1]:8732"), "[::1]")
        self.assertEqual(host_without_port("127.0.0.1"), "127.0.0.1")
        # A non-numeric "port" must not be mistaken for a host.
        self.assertEqual(host_without_port("127.0.0.1:evil.example"), "127.0.0.1:evil.example")


if __name__ == "__main__":
    unittest.main()
