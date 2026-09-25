"""Real inference against the pinned checkpoint.

This is the only file in the suite that touches the model, and it is skipped
unless the weights verify against ``models.lock.json`` *and* ``JEY_RUN_INFERENCE=1``
is set explicitly. A skip here is reported as skipped, never as a pass: the
protocol tests can all be green while inference is completely broken.
"""

from __future__ import annotations

import json
import os
import unittest
from pathlib import Path

from local_decider.lock import load_lock, verify_weights
from local_decider.scoring import LocalScorer, answer_for, evaluate, options_for

LOCK = load_lock()
ROOT = LOCK.path.parents[1]
CHECK = verify_weights(LOCK, ROOT)
REQUIRED = os.environ.get("JEY_RUN_INFERENCE") == "1"
REASON = ("weights do not match the lock" if not CHECK["matches"]
          else "set JEY_RUN_INFERENCE=1 to run the checkpoint")
SNAPSHOT = {
    "sessionId": "inf", "agentId": "inf", "turn": 1, "step": 1, "generation": 1,
    "taskVersion": 1, "policyVersion": "p", "catalogDigest": "d", "callDigest": None,
    "observationSequence": 1,
}
STATE = {"userTask": "find the failing test", "call": {"toolName": "read_test_log"}}


@unittest.skipUnless(REQUIRED and CHECK["matches"], REASON)
class InferenceTest(unittest.TestCase):
    scorer: LocalScorer

    @classmethod
    def setUpClass(cls) -> None:
        import time

        started = time.monotonic()
        cls.scorer = LocalScorer.load(LOCK, ROOT)
        cls.load_seconds = time.monotonic() - started

    @classmethod
    def tearDownClass(cls) -> None:
        report = os.environ.get("JEY_LOCAL_REPORT")
        if report and hasattr(cls, "samples"):
            Path(report).write_text(json.dumps({"loadSeconds": round(cls.load_seconds, 2),
                                                "identity": cls.scorer.identity,
                                                "backend": {k: v for k, v in cls.scorer.metadata.items()},
                                                "samples": cls.samples,
                                                "weightsCheck": CHECK}, indent=2, ensure_ascii=False),
                                    encoding="utf-8")
        cls.scorer.close()

    def record(self, name: str, result: dict) -> dict:
        if not hasattr(type(self), "samples"):
            type(self).samples = []
        type(self).samples.append({
            "case": name,
            "probabilities": result["probabilities"],
            "optionIds": result["option_ids"],
            "inputTokens": result["input_tokens"],
            "seconds": round(result["total_seconds"], 3),
            "cacheHit": result.get("cache_hit"),
            "promptSha256": result["prompt_sha256"],
        })
        return result

    def score(self, question, state=STATE):
        return self.record(question["id"], self.scorer.score_question(question, state))

    def test_the_identity_describes_the_file_that_was_actually_opened(self) -> None:
        identity = self.scorer.identity
        self.assertEqual(identity["kind"], "local")
        self.assertFalse(identity["synthetic"])
        self.assertEqual(identity["weightsDigest"], LOCK.weights_sha256)
        self.assertEqual(identity["modelRevision"], LOCK.weights_revision)
        self.assertEqual(identity["tokenizerRevision"], LOCK.tokenizer_revision)
        self.assertEqual(identity["quantization"], "Q4_K_M")
        self.assertEqual(self.scorer.metadata["gguf"]["bytes"], LOCK.weights_bytes)
        self.assertEqual(self.scorer.metadata["n_gpu_layers"], 0)
        self.assertGreater(len(identity["templateDigest"]), 40)

    def test_the_readout_is_a_distribution_over_exactly_the_declared_slots(self) -> None:
        question = {"kind": "choice", "id": "risk", "instructions": "Would running this test read or modify files?",
                    "options": [{"id": "read", "description": "It only reads files."},
                                {"id": "write", "description": "It writes or deletes files."},
                                {"id": "network", "description": "It reaches the network."}]}
        result = self.score(question)
        ids = [option["id"] for option in options_for(question)]
        self.assertEqual(result["option_ids"], ids)
        self.assertEqual(result["answer_token_ids"], result["answer_token_ids"][:len(ids)])
        self.assertEqual(len(set(result["answer_token_ids"])), len(ids))
        self.assertAlmostEqual(sum(result["probabilities"]), 1.0, places=6)
        # Near-total mass on the answer slots means the model was not about to say
        # something else entirely; it is a diagnostic, not a quality claim.
        self.assertGreater(result["allowed_token_mass"], 0.5)
        self.assertIn("quantized", result["readout"])
        self.assertIn("uncalibrated", result["probability_status"])
        answer = answer_for(question, result)
        self.assertEqual(sorted(answer["probabilities"]), sorted(ids))

    def test_the_same_prompt_scores_the_same_twice(self) -> None:
        import time

        question = {"kind": "boolean", "id": "relevant",
                    "instructions": "Is reading a test log useful for finding a failing test?"}
        first = self.scorer.score_question(question, STATE)
        started = time.monotonic()
        second = self.score(question)
        self.assertEqual(first["prompt_sha256"], second["prompt_sha256"])
        self.assertEqual(first["probabilities"], second["probabilities"])
        self.assertEqual(first["option_logits"], second["option_logits"])
        self.assertLess(time.monotonic() - started, 30)

    def test_a_shared_state_is_prefilled_once_and_reused(self) -> None:
        state = {"userTask": "summarise why the build broke", "call": {"toolName": "read_log"}}
        first = self.score({"kind": "boolean", "id": "a", "instructions": "Is this log relevant?"}, state)
        second = self.score({"kind": "boolean", "id": "b", "instructions": "Does this log name a file?"}, state)
        self.assertFalse(first["cache_hit"])
        self.assertTrue(second["cache_hit"])
        self.assertEqual(first["prefix_sha256"], second["prefix_sha256"])
        self.assertNotEqual(first["prompt_sha256"], second["prompt_sha256"])
        self.assertGreater(first["prefill_seconds"], 0)
        self.assertEqual(second["prefill_seconds"], 0)

    def test_a_prompt_over_the_token_cap_is_refused_rather_than_truncated(self) -> None:
        from semif_phase1 import llamacpp_backend

        tight = llamacpp_backend.SerialPrefixScorer(self.scorer.backend, self.scorer.tokenizer,
                                                   self.scorer.metadata, max_tokens=48)
        with self.assertRaises(ValueError) as caught:
            tight.score({"id": "long", "state": {"blob": "the quick brown fox jumps over the lazy dog " * 12},
                         "question": "Is this relevant?",
                         "options": [{"id": "yes", "description": "Yes."}, {"id": "no", "description": "No."}]})
        self.assertIn("exceed limit", str(caught.exception))

    def test_a_full_request_comes_back_answered_end_to_end(self) -> None:
        import time

        questions = [
            {"kind": "boolean", "id": "relevant", "instructions": "Is reading the log relevant to the task?"},
            {"kind": "boolean", "id": "conflict",
             "instructions": "Does reading a log file conflict with a read-only restriction?"},
            {"kind": "score", "id": "severity", "instructions": "How severe is reading one log file?",
             "levels": ["none", "minor", "major", "critical"]},
        ]
        started = time.monotonic()
        response = evaluate(self.scorer, {"schemaVersion": "1", "requestId": "req-infer",
                                         "purpose": "tool-assessment", "snapshot": dict(SNAPSHOT),
                                         "state": STATE, "questions": questions,
                                         "budget": {"maxElapsedMs": 60_000, "maxInputBytes": 32768}},
                            0.0, started, started + 60)
        self.assertEqual(response["status"], "ok", response["outcomes"])
        self.assertEqual([o["status"] for o in response["outcomes"]], ["answered"] * 3)
        self.assertEqual(response["provider"]["weightsDigest"], LOCK.weights_sha256)
        self.assertEqual(response["usage"]["outputTokens"], 0)
        self.assertGreater(response["usage"]["inputTokens"], 0)
        self.assertGreaterEqual(response["timing"]["inferenceMs"], 0)
        self.assertEqual(response["egress"], {"occurred": False, "destinationId": None})


if __name__ == "__main__":
    unittest.main()
