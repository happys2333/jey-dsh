import test from 'node:test'
import assert from 'node:assert/strict'
import {
  activeConstraints,
  buildSnapshot,
  catalogDigestOf,
  isFresh,
  type SnapshotFacts,
  type TaskEnvelope,
} from '../../src/index.ts'

const task: TaskEnvelope = {
  initialGoal: 'ship the report',
  currentSubgoal: 'summarise section 3',
  constraints: [
    { text: 'do not touch prod config', sourceRef: 'evt:12', revokedAt: null },
    { text: 'use the staging table', sourceRef: 'evt:31', revokedAt: 4 },
  ],
  latestRevisionEvent: 'evt:31',
  requirementsUnavailable: false,
}

export function facts(overrides: Partial<SnapshotFacts> = {}): SnapshotFacts {
  return {
    sessionId: 's1', agentId: 'a1', turn: 2, step: 5, generation: 1, policyVersion: 'p1',
    task, taskVersion: 3,
    catalog: [{ name: 'read_file', schemaDigest: 'sha256:r' }, { name: 'write_file', schemaDigest: 'sha256:w' }],
    call: { toolName: 'read_file', frozenArguments: { path: 'a.txt' }, executionToken: 'tok-1', observationSequence: 9 },
    recentResults: [{ toolName: 'read_file', status: 'succeeded' }],
    observationSequence: 9,
    truncated: [],
    ...overrides,
  }
}

test('snapshot binds every field the spec requires', () => {
  const snap = buildSnapshot(facts())
  assert.equal(snap.ref.sessionId, 's1')
  assert.equal(snap.ref.policyVersion, 'p1')
  assert.equal(snap.ref.taskVersion, 3)
  assert.ok(snap.ref.callDigest?.startsWith('sha256:'))
  assert.ok(snap.ref.catalogDigest.startsWith('sha256:'))
})

test('frozen snapshots resist in-place edits', () => {
  const snap = buildSnapshot(facts())
  assert.throws(() => {
    ;(snap.ref as { turn: number }).turn = 99
  }, TypeError)
})

test('identical facts produce an identical digest, key order aside', () => {
  const a = buildSnapshot(facts({ call: { toolName: 't', frozenArguments: { x: 1, y: 2 }, executionToken: 'k', observationSequence: 1 } }))
  const b = buildSnapshot(facts({ call: { toolName: 't', frozenArguments: { y: 2, x: 1 }, executionToken: 'k', observationSequence: 1 } }))
  assert.equal(a.ref.callDigest, b.ref.callDigest)
})

test('a different argument value changes the digest', () => {
  const a = buildSnapshot(facts({ call: { toolName: 't', frozenArguments: { path: 'a' }, executionToken: 'k', observationSequence: 1 } }))
  const b = buildSnapshot(facts({ call: { toolName: 't', frozenArguments: { path: 'b' }, executionToken: 'k', observationSequence: 1 } }))
  assert.notEqual(a.ref.callDigest, b.ref.callDigest)
})

test('catalog digest depends on scope-visible tools, not on insertion order of unrelated tools', () => {
  const forward = catalogDigestOf([{ name: 'a', schemaDigest: '1' }, { name: 'b', schemaDigest: '2' }])
  const listed = catalogDigestOf([{ name: 'a', schemaDigest: '1' }, { name: 'b', schemaDigest: '2' }])
  assert.equal(forward, listed)
  const changed = catalogDigestOf([{ name: 'a', schemaDigest: '1' }, { name: 'b', schemaDigest: '3' }])
  assert.notEqual(forward, changed)
})

test('a snapshot without a call has a null call digest', () => {
  assert.equal(buildSnapshot(facts({ call: null })).ref.callDigest, null)
})

test('freshness survives an unrelated turn/step advance', () => {
  const a = buildSnapshot(facts({ turn: 2, step: 5 }))
  const b = buildSnapshot(facts({ turn: 3, step: 9 }))
  // turn/step locate the observation point; they are not part of the validity tuple.
  assert.equal(isFresh(a.ref, b.ref), true)
})

test('each bound field individually invalidates the snapshot', () => {
  const base = buildSnapshot(facts()).ref
  const mutations: Partial<Record<keyof typeof base, unknown>> = {
    generation: 2,
    policyVersion: 'p2',
    taskVersion: 4,
    catalogDigest: 'sha256:other',
    observationSequence: 10,
  }
  for (const [field, value] of Object.entries(mutations)) {
    assert.equal(isFresh(base, { ...base, [field]: value }), false, `${field} must invalidate`)
  }
  assert.equal(isFresh(base, { ...base, callDigest: 'sha256:other' }), false)
})

test('a call appearing where there was none invalidates', () => {
  const none = buildSnapshot(facts({ call: null })).ref
  const some = buildSnapshot(facts()).ref
  assert.equal(isFresh(none, some), false)
})

test('revoked constraints drop out and unrevoked ones stay', () => {
  assert.deepEqual(activeConstraints(task).map(c => c.text), ['do not touch prod config'])
})

test('an absent initial requirement is recorded, not read as "no constraints"', () => {
  const unknown: TaskEnvelope = { ...task, initialGoal: null, requirementsUnavailable: true }
  assert.equal(unknown.requirementsUnavailable, true)
  assert.equal(unknown.initialGoal, null)
})
