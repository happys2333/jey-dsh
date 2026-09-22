#!/usr/bin/env python3
"""Validate public evidence declarations and hashes; does NOT run project tests.

Python 3.10+, standard library only. A valid manifest is not proof of truth.
Use independent test runners, secret scanning, and review in addition to this tool.
"""
from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys
from typing import Any

ENGINEERING = (
    'compatibility', 'typecheck', 'unit', 'property', 'provider-contract',
    'host-integration', 'mcp-contract', 'security', 'lifecycle', 'pack-install',
    'baseline-eval', 'secret-scan',
)
PROFILES: dict[str, tuple[str, ...]] = {
    'collection': (),
    'engineering': ENGINEERING,
    'local-qualified': ENGINEERING + ('local-inference', 'local-offline', 'semantic-eval', 'system-eval'),
    'cloud-qualified': ENGINEERING + ('cloud-inference', 'semantic-eval', 'system-eval'),
}
GATE_KINDS = {
    'compatibility': 'host', 'typecheck': 'static', 'unit': 'unit',
    'property': 'property', 'provider-contract': 'contract',
    'host-integration': 'host', 'mcp-contract': 'mcp', 'security': 'security',
    'lifecycle': 'lifecycle', 'pack-install': 'package',
    'baseline-eval': 'simulation', 'secret-scan': 'security',
    'local-inference': 'local-live', 'local-offline': 'offline-live',
    'cloud-inference': 'cloud-live', 'semantic-eval': 'evaluation-live',
    'system-eval': 'evaluation-live',
}
KINDS = set(GATE_KINDS.values())
STATUSES = {'PASS', 'FAIL', 'BLOCKED', 'SKIPPED', 'INCONCLUSIVE'}
MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_TOTAL_BYTES = 500 * 1024 * 1024
ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z')
SHA256 = re.compile(r'[0-9a-f]{64}\Z')
COMMIT = re.compile(r'[0-9a-f]{40}\Z')
DENIED_DIRS = {'.git', '.local', '.ssh', '.aws', '.dsh', 'node_modules', '__pycache__'}
DENIED_NAMES = {'credentials', 'credentials.json', 'id_rsa', 'id_ed25519'}
DENIED_SUFFIXES = {'.pem', '.key', '.p12', '.pfx', '.gguf', '.safetensors'}


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('JSON contains a duplicate key')
        result[key] = value
    return result


def _reject_constant(_: str) -> None:
    raise ValueError('JSON contains a non-finite number')


def read_manifest(path: Path) -> dict[str, Any]:
    if path.is_symlink():
        raise ValueError('manifest itself must not be a symlink')
    if path.stat().st_size > 2 * 1024 * 1024:
        raise ValueError('manifest exceeds 2 MiB')
    value = json.loads(path.read_text(encoding='utf-8'),
                       object_pairs_hook=_unique_object, parse_constant=_reject_constant)
    if not isinstance(value, dict):
        raise ValueError('manifest root must be an object')
    return value


def safe_artifact_path(root: Path, relative: str) -> Path:
    """Reject traversal, symlinks and obvious private/model files. Not a secret scanner."""
    if not isinstance(relative, str) or not relative or '\\' in relative or ':' in relative or any(ord(c) < 32 for c in relative):
        raise ValueError('artifact path must be a relative POSIX path')
    parts = relative.split('/')
    if PurePosixPath(relative).is_absolute() or any(p in ('', '.', '..') or p.endswith((' ', '.')) for p in parts):
        raise ValueError('artifact path contains an unsafe segment')
    lowered = [p.lower() for p in parts]
    if any(p in DENIED_DIRS or p.startswith('.env') for p in lowered):
        raise ValueError('private directory or environment file is not allowed')
    if lowered[-1] in DENIED_NAMES or Path(lowered[-1]).suffix in DENIED_SUFFIXES:
        raise ValueError('credential or model artifact is not allowed')
    candidate = root
    for part in parts:
        candidate = candidate / part
        if candidate.is_symlink():
            raise ValueError('artifact path traverses a symlink')
    resolved = candidate.resolve(strict=True)
    if not resolved.is_relative_to(root.resolve()) or not resolved.is_file():
        raise ValueError('artifact is not a regular file inside the evidence root')
    if resolved.stat().st_size > MAX_FILE_BYTES:
        raise ValueError('artifact exceeds 50 MiB; store large data separately')
    return resolved


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def _valid_id(value: Any) -> bool:
    return isinstance(value, str) and ID.fullmatch(value) is not None


def validate(manifest_path: Path, profile: str = 'collection') -> tuple[dict[str, Any] | None, list[str]]:
    errors: list[str] = []
    if profile not in PROFILES:
        return None, ['unknown validation profile']
    try:
        doc = read_manifest(manifest_path)
    except (OSError, ValueError, UnicodeError, RecursionError) as exc:
        return None, [f'cannot read manifest: {type(exc).__name__}: {exc}']
    root = manifest_path.parent.resolve()
    if doc.get('schema_version') != '1':
        errors.append('schema_version must be 1')
    if doc.get('project') != 'agent-decision-layer':
        errors.append('project must be agent-decision-layer')
    if not _valid_id(doc.get('run_id')):
        errors.append('run_id is invalid')
    try:
        created = datetime.fromisoformat(doc['created_at'].replace('Z', '+00:00'))
        if created.tzinfo is None:
            raise ValueError('timezone missing')
    except (KeyError, ValueError, TypeError, AttributeError):
        errors.append('created_at must be an ISO timestamp with a timezone')

    source = doc.get('source')
    if not isinstance(source, dict):
        source = {}
        errors.append('source must be an object')
    if not isinstance(source.get('commit'), str) or not COMMIT.fullmatch(source['commit']):
        errors.append('source.commit must be a full lowercase 40-character Git SHA')
    if type(source.get('dirty')) is not bool:
        errors.append('source.dirty must be boolean')
    elif profile != 'collection' and source['dirty']:
        errors.append('qualified evidence cannot come from a dirty source tree')

    raw_artifacts = doc.get('artifacts')
    if not isinstance(raw_artifacts, list) or not raw_artifacts:
        errors.append('artifacts must be a non-empty array')
        raw_artifacts = []
    artifacts: dict[str, dict[str, Any]] = {}
    seen_paths: set[str] = set()
    total_size = 0
    for index, item in enumerate(raw_artifacts):
        prefix = f'artifact[{index}]'
        if not isinstance(item, dict) or not _valid_id(item.get('id')):
            errors.append(f'{prefix}: invalid object or id')
            continue
        aid = item['id']
        if aid in artifacts:
            errors.append(f'{prefix}: duplicate id')
            continue
        artifacts[aid] = item
        if item.get('classification') != 'public':
            errors.append(f'{prefix}: only explicitly public staging artifacts are accepted')
        relative = item.get('path')
        if isinstance(relative, str):
            if relative.casefold() in seen_paths:
                errors.append(f'{prefix}: duplicate artifact path')
            seen_paths.add(relative.casefold())
        try:
            target = safe_artifact_path(root, relative)
            if relative == 'evidence.manifest.json' or target == manifest_path.resolve():
                raise ValueError('manifest must not reference itself')
            size = target.stat().st_size
            total_size += size
            if type(item.get('size_bytes')) is not int or item['size_bytes'] != size:
                errors.append(f'{prefix}: size_bytes does not match file')
            expected = item.get('sha256')
            if not isinstance(expected, str) or not SHA256.fullmatch(expected):
                errors.append(f'{prefix}: invalid sha256')
            elif file_sha256(target) != expected:
                errors.append(f'{prefix}: SHA-256 mismatch')
        except (OSError, ValueError, TypeError, RuntimeError) as exc:
            errors.append(f'{prefix}: {exc}')
    if total_size > MAX_TOTAL_BYTES:
        errors.append('total public evidence exceeds 500 MiB')

    providers: dict[str, dict[str, Any]] = {}
    raw_providers = doc.get('providers', [])
    if not isinstance(raw_providers, list):
        errors.append('providers must be an array')
        raw_providers = []
    for index, provider in enumerate(raw_providers):
        if not isinstance(provider, dict) or not _valid_id(provider.get('id')):
            errors.append(f'provider[{index}]: invalid object or id')
            continue
        pid = provider['id']
        if pid in providers:
            errors.append(f'provider[{index}]: duplicate id')
        providers[pid] = provider
        if not isinstance(provider.get('kind'), str) or provider['kind'] not in {'mock', 'local', 'typesafe'}:
            errors.append(f'provider[{index}]: invalid kind')
        if type(provider.get('synthetic')) is not bool:
            errors.append(f'provider[{index}]: synthetic must be boolean')
        elif provider.get('kind') == 'mock' and not provider['synthetic']:
            errors.append(f'provider[{index}]: mock cannot be non-synthetic')
        if not isinstance(provider.get('model'), str) or not provider['model'].strip():
            errors.append(f'provider[{index}]: resolved model is required')

    raw_gates = doc.get('gates')
    if not isinstance(raw_gates, list) or not raw_gates:
        errors.append('gates must be a non-empty array')
        raw_gates = []
    gates: dict[str, dict[str, Any]] = {}
    for index, gate in enumerate(raw_gates):
        prefix = f'gate[{index}]'
        if not isinstance(gate, dict) or not _valid_id(gate.get('id')):
            errors.append(f'{prefix}: invalid object or id')
            continue
        gid = gate['id']
        if gid in gates:
            errors.append(f'{prefix}: duplicate gate id')
            continue
        gates[gid] = gate
        if not isinstance(gate.get('status'), str) or gate['status'] not in STATUSES:
            errors.append(f'{prefix}: invalid status')
        if not isinstance(gate.get('kind'), str) or gate['kind'] not in KINDS:
            errors.append(f'{prefix}: invalid evidence kind')
        if gid in GATE_KINDS and gate.get('kind') != GATE_KINDS[gid]:
            errors.append(f'{prefix}: evidence kind does not match {gid}')
        exit_code = gate.get('exit_code')
        if gate.get('status') == 'PASS' and (type(exit_code) is not int or exit_code != 0):
            errors.append(f'{prefix}: PASS requires integer exit_code 0')
        if gate.get('status') != 'PASS' and (not isinstance(gate.get('reason'), str) or not gate['reason'].strip()):
            errors.append(f'{prefix}: non-PASS needs an explicit reason')
        refs = gate.get('artifact_ids')
        if not isinstance(refs, list) or not refs:
            errors.append(f'{prefix}: at least one evidence artifact is required')
        else:
            if any(not isinstance(aid, str) or aid not in artifacts for aid in refs):
                errors.append(f'{prefix}: missing/invalid artifact reference')
        if gate.get('provider_id') is not None and (not _valid_id(gate['provider_id']) or gate['provider_id'] not in providers):
            errors.append(f'{prefix}: unknown provider_id')

    for gid in PROFILES[profile]:
        if gid not in gates or gates[gid].get('status') != 'PASS':
            errors.append(f'{profile}: required gate {gid} is not PASS')

    if profile in {'local-qualified', 'cloud-qualified'}:
        required_kind = 'local' if profile == 'local-qualified' else 'typesafe'
        live_gate = 'local-inference' if required_kind == 'local' else 'cloud-inference'
        expected_pid = gates.get(live_gate, {}).get('provider_id')
        provider = providers.get(expected_pid, {}) if isinstance(expected_pid, str) else {}
        if provider.get('kind') != required_kind or provider.get('synthetic') is not False:
            errors.append(f'{profile}: required non-synthetic provider is missing')
        for gid in (live_gate, 'semantic-eval', 'system-eval'):
            if not expected_pid or gates.get(gid, {}).get('provider_id') != expected_pid:
                errors.append(f'{profile}: {gid} must attest the same provider')
        if required_kind == 'local':
            if gates.get('local-offline', {}).get('provider_id') != expected_pid:
                errors.append('local-qualified: local-offline must attest the local provider')
            revision = provider.get('model_revision')
            weights = provider.get('weights_sha256')
            if not isinstance(revision, str) or not revision.strip():
                errors.append('local-qualified: model_revision is required')
            if not isinstance(weights, str) or not SHA256.fullmatch(weights):
                errors.append('local-qualified: weights_sha256 is required')
            if provider.get('offline_enforced') is not True or not isinstance(provider.get('offline_method'), str) or not provider['offline_method'].strip():
                errors.append('local-qualified: actual offline enforcement declaration is required')
    return doc, errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--profile', choices=tuple(PROFILES), default='collection')
    args = parser.parse_args()
    doc, errors = validate(args.manifest, args.profile)
    result = {
        'validation': 'FAIL' if errors else 'PASS',
        'profile': args.profile,
        'run_id': doc.get('run_id') if doc else None,
        'errors': errors,
        'scope': 'declarations, required gates, paths and file integrity only; not proof of test truth',
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
