"""Fetch the pinned tokenizer files and GGUF checkpoint, then verify the digest.

Run as a separate, explicit step (``python -m local_decider.download_weights``).
The service never downloads: a request that needs a model the host does not
have must fail readiness, not start an unbounded fetch from a request path.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

# Set before huggingface_hub is imported: the xet transport stalled at ~11 MB on
# this host and its partial state is not resumable from the caller's side.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

from .lock import load_lock, verify_weights  # noqa: E402


def _repo_root() -> Path:
    return Path(__file__).resolve().parent.parent.parent


def run(lock_path: Path | None, repo_root: Path, dry_run: bool) -> int:
    lock = load_lock(lock_path)
    os.environ["HF_HOME"] = str(lock.hf_home(repo_root))
    from huggingface_hub import hf_hub_download

    common = {"cache_dir": None, "local_dir": None, "token": False}
    target = lock.weights_path(repo_root)
    plan = {
        "reference": {
            "repo": lock.repository,
            "revision": lock.tokenizer_revision,
            "files": list(lock.reference_files),
        },
        "weights": {
            "repo": lock.weights_repository,
            "revision": lock.weights_revision,
            "file": lock.weights_file,
            "target": str(target),
        },
    }
    if dry_run:
        print(json.dumps({"dryRun": True, **plan}, indent=2))
        return 0
    for name in plan["reference"]["files"]:
        hf_hub_download(lock.repository, name, revision=lock.tokenizer_revision, **common)
        print(f"reference ok: {name}", flush=True)

    already = verify_weights(lock, repo_root)
    if already["matches"]:
        print(json.dumps({"verified": already, "downloaded": False}, indent=2))
        return 0
    target.parent.mkdir(parents=True, exist_ok=True)
    cached = Path(hf_hub_download(
        lock.weights_repository, lock.weights_file, revision=lock.weights_revision, **common
    ))
    if not target.exists() or target.stat().st_size != lock.weights_bytes:
        try:
            os.link(cached, target)
        except OSError:
            shutil.copyfile(cached, target)
    record = verify_weights(lock, repo_root)
    print(json.dumps({"verified": record, "downloaded": True, "plan": plan}, indent=2))
    if not record["matches"]:
        # A wrong checkpoint must not linger where readiness could pick it up.
        target.unlink(missing_ok=True)
        print("digest mismatch: removed the downloaded file", file=sys.stderr)
        return 2
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lock", type=Path, default=None)
    parser.add_argument("--repo-root", type=Path, default=None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    return run(args.lock, args.repo_root or _repo_root(), args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
