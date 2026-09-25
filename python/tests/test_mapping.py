"""Question/answer mapping and the shape of an observation this backend may report."""

from __future__ import annotations

import time
import unittest

from local_decider.lock import load_lock
from local_decider.protocol import ProtocolError
from local_decider.scoring import (
    MAX_OPTIONS, answer_for, evaluate, options_for, state_is_scorable, unscoreable,
)

META = {"origin": "native-logits", "calibration": "uncalibrated", "calibrationId": None}
SNAPSHOT = {
    "sessionId": "s", "agentId": "a", "turn": 1, "step": 2, "generation": 1,
    "taskVersion": 1, "policyVersion": "p", "catalogDigest": "d", "callDigest": None,
    "observationSequence": 3,
}
STATE = {"userTask": "find the failing test", "call": {"toolName": "read"}}


def scored(probabilities, ids=None):
    return {"option_ids": ids or ["yes", "no"], "probabilities": probabilities, "input_tokens": 128}


class MappingTest(unittest.TestCase):
    def test_boolean_uses_two_fixed_slots_and_reports_p_yes(self) -> None:
        question = {"kind": "boolean", "id": "relevant", "instructions": "Is it relevant?"}
        options = options_for(question)
        self.assertEqual([o["id"] for o in options], ["yes", "no"])
        answer = answer_for(question, scored([0.75, 0.25]))
        self.assertEqual(answer, {"kind": "boolean", "pYes": 0.75, "probability": META})

    def test_choice_keys_the_distribution_by_the_requested_option_ids(self) -> None:
        question = {"kind": "choice", "id": "risk", "instructions": "How risky?",
                    "options": [{"id": "safe", "description": "Safe"}, {"id": "side", "description": "Side effect"},
                                {"id": "irrev", "description": "Irreversible"}]}
        answer = answer_for(question, scored([0.1, 0.6, 0.3], ["safe", "side", "irrev"]))
        self.assertEqual(sorted(answer["probabilities"]), ["irrev", "safe", "side"])
        self.assertEqual(answer["selected"], "side")

    def test_score_keys_by_index_and_keeps_level_order(self) -> None:
        levels = ["none", "minor", "major"]
        question = {"kind": "score", "id": "severity", "instructions": "How severe?", "levels": levels}
        self.assertEqual([o["id"] for o in options_for(question)], ["0", "1", "2"])
        answer = answer_for(question, scored([0.2, 0.5, 0.3], ["0", "1", "2"]))
        self.assertEqual(list(answer["probabilities"]), ["0", "1", "2"])
        self.assertEqual(answer["levels"], levels)
        # Σ(i×p_i) is fractional for almost every real distribution; rounding it here
        # would throw away the difference between "mostly minor" and "mostly major".
        self.assertAlmostEqual(answer["expectedIndex"], 1.1)

    def test_a_scorer_that_answers_a_different_option_set_is_refused(self) -> None:
        question = {"kind": "boolean", "id": "q", "instructions": "?"}
        with self.assertRaises(ValueError):
            answer_for(question, scored([0.5, 0.5], ["on", "off"]))

    def test_a_non_probability_is_refused_rather_than_reported(self) -> None:
        question = {"kind": "boolean", "id": "q", "instructions": "?"}
        for bad in ([1.5, -0.5], [float("nan"), 1.0]):
            with self.subTest(bad):
                with self.assertRaises(ValueError):
                    answer_for(question, scored(bad))


class CapabilityTest(unittest.TestCase):
    def test_too_many_or_empty_options_are_a_capability_limit(self) -> None:
        many = [{"id": str(i), "description": f"option {i}"} for i in range(MAX_OPTIONS + 1)]
        self.assertEqual(unscoreable({"kind": "choice", "id": "q", "instructions": "?", "options": many}),
                         "UNSUPPORTED_CAPABILITY")
        self.assertEqual(unscoreable({"kind": "score", "id": "q", "instructions": "?", "levels": ["", "b"]}),
                         "UNSUPPORTED_CAPABILITY")
        self.assertEqual(unscoreable({"kind": "choice", "id": "q", "instructions": "?",
                                      "options": [{"id": "a", "description": "A"},
                                                  {"id": "a", "description": "A again"}]}),
                         "INVALID_INPUT")
        self.assertIsNone(unscoreable({"kind": "score", "id": "q", "instructions": "?", "levels": ["a", "b"]}))

    def test_evidence_must_be_a_nonempty_json_container(self) -> None:
        for state, expected in ((STATE, True), ([1], True), ("text", True), ({}, False),
                                ([], False), ("", False), (None, False), (3, False), (True, False)):
            with self.subTest(repr(state)):
                self.assertEqual(state_is_scorable(state), expected)


class FakeScorer:
    """Stands in for a loaded checkpoint so the service layer can be tested without weights.

    It is used only for protocol behaviour. Nothing in this file is evidence that the
    real backend scores anything; that is ``test_inference.py``.
    """

    def __init__(self, probabilities=(0.8, 0.2), error=None):
        self.probabilities = list(probabilities)
        self.error = error
        self.calls = 0
        self.identity = {"kind": "local", "providerVersion": "fake", "requestedModel": "r",
                         "resolvedModel": "r", "modelRevision": "m" * 40, "weightsDigest": "w" * 64,
                         "tokenizerRevision": "t" * 40, "templateDigest": "d" * 64,
                         "quantization": "Q4_K_M", "synthetic": False}

    def score_question(self, question, state):
        self.calls += 1
        if self.error is not None:
            raise self.error
        ids = [o["id"] for o in options_for(question)]
        if len(ids) == len(self.probabilities):
            values = self.probabilities
        else:
            weight = self.probabilities[0]
            values = [weight] + [(1 - weight) / (len(ids) - 1)] * (len(ids) - 1)
        return {"option_ids": ids, "probabilities": values, "input_tokens": 210}


def request(questions, state=STATE, budget_ms=30000):
    return {"schemaVersion": "1", "requestId": "r1", "purpose": "tool-assessment",
            "snapshot": dict(SNAPSHOT), "state": state, "questions": questions,
            "budget": {"maxElapsedMs": budget_ms, "maxInputBytes": 32768}}


class EvaluateTest(unittest.TestCase):
    """``started`` and ``deadline`` are absolute monotonic values, so every case derives
    them from one reading of the clock rather than a bare number."""

    @staticmethod
    def window(allowance: float = 30.0, elapsed: float = 0.0) -> tuple[float, float]:
        started = time.monotonic() - elapsed
        return started, started + allowance

    def test_every_question_kind_answers_in_one_request(self) -> None:
        questions = [
            {"kind": "boolean", "id": "relevant", "instructions": "Relevant?"},
            {"kind": "choice", "id": "risk", "instructions": "Risky?",
             "options": [{"id": "low", "description": "Low"}, {"id": "high", "description": "High"}]},
            {"kind": "score", "id": "severity", "instructions": "How severe?",
             "levels": ["none", "minor", "major"]},
        ]
        started, deadline = self.window()
        response = evaluate(FakeScorer(), request(questions), 4.0, started, deadline)
        self.assertEqual(response["status"], "ok")
        self.assertEqual([o["id"] for o in response["outcomes"]], ["relevant", "risk", "severity"])
        self.assertEqual([o["status"] for o in response["outcomes"]], ["answered"] * 3)
        self.assertEqual(response["requestId"], "r1")
        self.assertEqual(response["snapshot"], SNAPSHOT)
        self.assertEqual(response["usage"], {"inputTokens": 630, "outputTokens": 0,
                                             "costUsd": None, "costBasis": "unknown"})
        self.assertEqual(response["egress"], {"occurred": False, "destinationId": None})
        self.assertFalse(response["provider"]["synthetic"])
        self.assertGreaterEqual(response["timing"]["queueMs"], 4)

    def test_an_oversized_prompt_is_reported_as_budget_exceeded_not_truncated(self) -> None:
        scorer = FakeScorer(error=ValueError(
            "Row relevant: 5000 input tokens exceed limit 4096; no truncation allowed"))
        started, deadline = self.window()
        response = evaluate(scorer, request([{"kind": "boolean", "id": "relevant", "instructions": "?"}]),
                            1.0, started, deadline)
        self.assertEqual(response["status"], "failed")
        outcome = response["outcomes"][0]
        self.assertEqual((outcome["status"], outcome["code"]), ("error", "BUDGET_EXCEEDED"))
        self.assertFalse(outcome["retryable"])

    def test_missing_evidence_abstains_the_policy_layer_from_an_answer(self) -> None:
        started, deadline = self.window()
        response = evaluate(FakeScorer(), request([{"kind": "boolean", "id": "q", "instructions": "?"}], state={}),
                            1.0, started, deadline)
        self.assertEqual(response["outcomes"][0],
                         {"id": "q", "status": "error", "code": "INSUFFICIENT_CONTEXT", "retryable": False})
        self.assertEqual(response["status"], "failed")

    def test_a_deadline_spent_in_the_queue_leaves_the_rest_as_timeout(self) -> None:
        questions = [{"kind": "boolean", "id": f"q{i}", "instructions": "?"} for i in range(3)]
        scorer = FakeScorer()
        started, deadline = self.window(allowance=1.0, elapsed=6.0)
        response = evaluate(scorer, request(questions), 6000.0, started, deadline)
        self.assertEqual([o["code"] for o in response["outcomes"]], ["TIMEOUT"] * 3)
        self.assertEqual(response["status"], "failed")
        self.assertEqual(scorer.calls, 0)

    def test_a_deadline_spent_mid_batch_keeps_earlier_answers(self) -> None:
        class Slowing(FakeScorer):
            def score_question(self, question, state):
                time.sleep(0.05)
                return super().score_question(question, state)

        questions = [{"kind": "boolean", "id": f"q{i}", "instructions": "?"} for i in range(4)]
        started, deadline = self.window(allowance=0.12)
        response = evaluate(Slowing(), request(questions), 0.0, started, deadline)
        statuses = [o["status"] for o in response["outcomes"]]
        self.assertEqual(response["status"], "partial")
        self.assertIn("answered", statuses)
        self.assertIn("error", statuses)
        self.assertEqual({o["code"] for o in response["outcomes"] if o["status"] == "error"}, {"TIMEOUT"})

    def test_too_many_questions_is_a_request_level_rejection(self) -> None:
        questions = [{"kind": "boolean", "id": f"q{i}", "instructions": "?"} for i in range(9)]
        started, deadline = self.window()
        with self.assertRaises(ProtocolError) as caught:
            evaluate(FakeScorer(), request(questions), 0.0, started, deadline)
        self.assertEqual(caught.exception.code, "UNSUPPORTED_CAPABILITY")


class LockTest(unittest.TestCase):
    def test_the_shipped_lock_parses(self) -> None:
        lock = load_lock()
        self.assertEqual(lock.weights_file, "Qwen_Qwen3.5-4B-Q4_K_M.gguf")
        self.assertEqual(len(lock.weights_sha256), 64)
        self.assertGreater(lock.weights_bytes, 10 ** 9)


if __name__ == "__main__":
    unittest.main()
