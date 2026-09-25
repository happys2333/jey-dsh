"""Read ``models.lock.json`` and resolve the pinned local-scorer identity.

Everything the service reports about the model comes from this file plus the
backend's own load-time metadata. Nothing here queries the network, so a
running service cannot silently re-resolve a revision into a different model.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path

SCHEMA_VERSION = "1"
SHA256 = re.compile(r"[0-9a-f]{64}")
GIT_SHA = re.compile(r"[0-9a-f]{40}")

DEFAULT_LOCK = Path(__file__).resolve().parent.parent / "models.lock.json"


@dataclass(frozen=True)
class Lock:
    path: Path
    raw: dict

    @property
    def repository(self) -> str:
        return self.raw["reference"]["repository"]

    @property
    def tokenizer_revision(self) -> str:
        return self.raw["reference"]["revision"]

    @property
    def reference_files(self) -> tuple:
        return tuple(self.raw["reference"]["files"])

    @property
    def weights_repository(self) -> str:
        return self.raw["weights"]["repository"]

    @property
    def weights_revision(self) -> str:
        return self.raw["weights"]["revision"]

    @property
    def weights_file(self) -> str:
        return self.raw["weights"]["file"]

    @property
    def weights_sha256(self) -> str:
        return self.raw["weights"]["sha256"]

    @property
    def weights_bytes(self) -> int:
        return int(self.raw["weights"]["bytes"])

    @property
    def quantization(self) -> str:
        return self.raw["weights"]["quantization"]

    @property
    def context_tokens(self) -> int:
        return int(self.raw["backend"]["contextTokens"])

    @property
    def threads(self):
        return self.raw["backend"]["threads"]

    def root(self, repo_root: Path) -> Path:
        return repo_root / self.raw["cache"]["weightsDir"]

    def hf_home(self, repo_root: Path) -> Path:
        return repo_root / self.raw["cache"]["huggingfaceHome"]

    def weights_path(self, repo_root: Path) -> Path:
        return self.root(repo_root) / self.weights_file


def default_lock_path() -> Path:
    """``JEY_MODEL_LOCK`` lets a host spawn the service against a lock it chose.

    The repository-relative file is the fallback, so ``python -m local_decider.service``
    keeps working from a checkout without any configuration.
    """
    override = os.environ.get("JEY_MODEL_LOCK")
    return Path(override) if override else DEFAULT_LOCK


def load_lock(path: Path | None = None) -> Lock:
    """Parse and self-check the lock file; a bad lock must not start a service."""
    resolved = Path(path) if path is not None else default_lock_path()
    if not resolved.is_file():
        raise ValueError(f"Model lock not found: {resolved}")
    raw = json.loads(resolved.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("Model lock must be a JSON object")
    if raw.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError(f"Model lock schemaVersion must be {SCHEMA_VERSION!r}")
    for key, text in (
        ("reference.revision", raw["reference"]["revision"]),
        ("weights.revision", raw["weights"]["revision"]),
    ):
        if not GIT_SHA.fullmatch(text or ""):
            raise ValueError(f"Model lock {key} must be a pinned 40-character revision")
    digest = raw["weights"]["sha256"]
    if not SHA256.fullmatch(digest or ""):
        raise ValueError("Model lock weights.sha256 must be a 64-character digest")
    size = int(raw["weights"]["bytes"])
    if size < 1:
        raise ValueError("Model lock weights.bytes must be positive")
    if not raw["weights"]["file"] or "/" in raw["weights"]["file"]:
        raise ValueError("Model lock weights.file must be a bare filename")
    context = int(raw["backend"]["contextTokens"])
    if context < 512:
        raise ValueError("Model lock backend.contextTokens must be at least 512")
    threads = raw["backend"]["threads"]
    if threads is not None and not (isinstance(threads, int) and threads >= 1):
        raise ValueError("Model lock backend.threads must be null or a positive integer")
    return Lock(resolved, raw)


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_weights(lock: Lock, repo_root: Path) -> dict:
    """Check the on-disk checkpoint against the lock without ever trusting its name."""
    path = lock.weights_path(repo_root)
    if not path.is_file():
        return {"present": False, "path": str(path), "matches": False, "reason": "missing"}
    size = path.stat().st_size
    if size != lock.weights_bytes:
        return {"present": True, "path": str(path), "matches": False, "bytes": size,
                "reason": f"expected {lock.weights_bytes} bytes, found {size}"}
    digest = sha256_of(path)
    return {"present": True, "path": str(path), "bytes": size, "sha256": digest,
            "matches": digest == lock.weights_sha256,
            "reason": None if digest == lock.weights_sha256 else "digest mismatch"}
