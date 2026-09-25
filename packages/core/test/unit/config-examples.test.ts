/**
 * The shipped config examples are executables, not prose: each one has to load through
 * the real `loadConfig`, and the local one has to keep agreeing with `models.lock.json`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadConfig, type HostCapabilities } from '../../src/config.ts'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const HOST: HostCapabilities = { approvalChannel: false, scopedRestrict: false, postExecuteWaterfall: true }

function example(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${repoRoot}config/examples/${name}`, 'utf8')) as Record<string, unknown>
}

test('every shipped example is a configuration the loader accepts', () => {
  const names = readdirSync(`${repoRoot}config/examples`).filter(n => n.endsWith('.json'))
  assert.ok(names.length >= 2, 'there should be an off example and a local example')
  for (const name of names) {
    const raw = structuredClone(example(name))
    const config = loadConfig(raw, HOST)
    assert.equal(config.schemaVersion, '1', name)
    // useDefaults must have run: a shipped example never repeats the schema's defaults.
    assert.equal(typeof config.limits.deadlineMs, 'number', `${name}: defaults were not filled`)
    assert.equal(typeof config.audit.rawContent, 'boolean', `${name}: safety switch has no default`)
  }
})

test('the off example cannot do anything', () => {
  const config = loadConfig(structuredClone(example('off-minimal.json')), HOST)
  assert.equal(config.mode, 'off')
  assert.equal(config.provider.kind, 'unconfigured')
  assert.equal(config.egress.mode, 'deny')
})

test('the local example pins the model the service is built to load', () => {
  const lock = JSON.parse(readFileSync(`${repoRoot}python/models.lock.json`, 'utf8')) as {
    reference: { repository: string; revision: string }
    weights: { repository: string; revision: string; sha256: string; quantization: string }
  }
  const config = loadConfig(structuredClone(example('local-enforce.json')), HOST)
  assert.equal(config.mode, 'enforce')
  assert.ok(config.provider.local, 'expected a local provider block')
  const expected = config.provider.local.expectedModel
  assert.equal(expected.requested, lock.weights.repository)
  assert.equal(expected.revision, lock.weights.revision)
  assert.equal(expected.weightsDigest, `sha256:${lock.weights.sha256}`)
  assert.equal(expected.tokenizerRevision, lock.reference.revision)
  assert.equal(expected.quantization, lock.weights.quantization)
  // An origin the egress check would refuse makes the whole example a lie about what
  // it can reach, so the endpoint has to appear in the allowlist verbatim.
  assert.deepEqual([...(config.egress.allowedOrigins ?? [])], [config.provider.local.endpoint])
  assert.ok(config.limits.deadlineMs > 1500,
    'the CPU default budget is a cloud number; an example that uses it would always time out')
})
