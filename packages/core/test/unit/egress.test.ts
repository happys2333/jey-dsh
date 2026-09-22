import test from 'node:test'
import assert from 'node:assert/strict'
import { checkEgress, findCallerControlledTransport, type EgressAttempt, type EgressConfig } from '../../src/index.ts'

const DENY: EgressConfig = { mode: 'deny', localOrigins: [] }
const LOCAL_ONLY: EgressConfig = { mode: 'local-only', localOrigins: ['http://127.0.0.1:17861'] }
const ALLOWLIST: EgressConfig = {
  mode: 'allowlist',
  localOrigins: ['http://127.0.0.1:17861'],
  destinations: [{
    id: 'jev-prod',
    endpoint: 'https://api.typesafe.ai',
    purposes: ['tool-assessment'],
    fields: ['task', 'candidates'],
  }],
}

const cloudAttempt: EgressAttempt = {
  providerKind: 'typesafe',
  destinationId: 'jev-prod',
  endpoint: 'https://api.typesafe.ai',
  purpose: 'tool-assessment',
  fields: ['task'],
  credentialConfigured: true,
  providerExplicitlySelected: true,
}

const localAttempt: EgressAttempt = {
  providerKind: 'local',
  destinationId: null,
  endpoint: 'http://127.0.0.1:17861/v1/decide',
  purpose: 'tool-assessment',
  fields: ['task'],
  credentialConfigured: false,
  providerExplicitlySelected: true,
}

test('default deny blocks cloud and local alike', () => {
  assert.deepEqual(checkEgress(DENY, cloudAttempt), { allowed: false, code: 'EGRESS_DENIED', reasons: ['egress-mode-deny'] })
  assert.equal(checkEgress(DENY, localAttempt).allowed, false)
})

test('shadow does not relax egress: the check has no mode parameter to loosen', () => {
  assert.deepEqual(checkEgress(DENY, cloudAttempt), checkEgress(DENY, { ...cloudAttempt }))
  assert.equal(checkEgress({ ...DENY, mode: 'deny' }, cloudAttempt).allowed, false)
})

test('local-only refuses a cloud provider even when its endpoint is reachable', () => {
  const r = checkEgress(LOCAL_ONLY, cloudAttempt)
  assert.equal(r.allowed, false)
  if (!r.allowed) assert.deepEqual(r.reasons, ['local-only-rejects-cloud-provider'])
})

test('local-only accepts only an exactly allowlisted origin', () => {
  assert.deepEqual(checkEgress(LOCAL_ONLY, localAttempt), { allowed: true, destinationId: 'local:http://127.0.0.1:17861' })
  const elsewhere = checkEgress(LOCAL_ONLY, { ...localAttempt, endpoint: 'http://127.0.0.2:17861/v1/decide' })
  assert.equal(elsewhere.allowed, false)
  const evil = checkEgress(LOCAL_ONLY, { ...localAttempt, endpoint: 'http://localhost:17861.attacker.example/v1/decide' })
  assert.equal(evil.allowed, false)
})

test('a loopback-looking URL is not trusted without configuration', () => {
  const r = checkEgress({ mode: 'local-only', localOrigins: [] }, localAttempt)
  assert.equal(r.allowed, false)
})

test('mock is never a destination', () => {
  const r = checkEgress(ALLOWLIST, { ...localAttempt, providerKind: 'mock', endpoint: 'https://api.typesafe.ai' })
  assert.equal(r.allowed, false)
  if (!r.allowed) assert.deepEqual(r.reasons, ['mock-is-not-a-destination'])
})

test('cloud requires provider selection, credential, allowlisted endpoint, purpose and fields', () => {
  assert.deepEqual(checkEgress(ALLOWLIST, cloudAttempt), { allowed: true, destinationId: 'jev-prod' })
  assert.equal(checkEgress(ALLOWLIST, { ...cloudAttempt, providerExplicitlySelected: false }).allowed, false)
  assert.equal(checkEgress(ALLOWLIST, { ...cloudAttempt, credentialConfigured: false }).allowed, false)
  assert.equal(checkEgress(ALLOWLIST, { ...cloudAttempt, destinationId: 'other' }).allowed, false)
  assert.equal(checkEgress(ALLOWLIST, { ...cloudAttempt, endpoint: 'https://evil.example' }).allowed, false)
  assert.equal(checkEgress(ALLOWLIST, { ...cloudAttempt, purpose: 'explicit-query' }).allowed, false)
  const fields = checkEgress(ALLOWLIST, { ...cloudAttempt, fields: ['task', 'rawTranscript'] })
  assert.equal(fields.allowed, false)
  if (!fields.allowed) assert.deepEqual(fields.reasons, ['fields-not-allowed:rawTranscript'])
})

test('an allowlist with no destinations denies cloud traffic', () => {
  assert.equal(checkEgress({ mode: 'allowlist', localOrigins: [] }, cloudAttempt).allowed, false)
})

test('caller-controlled transport keys are found at any depth', () => {
  assert.deepEqual(
    findCallerControlledTransport({ task: 'ok', nested: { list: [{ apiKey: 'x' }] }, model_path: '/m' }),
    ['nested.list[0].apiKey', 'model_path'],
  )
  assert.deepEqual(findCallerControlledTransport('plain string'), [])
  assert.deepEqual(findCallerControlledTransport({ endpoints: ['a'], urls: {} }), [])
})
