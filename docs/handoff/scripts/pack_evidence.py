#!/usr/bin/env python3
"""Pack an already-reviewed public allowlist locally. Never uploads anything."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys
import zipfile

from validate_evidence import PROFILES, file_sha256, safe_artifact_path, validate


def pack(manifest: Path, output: Path, profile: str) -> dict[str, str]:
    doc, errors = validate(manifest, profile)
    if errors or doc is None:
        raise ValueError('evidence validation failed: ' + '; '.join(errors))
    root = manifest.parent.resolve()
    if output.is_symlink():
        raise ValueError('output must not be a symlink')
    target = output.resolve()
    if target.is_relative_to(root):
        raise ValueError('output must be outside the public evidence root')
    if target.exists():
        raise ValueError('refusing to overwrite an existing output')
    target.parent.mkdir(parents=True, exist_ok=True)
    created = False
    try:
        with zipfile.ZipFile(target, mode='x', compression=zipfile.ZIP_DEFLATED) as archive:
            created = True
            def write_entry(name: str, data: bytes) -> None:
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.external_attr = 0o100644 << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, data)

            write_entry('evidence.manifest.json', json.dumps(doc, ensure_ascii=False, indent=2).encode('utf-8'))
            for item in sorted(doc['artifacts'], key=lambda row: row['path']):
                source = safe_artifact_path(root, item['path'])
                # Bound memory per file, rather than accumulating the whole archive.
                with source.open('rb') as stream:
                    data = stream.read(item['size_bytes'] + 1)
                if len(data) != item['size_bytes'] or hashlib.sha256(data).hexdigest() != item['sha256']:
                    raise ValueError('artifact changed during packaging')
                write_entry(item['path'], data)
    except Exception:
        # We own this new output only; never remove a pre-existing user file.
        if created:
            target.unlink(missing_ok=True)
        raise
    return {'output': str(target), 'sha256': file_sha256(target),
            'profile': profile, 'uploaded': 'false'}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--profile', choices=tuple(PROFILES), default='collection')
    args = parser.parse_args()
    try:
        result = pack(args.manifest, args.output, args.profile)
    except (OSError, ValueError) as exc:
        print(json.dumps({'pack': 'FAIL', 'error': str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
