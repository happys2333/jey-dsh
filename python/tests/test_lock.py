"""The lock file is the only thing that says which model this service is allowed to be."""

from __future__ import annotations

import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from local_decider.lock import default_lock_path, load_lock, sha256_of, verify_weights

GOOD = {
    "schemaVersion": "1",
    "reference": {
        "repository": "Qwen/Qwen3.5-4B",
        "revision": "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a",
        "files": ["tokenizer.json"],
    },
    "weights": {
        "repository": "bartowski/Qwen_Qwen3.5-4B-GGUF",
        "revision": "4168f45a16a1290d65a4ec0fa312ae917a4c15d6",
        "file": "m.gguf",
        "quantization": "Q4_K_M",
        "sha256": "0" * 64,
        "bytes": 4,
    },
    "backend": {"contextTokens": 4096, "threads": None},
    "cache": {"huggingfaceHome": ".local/hf-cache", "weightsDir": ".local/models"},
}


def write(raw: dict) -> tuple[Path, Path]:
    root = Path(tempfile.mkdtemp())
    path = root / "python" / "models.lock.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(raw), encoding="utf-8")
    return path, root


class LockTest(unittest.TestCase):
    def test_a_good_lock_loads(self) -> None:
        path, root = write(copy.deepcopy(GOOD))
        lock = load_lock(path)
        self.assertEqual(lock.weights_file, "m.gguf")
        self.assertEqual(lock.context_tokens, 4096)
        self.assertEqual(lock.hf_home(root), root / ".local/hf-cache")
        # repo root is derived from the lock's own location, not the process cwd
        self.assertEqual(lock.weights_path(lock.path.parents[1]),
                         lock.path.parents[1] / ".local/models" / "m.gguf")

    def test_unpinned_or_malformed_identity_is_refused(self) -> None:
        cases = {
            "wrong schema": lambda r: r.__setitem__("schemaVersion", "2"),
            "floating revision": lambda r: r["weights"].__setitem__("revision", "main"),
            "short digest": lambda r: r["weights"].__setitem__("sha256", "abc"),
            "zero bytes": lambda r: r["weights"].__setitem__("bytes", 0),
            "path traversal": lambda r: r["weights"].__setitem__("file", "../evil.gguf"),
            "tiny context": lambda r: r["backend"].__setitem__("contextTokens", 64),
            "bad threads": lambda r: r["backend"].__setitem__("threads", 0),
        }
        for label, mutate in cases.items():
            with self.subTest(label):
                raw = copy.deepcopy(GOOD)
                mutate(raw)
                path, _ = write(raw)
                with self.assertRaises(ValueError):
                    load_lock(path)

    def test_a_host_can_point_the_service_at_a_lock_it_chose(self) -> None:
        path, _ = write(copy.deepcopy(GOOD))
        self.assertEqual(default_lock_path().name, "models.lock.json")
        self.assertTrue(default_lock_path().is_file(), "the shipped lock must resolve from the checkout")
        with mock.patch.dict(os.environ, {"JEY_MODEL_LOCK": str(path)}):
            self.assertEqual(load_lock().path, path)

    def test_verification_checks_bytes_then_digest(self) -> None:
        path, root = write(copy.deepcopy(GOOD))
        lock = load_lock(path)
        root.joinpath(".local/models").mkdir(parents=True)
        target = lock.weights_path(root)
        self.assertFalse(verify_weights(lock, root)["present"])

        target.write_bytes(b"ab")
        short = verify_weights(lock, root)
        self.assertFalse(short["matches"])
        self.assertIn("bytes", short["reason"])

        target.write_bytes(b"good")
        wrong = verify_weights(lock, root)
        self.assertFalse(wrong["matches"])
        self.assertEqual(wrong["reason"], "digest mismatch")

        raw = copy.deepcopy(GOOD)
        raw["weights"]["sha256"] = sha256_of(target)
        raw["weights"]["bytes"] = len(b"good")
        good_path, good_root = write(raw)
        good = load_lock(good_path)
        good.root(good_root).mkdir(parents=True, exist_ok=True)
        good.weights_path(good_root).write_bytes(b"good")
        checked = verify_weights(good, good_root)
        self.assertTrue(checked["matches"], checked["reason"])
        self.assertIsNone(checked["reason"])


if __name__ == "__main__":
    unittest.main()
