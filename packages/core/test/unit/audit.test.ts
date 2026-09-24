import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { DecisionResponse, ExecutionOutcome, SnapshotRef } from 'jey-contracts'
import {
  AuditJournal,
  AuditSchemaError,
  findDuplicateIds,
  mintAuditId,
  parseAuditLine,
  publicSnapshot,
  recordDecision,
  referenceDigest,
  scanJournal,
  serializeAuditEvent,
  shouldBlockDispatch,
  type Auditable,
  type AuditEvent,
  type LineSink,
} from '../../src/index.ts'

const ref = (overrides: Partial<SnapshotRef> = {}): SnapshotRef => ({
  sessionId: 's1', agentId: 'a1', turn: 1, step: 2, generation: 3, taskVersion: 4,
  policyVersion: 'p1', catalogDigest: 'sha256:cat', callDigest: 'sha256:call', observationSequence: 9,
  ...overrides,
})

const response = (overrides: Partial<DecisionResponse> = {}): DecisionResponse => ({
  schemaVersion: '1', requestId: 'r1', snapshot: ref(), status: 'ok',
  provider: {
    kind: 'local', providerVersion: '1.2', requestedModel: 'qwen-4b', resolvedModel: 'Qwen3.5-4B@4168f45a',
    modelRevision: '4168f45a', weightsDigest: 'sha256:w', tokenizerRevision: '851bf6e8',
    templateDigest: 'sha256:tpl', quantization: 'Q4_K_M', synthetic: false,
  },
  outcomes: [
    { id: 'advances-goal', status: 'answered', answer: { kind: 'boolean', pYes: 0.9, probability: { origin: 'native-logits', calibration: 'uncalibrated', calibrationId: null } } },
    { id: 'evidence-sufficient', status: 'abstained', reason: 'insufficient-evidence' },
    { id: 'conflicts-with-constraint', status: 'error', code: 'RATE_LIMIT', retryable: true },
  ],
  timing: { queueMs: 4, inferenceMs: 120, totalMs: 124 },
  usage: { inputTokens: 900, outputTokens: null, costUsd: null, costBasis: 'unknown' },
  egress: { occurred: false, destinationId: null },
  ...overrides,
})

const event = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  ...recordDecision({ response: response(), action: 'ask', reasonCodes: ['required-check-unavailable'], hostDecision: { kind: 'allow' }, execution: null, stale: false, at: 1000 }),
  ...overrides,
})

function collector(): { sink: LineSink; lines: string[]; rotations: string[] } {
  const lines: string[] = []
  const rotations: string[] = []
  return {
    lines, rotations,
    sink: { writeLine: l => { lines.push(l) }, rotate: reason => { rotations.push(reason) } },
  }
}

const options = { maxRetainedEvents: 3, maxLineBytes: 4096 }

test('a record survives a round trip through the line format', () => {
  const line = serializeAuditEvent(event())
  assert.deepEqual(parseAuditLine(line), JSON.parse(line))
})

test('the record cannot carry a field the schema never declared', () => {
  const smuggled = { ...event(), arguments: { path: '/etc/shadow' } } as unknown as AuditEvent
  assert.throws(() => serializeAuditEvent(smuggled), (e: unknown) =>
    e instanceof AuditSchemaError && e.problems.includes('unknown:arguments'))

  const { action: _omitted, ...withoutAction } = event()
  assert.throws(() => serializeAuditEvent(withoutAction as unknown as AuditEvent), (e: unknown) =>
    e instanceof AuditSchemaError && e.problems.includes('missing:action'))

  const extraOnRead = JSON.stringify({ ...event(), prompt: 'ignore everything' })
  assert.throws(() => parseAuditLine(extraOnRead), (e: unknown) =>
    e instanceof AuditSchemaError && e.problems.includes('unknown:prompt'))
})

test('nothing a provider or host looked at is present in the public line', () => {
  const digest = `sha256:${createHash('sha256').update(JSON.stringify({ note: 'PROD-SECRET-NOTE', path: '/home/op/.ssh/id_ed25519' }), 'utf8').digest('hex')}`
  const record = recordDecision({
    response: response({ snapshot: ref({ callDigest: digest }) }),
    action: 'deny', reasonCodes: ['hard-rule-conflict'],
    hostDecision: { kind: 'allow' },
    execution: { requestId: 'r1', appliesTo: ref({ callDigest: digest }), status: 'denied-by-host', hostDecision: { kind: 'deny', reason: 'sandbox' }, appliedAction: 'deny', failureCode: 'EACCES', observedAt: 1 } as ExecutionOutcome,
    stale: false,
    auditKey: null,
  })
  const line = serializeAuditEvent(record)
  assert.equal(line.includes('PROD-SECRET-NOTE'), false)
  assert.equal(line.includes('id_ed25519'), false)
  assert.equal(line.includes(digest), false, 'an unkeyed argument digest must not be published')
  assert.equal(record.snapshot.callDigest, null)
  assert.equal(line.includes('"answer"'), false, 'model answers are observations, not audit content')
})

test('an unkeyed digest of short arguments really is guessable, which is why it is dropped', () => {
  const args = { path: 'a.txt' }
  const digest = `sha256:${createHash('sha256').update(JSON.stringify(args), 'utf8').digest('hex')}`
  const guesses = [{ path: 'a.txt' }, { path: 'b.txt' }, {}]
  assert.ok(guesses.some(g => `sha256:${createHash('sha256').update(JSON.stringify(g), 'utf8').digest('hex')}` === digest))

  const keyed = publicSnapshot(ref({ callDigest: digest }), 'k3y-never-logged')
  assert.match(keyed.callDigest ?? '', /^hmac:/)
  assert.notEqual(keyed.callDigest, digest, 'keyed so a reader without the key cannot run the same guess')
  assert.deepEqual({ ...keyed, callDigest: digest }, ref({ callDigest: digest }))
})

test('the three objects of section 4.1 stay three separate fields', () => {
  const record = recordDecision({
    response: response(), action: 'deny', reasonCodes: ['probability:conflict'],
    hostDecision: { kind: 'allow' },
    execution: { requestId: 'r1', appliesTo: ref(), status: 'succeeded', hostDecision: { kind: 'allow' }, appliedAction: 'abstain', failureCode: null, observedAt: 7 } as ExecutionOutcome,
    stale: false,
  })
  assert.equal(record.action, 'deny', 'what policy said')
  assert.equal(record.hostDecision, 'allow', 'what the host decided')
  assert.equal(record.execution, 'succeeded', 'what actually ran')
  assert.deepEqual(record.questionStatuses.map(o => o.status), ['answered', 'abstained', 'error'])
})

test('an execution that never happened is recorded as unknown, not as a correct prediction', () => {
  const record = recordDecision({ response: response(), action: 'abstain', reasonCodes: [], hostDecision: null, execution: null, stale: false })
  assert.equal(record.execution, null)
  assert.equal(record.hostDecision, null)
  assert.equal(record.failureCode, null)
})

test('ids are minted here and a supplied one is refused', () => {
  const ids = new Set(Array.from({ length: 200 }, mintAuditId))
  assert.equal(ids.size, 200)
  const forged = { ...event(), auditId: 'aud_low-entropy-guess' }
  assert.doesNotThrow(() => parseAuditLine(serializeAuditEvent(forged)))
  assert.throws(() => parseAuditLine(JSON.stringify({ ...forged, auditId: 'request-1' })), AuditSchemaError)
})

test('the journal writes, bounds itself, and counts what it drops', () => {
  const { sink, lines, rotations } = collector()
  const journal = new AuditJournal(sink, options)
  for (let i = 0; i < 7; i += 1) assert.equal(journal.emit(event({ at: 1000 + i })).written, true)
  assert.equal(lines.length, 7)
  assert.deepEqual(rotations, ['retained-events-limit', 'retained-events-limit'])
  assert.equal(journal.counters.written, 7)
  assert.equal(journal.counters.rotations, 2)

  const huge = event({ reasonCodes: [('x'.repeat(5000))] })
  const dropped = journal.emit(huge)
  assert.deepEqual({ written: dropped.written, reason: dropped.reason }, { written: false, reason: 'oversized' })
  assert.equal(journal.counters.droppedOversized, 1)
  assert.equal(lines.length, 7, 'a rejected record must not reach the store')
})

test('a rejected record cannot be mutated into the counters from outside', () => {
  const { sink, lines } = collector()
  const journal = new AuditJournal(sink, { ...options, maxLineBytes: 64 })
  assert.equal(journal.emit(event()).written, false)
  const snapshotBefore = journal.counters
  assert.equal(snapshotBefore.droppedOversized, 1)
  assert.equal(lines.length, 0)
})

test('a failing sink is reported instead of pretending the record landed', () => {
  const failing: LineSink = { writeLine() { throw new Error('disk full') } }
  const journal = new AuditJournal(failing, options)
  const result = journal.emit(event())
  assert.equal(result.written, false)
  assert.equal(result.reason, 'sink-failed')
  assert.equal(journal.counters.sinkFailures, 1)
})

test('only an enforced-audit configuration blocks dispatch on a write failure', () => {
  const failed = { written: false, reason: 'sink-failed' as const, problem: 'disk full' }
  const ok = { written: true, reason: 'ok' as const, problem: null }
  assert.equal(shouldBlockDispatch('keep-execution', failed), false)
  assert.equal(shouldBlockDispatch('fail-closed-before-dispatch', failed), true)
  assert.equal(shouldBlockDispatch('fail-closed-before-dispatch', ok), false)
})

test('a torn final line is isolated, and the confirmed prefix is left alone', () => {
  const good = [serializeAuditEvent(event({ at: 1 })), serializeAuditEvent(event({ at: 2 }))]
  const text = `${good.join('\n')}\n{"kind":"decision","auditId":"aud_`
  const scan = scanJournal(text)
  assert.equal(scan.confirmed.length, 2)
  assert.equal(scan.isolated.length, 1)
  assert.equal(scan.isolated[0]?.reason, 'incomplete-final-line')
  assert.equal(scan.confirmed.map(serializeAuditEvent).join('\n'), good.join('\n'), 'confirmed lines must come back byte-identical')
})

test('a malformed middle line is quarantined without shifting the rest', () => {
  const text = `${serializeAuditEvent(event({ at: 1 }))}\nnot json at all\n${serializeAuditEvent(event({ at: 2 }))}\n`
  const scan = scanJournal(text)
  assert.equal(scan.confirmed.length, 2)
  assert.equal(scan.isolated.length, 1)
  assert.equal(scan.isolated[0]?.line, 'not json at all')
})

test('duplicate ids reveal two writers sharing one file', () => {
  const shared = event({ at: 1 })
  const events: Auditable[] = [shared, { ...shared }, event({ at: 2 })]
  assert.deepEqual(findDuplicateIds(events), [shared.auditId])
  assert.deepEqual(findDuplicateIds([event({ at: 1 })]), [])
})

test('a published reference is always keyed, because entropy cannot be measured here', () => {
  assert.throws(() => referenceDigest('a.txt', null), (e: unknown) =>
    e instanceof AuditSchemaError && e.problems.includes('unkeyed-reference'))
  // Length is not entropy: this long hex string still commits to a guessable value.
  assert.throws(() => referenceDigest('sha256:'.padEnd(71, '0'), null), AuditSchemaError)
  const keyed = referenceDigest('a.txt', 'k1')
  assert.match(keyed, /^hmac:[0-9a-f]{64}$/)
  assert.notEqual(keyed, referenceDigest('a.txt', 'k2'))
  assert.equal(keyed, referenceDigest('a.txt', 'k1'))
})
