"""Turn an ADL decision request into native-logit observations, on CPU.

The scorer is the pinned SemIf llama.cpp backend, used exactly as upstream
defines it: ``load_model`` + ``score``/``SerialPrefixScorer`` over GGUF weights,
with the reference tokenizer deciding tokenization. Nothing here invents a
second readout — the probabilities are the softmax over the declared answer
slots of the last-position logits, which is what upstream's own docstring calls
"native full-vocabulary last-position logits restricted to declared answer
slots". They are conditional option scores, not calibrated confidence.
"""

from __future__ import annotations

import json
import math
import os
import time
from pathlib import Path

from .lock import Lock, verify_weights
from .protocol import SCHEMA_VERSION

#: Upstream caps answer slots at the number of distinct single letters.
MAX_OPTIONS = 16
MAX_QUESTIONS = 8
BOOL_OPTIONS = [{"id": "yes", "description": "Yes."}, {"id": "no", "description": "No."}]


class ReadyError(Exception):
    """Why the model is not usable. Readiness must fail loudly, never fall back."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _template_digest(prompt_version: str, chat_template: str, system_prompt: str) -> str:
    import hashlib

    material = "\0".join([prompt_version, chat_template, system_prompt])
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def _finite_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def options_for(question: dict):
    """Map an ADL question onto SemIf's ``options`` list, or say why it cannot be scored."""
    kind = question["kind"]
    if kind == "boolean":
        return [dict(option) for option in BOOL_OPTIONS]
    if kind == "choice":
        return [{"id": option["id"], "description": option["description"]} for option in question["options"]]
    if kind == "score":
        return [{"id": str(index), "description": level} for index, level in enumerate(question["levels"])]
    raise ValueError(f"unknown question kind {kind!r}")


def unscoreable(question: dict) -> str | None:
    """Return an (ErrorCode, retryable) reason when this backend cannot answer at all."""
    kind = question["kind"]
    if kind not in ("boolean", "choice", "score"):
        return "UNSUPPORTED_CAPABILITY"
    options = options_for(question)
    if len(options) > MAX_OPTIONS:
        # Upstream's slots are single letters A..P; more options than that is a
        # capability limit, not something to silently truncate.
        return "UNSUPPORTED_CAPABILITY"
    if len(options) < 2:
        return "INSUFFICIENT_CONTEXT"
    if any(not (option["id"] and option["description"]) for option in options):
        # An empty description would be sent to the model as an option with no text.
        return "UNSUPPORTED_CAPABILITY"
    if len({option["id"] for option in options}) != len(options):
        return "INVALID_INPUT"
    return None


def state_is_scorable(state) -> bool:
    """SemIf requires nonempty string/object/array evidence that survives json()."""
    if isinstance(state, str):
        return state != ""
    if isinstance(state, (dict, list)):
        if not state:
            return False
        try:
            json.dumps(state, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError):
            return False
        return True
    return False


class LocalScorer:
    """One loaded checkpoint, scored one request at a time."""

    def __init__(self, lock: Lock, backend, tokenizer, metadata: dict, template_digest: str, repo_root: Path):
        self.lock = lock
        self.backend = backend
        self.tokenizer = tokenizer
        self.metadata = metadata
        self.template_digest = template_digest
        self.repo_root = repo_root
        self.serial = None
        self.max_tokens = int(metadata.get("max_prompt_tokens") or lock.context_tokens)

    @classmethod
    def load(cls, lock: Lock, repo_root: Path) -> "LocalScorer":
        check = verify_weights(lock, repo_root)
        if not check["present"]:
            raise ReadyError("weights are not on disk; run python -m local_decider.download_weights")
        if not check["matches"]:
            raise ReadyError(f"weights do not match the lock: {check['reason']}")

        # Both must be set before anything imports huggingface_hub, which reads them at
        # import time. Otherwise the tokenizer is looked up in the default cache — or,
        # worse, fetched from the network by something a request triggered.
        os.environ["HF_HOME"] = str(lock.hf_home(repo_root))
        os.environ["HF_HUB_OFFLINE"] = "1"
        from huggingface_hub import snapshot_download

        try:
            source = snapshot_download(
                lock.repository, revision=lock.tokenizer_revision,
                allow_patterns=list(lock.reference_files), local_files_only=True,
            )
        except Exception as error:
            raise ReadyError(f"reference tokenizer is not cached: {error}") from error

        from semif_phase1 import llamacpp_backend
        from semif_phase1.core import DIRECT_SYSTEM
        from semif_phase1.direct import PROMPT_VERSION

        try:
            backend, tokenizer, metadata = llamacpp_backend.load_model(
                source, lock.tokenizer_revision, check["path"],
                threads=lock.threads, context_tokens=lock.context_tokens,
            )
        except ReadyError:
            raise
        except Exception as error:
            # Upstream verifies the GGUF vocabulary against the reference tokenizer and
            # fails closed; that failure is exactly what "not ready" means.
            raise ReadyError(f"backend refused to load: {error}") from error

        template = Path(source) / "chat_template.jinja"
        if not template.is_file():
            raise ReadyError("chat_template.jinja is missing from the cached tokenizer")
        # Decoded from bytes rather than text mode: a Windows text read would translate
        # CRLF and hash something other than the template the tokenizer applies.
        return cls(lock, backend, tokenizer, metadata,
                   _template_digest(PROMPT_VERSION, template.read_bytes().decode("utf-8"), DIRECT_SYSTEM),
                   repo_root)

    @property
    def identity(self) -> dict:
        """A provider identity with no invented fields.

        ``resolvedModel`` names the checkpoint actually opened, and ``weightsDigest``
        is the sha256 the backend computed while reading it, so a swapped file changes
        the identity instead of hiding behind the revision string.
        """
        weights = self.lock.raw["weights"]
        gguf = self.metadata.get("gguf") or {}
        return {
            "kind": "local",
            "providerVersion": f"local_decider/semif-{self.metadata.get('llama_cpp_python_version', 'unknown')}",
            "requestedModel": weights["repository"],
            "resolvedModel": f"{weights['repository']}@{weights['revision']}#{gguf.get('file', weights['file'])}",
            "modelRevision": weights["revision"],
            "weightsDigest": gguf.get("sha256"),
            "tokenizerRevision": self.lock.tokenizer_revision,
            "templateDigest": self.template_digest,
            "quantization": weights["quantization"],
            "synthetic": False,
        }

    def capabilities(self, max_input_bytes: int) -> dict:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "provider": self.identity,
            "questionKinds": ["boolean", "choice", "score"],
            "maxInputBytes": max_input_bytes,
            "maxQuestions": MAX_QUESTIONS,
            # llama.cpp exposes no interrupt for a decode in flight. We can drop the
            # result and stop serving it, and we say so rather than claiming we stopped.
            "cancellation": "discard-only",
        }

    def close(self) -> None:
        close = getattr(self.backend, "close", None)
        if callable(close):
            close()

    def score_question(self, question: dict, state) -> dict:
        """Score one question. Raises ValueError with the upstream reason on rejection."""
        from semif_phase1 import llamacpp_backend

        if self.serial is None:
            self.serial = llamacpp_backend.SerialPrefixScorer(
                self.backend, self.tokenizer, self.identity_free_metadata(), self.max_tokens
            )
        row = {
            "id": question["id"],
            "state": state,
            "question": question["instructions"],
            "options": options_for(question),
        }
        return self.serial.score(row)

    def identity_free_metadata(self) -> dict:
        """Backend metadata only: the identity block belongs to the response envelope."""
        return {key: value for key, value in self.metadata.items() if key != "model"}


def _probability_meta() -> dict:
    return {"origin": "native-logits", "calibration": "uncalibrated", "calibrationId": None}


def answer_for(question: dict, result: dict) -> dict:
    """Convert an upstream scoring record into the ADL answer for this question."""
    options = options_for(question)
    ids = [option["id"] for option in options]
    if result.get("option_ids") != ids:
        raise ValueError("the scorer returned a different option set than was asked for")
    probabilities = list(result["probabilities"])
    if len(probabilities) != len(ids) or not all(_finite_number(p) and 0.0 <= p <= 1.0 for p in probabilities):
        raise ValueError("the scorer returned a probability that is not in [0, 1]")
    distribution = {key: float(value) for key, value in zip(ids, probabilities)}
    top = max(range(len(probabilities)), key=lambda index: probabilities[index])
    kind = question["kind"]
    if kind == "boolean":
        return {"kind": "boolean", "pYes": float(probabilities[0]), "probability": _probability_meta()}
    if kind == "choice":
        return {"kind": "choice", "selected": ids[top], "probabilities": distribution,
                "probability": _probability_meta()}
    expected = sum(index * float(value) for index, value in enumerate(probabilities))
    return {"kind": "score", "expectedIndex": expected, "levels": list(question["levels"]),
            "probabilities": distribution, "probability": _probability_meta()}


def error_outcome(question_id: str, code: str, retryable: bool = False) -> dict:
    return {"id": question_id, "status": "error", "code": code, "retryable": retryable}


def abstained(question_id: str, reason: str) -> dict:
    return {"id": question_id, "status": "abstained", "reason": reason}


def evaluate(scorer, request: dict, queued_ms: float, started: float, deadline: float) -> dict:
    """Answer every question in one request, or say per question why not.

    ``scorer`` is anything with ``identity`` and ``score_question``; ``LocalScorer``
    is the only one in production. ``started`` and ``deadline`` are absolute values
    from one monotonic clock, so queueing and scoring are charged to the same budget
    the caller handed over.

    A request that runs out of time mid-batch is not reported as a complete answer
    set: the questions already scored stay answered and the rest come back as
    TIMEOUT, because ``status`` is a summary the policy layer must not over-read.
    """
    outcomes = []
    input_tokens = 0
    inference_s = 0.0
    state = request["state"]
    questions = request["questions"]

    if len(questions) > MAX_QUESTIONS:
        from .protocol import ProtocolError

        raise ProtocolError("UNSUPPORTED_CAPABILITY", ["questions"],
                            f"{len(questions)} questions exceeds the {MAX_QUESTIONS} this backend serves")

    for question in questions:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            outcomes.append(error_outcome(question["id"], "TIMEOUT"))
            continue
        reason = unscoreable(question)
        if reason is not None:
            outcomes.append(error_outcome(question["id"], reason))
            continue
        if not state_is_scorable(state):
            outcomes.append(error_outcome(question["id"], "INSUFFICIENT_CONTEXT"))
            continue
        mark = time.monotonic()
        try:
            result = scorer.score_question(question, state)
        except ValueError as error:
            text = str(error)
            # Upstream refuses to truncate an over-long prompt, so say so instead of
            # quietly answering a shortened question.
            code = "BUDGET_EXCEEDED" if "exceed limit" in text or "exceeds limit" in text else "INVALID_INPUT"
            outcomes.append(error_outcome(question["id"], code))
            inference_s += time.monotonic() - mark
            continue
        except RuntimeError as error:
            inference_s += time.monotonic() - mark
            from .protocol import ProtocolError

            raise ProtocolError("LOCAL_NOT_READY", ["provider"],
                                f"the backend failed mid-request: {error}", retryable=True) from error
        inference_s += time.monotonic() - mark
        input_tokens += int(result.get("input_tokens") or 0)
        try:
            answer = answer_for(question, result)
        except ValueError:
            # A distribution that does not line up with the question is the provider
            # breaking its own contract; the policy layer must see that, not a guess.
            outcomes.append(error_outcome(question["id"], "INVALID_RESPONSE"))
            continue
        outcomes.append({"id": question["id"], "status": "answered", "answer": answer})

    answered = sum(1 for outcome in outcomes if outcome["status"] == "answered")
    if answered == len(outcomes):
        status = "ok"
    elif answered:
        status = "partial"
    else:
        status = "failed"

    return {
        "schemaVersion": SCHEMA_VERSION,
        "requestId": request["requestId"],
        "snapshot": request["snapshot"],
        "status": status,
        "provider": scorer.identity,
        "outcomes": outcomes,
        "timing": {
            "queueMs": int(round(queued_ms)),
            "inferenceMs": int(round(inference_s * 1000)),
            "totalMs": int(round((time.monotonic() - started) * 1000)),
        },
        "usage": {
            "inputTokens": input_tokens,
            # This readout never generates a token, so zero is a measurement, not a guess.
            "outputTokens": 0,
            "costUsd": None,
            "costBasis": "unknown",
        },
        "egress": {"occurred": False, "destinationId": None},
    }
