"""Request-boundary parity with ``packages/core/src/validate.ts``."""

from __future__ import annotations

import json
import unittest

from local_decider.protocol import ProtocolError, is_json_value, loads, parse_request

SNAPSHOT = {
    "sessionId": "s", "agentId": "a", "turn": 1, "step": 2, "generation": 1,
    "taskVersion": 1, "policyVersion": "p-v1", "catalogDigest": "d", "callDigest": "c",
    "observationSequence": 12,
}


def request(**overrides) -> dict:
    base = {
        "schemaVersion": "1", "requestId": "r1", "purpose": "tool-assessment",
        "snapshot": dict(SNAPSHOT),
        "state": {"trustedPolicy": ["read-only"], "userTask": "why did the test fail"},
        "questions": [{"kind": "boolean", "id": "relevant", "instructions": "Is this call relevant?"}],
        "budget": {"maxElapsedMs": 30000, "maxInputBytes": 32768},
    }
    base.update(overrides)
    return base


def codes(error: ProtocolError) -> set:
    return set(error.paths)


class LoadsTest(unittest.TestCase):
    def test_a_valid_request_round_trips_unchanged(self) -> None:
        good = request()
        self.assertEqual(parse_request(good), good)

    def test_extra_keys_are_tolerated_the_way_json_parse_tolerates_them(self) -> None:
        loose = request(some_future_field={"x": 1})
        self.assertEqual(parse_request(loose)["some_future_field"], {"x": 1})

    def test_non_utf8_and_non_json_bodies_are_invalid_input(self) -> None:
        with self.assertRaises(ProtocolError) as bad:
            loads(b"\xff\xfe\x00not text")
        self.assertEqual(bad.exception.code, "INVALID_INPUT")
        with self.assertRaises(ProtocolError):
            loads(b"{")

    def test_javascript_non_finite_literals_are_rejected_at_parse_time(self) -> None:
        # json.loads accepts these; JSON does not define them and the TS validator rejects them.
        for text, name in ((b'{"a": NaN}', "NaN"), (b'{"a": Infinity}', "Infinity"),
                           (b'{"a": -Infinity}', "-Infinity")):
            with self.subTest(text.decode()):
                with self.assertRaises(ProtocolError) as caught:
                    loads(text)
                self.assertEqual(caught.exception.code, "INVALID_INPUT")
                self.assertEqual(caught.exception.paths, [f"$.{name}"])

    def test_deeply_nested_bodies_fail_cleanly(self) -> None:
        with self.assertRaises(ProtocolError):
            loads(b"[" * 4000 + b"]" * 4000)


class StructureTest(unittest.TestCase):
    def test_every_offending_path_is_collected_not_just_the_first(self) -> None:
        bad = request()
        bad["schemaVersion"] = "2"
        bad["purpose"] = "vibes"
        bad["budget"]["maxElapsedMs"] = "30s"
        bad["snapshot"]["turn"] = -3
        with self.assertRaises(ProtocolError) as caught:
            parse_request(bad)
        self.assertEqual(codes(caught.exception),
                         {"schemaVersion", "purpose", "budget.maxElapsedMs", "snapshot.turn"})
        self.assertEqual(caught.exception.body("r1")["requestId"], "r1")

    def test_a_zero_deadline_is_a_structurally_valid_request_with_a_spent_budget(self) -> None:
        # Parity with the TypeScript validator: 0 is a number, so it is caught by the
        # positivity check rather than reported as a malformed field.
        with self.assertRaises(ProtocolError) as caught:
            parse_request(request(budget={"maxElapsedMs": 0, "maxInputBytes": 100}))
        self.assertEqual(caught.exception.paths, ["budget"])

    def test_a_missing_request_id_is_echoed_as_null(self) -> None:
        with self.assertRaises(ProtocolError) as caught:
            parse_request({"schemaVersion": "1"})
        self.assertIn("requestId", caught.exception.paths)
        self.assertIsNone(caught.exception.body()["requestId"])

    def test_duplicate_question_ids_are_rejected(self) -> None:
        question = request()["questions"][0]
        with self.assertRaises(ProtocolError) as caught:
            parse_request(request(questions=[question, dict(question)]))
        self.assertEqual(caught.exception.paths, ["questions"])

    def test_questions_must_be_nonempty_and_per_kind_well_formed(self) -> None:
        with self.assertRaises(ProtocolError):
            parse_request(request(questions=[]))
        cases = [
            ({"kind": "unknown", "id": "q", "instructions": "?"}, "questions[0].kind"),
            ({"kind": "choice", "id": "q", "instructions": "?", "options": [{"id": "a", "description": "A"}]},
             "questions[0].options"),
            ({"kind": "choice", "id": "q", "instructions": "?",
              "options": [{"id": "a"}, {"id": "b", "description": "B"}]}, "questions[0].options[0]"),
            ({"kind": "score", "id": "q", "instructions": "?", "levels": ["only"]}, "questions[0].levels"),
            ({"kind": "boolean", "id": "q"}, "questions[0].instructions"),
        ]
        for question, path in cases:
            with self.subTest(path):
                with self.assertRaises(ProtocolError) as caught:
                    parse_request(request(questions=[question]))
                self.assertIn(path, caught.exception.paths)

    def test_budget_must_be_positive_in_both_directions(self) -> None:
        for budget in ({"maxElapsedMs": 0, "maxInputBytes": 100},
                       {"maxElapsedMs": 100, "maxInputBytes": -1},
                       {"maxElapsedMs": float("inf"), "maxInputBytes": 100}):
            with self.subTest(json.dumps(budget)):
                with self.assertRaises(ProtocolError) as caught:
                    parse_request(request(budget=budget))
                self.assertEqual(caught.exception.code, "INVALID_INPUT")

    def test_state_must_be_finite_json(self) -> None:
        self.assertTrue(is_json_value({"a": [1, "b", None, True]}))
        self.assertFalse(is_json_value(float("nan")))
        self.assertFalse(is_json_value({1: "non-string key"}))
        self.assertFalse(is_json_value(b"bytes"))


class ErrorBodyTest(unittest.TestCase):
    def test_an_unknown_code_cannot_be_constructed(self) -> None:
        with self.assertRaises(ValueError):
            ProtocolError("SOMETHING_ELSE", [], "no")

    def test_an_error_body_never_carries_request_content(self) -> None:
        secret = "C:\\Users\\victim\\secret.txt"
        bad = request(state={"call": {"arguments": {"path": secret}}})
        bad["purpose"] = "nope"
        with self.assertRaises(ProtocolError) as caught:
            parse_request(bad)
        self.assertNotIn(secret, json.dumps(caught.exception.body("r1")))


if __name__ == "__main__":
    unittest.main()
