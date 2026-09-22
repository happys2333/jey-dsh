import test from 'node:test'
import assert from 'node:assert/strict'
import type { DecisionRequest } from 'jey-contracts'
import { parseDecisionRequest, parseDecisionResponse, ValidationError } from '../../src/index.ts'

const baseRequest: DecisionRequest = {
  schemaVersion: '1',
  requestId: 'req_1',
  purpose: 'tool-assessment',
  snapshot: {
    sessionId: 's1', agentId: 'a1', turn: 0, step: 0, generation: 1, taskVersion: 1,
    policyVersion: 'p1', catalogDigest: 'sha256:cat', callDigest: 'sha256:call', observationSequence: 7,
  },
  state: { task: 'ship it', candidates: ['read_file'] },
  questions: [
    { kind: 'boolean', id: 'advances-goal', instructions: 'Does this call advance the goal?' },
    { kind: 'choice', id: 'pick', instructions: 'i', options: [{ id: 'a', description: 'A' }, { id: 'b', description: 'B' }] },
    { kind: 'score', id: 'rank', instructions: 'i', levels: ['low', 'high'] },
  ],
  budget: { maxElapsedMs: 500, maxInputBytes: 4096 },
}

const clone = <T>(v: T): T => structuredClone(v)

test('a well-formed request round-trips unchanged', () => {
  assert.deepEqual(parseDecisionRequest(clone(baseRequest)), baseRequest)
})

test('the evidence template shape is rejected, not accepted with defaults', () => {
  assert.throws(() => parseDecisionRequest({}), (e: unknown) => e instanceof ValidationError && e.code === 'INVALID_INPUT')
  assert.throws(() => parseDecisionRequest('NOT_STARTED'), ValidationError)
  assert.throws(() => parseDecisionRequest(null), ValidationError)
})

function expectPaths(value: unknown, ...paths: string[]): void {
  try {
    parseDecisionRequest(value)
    assert.fail('expected rejection')
  } catch (e) {
    assert.ok(e instanceof ValidationError, `not a ValidationError: ${String(e)}`)
    for (const p of paths) assert.ok(e.paths.includes(p), `missing ${p} in ${e.paths.join(',')}`)
  }
}

test('structural problems report the offending path', () => {
  expectPaths({ ...clone(baseRequest), schemaVersion: '2' }, 'schemaVersion')
  expectPaths({ ...clone(baseRequest), purpose: 'vibes' }, 'purpose')
  expectPaths({ ...clone(baseRequest), requestId: '' }, 'requestId')
  expectPaths({ ...clone(baseRequest), questions: [] }, 'questions')
  expectPaths({ ...clone(baseRequest), budget: { maxElapsedMs: 0, maxInputBytes: 1 } }, 'budget')
  expectPaths({ ...clone(baseRequest), snapshot: { ...baseRequest.snapshot, turn: -1 } }, 'snapshot.turn')
  expectPaths({ ...clone(baseRequest), snapshot: { ...baseRequest.snapshot, catalogDigest: '' } }, 'snapshot.catalogDigest')
  expectPaths({ ...clone(baseRequest), state: { bad: undefined } }, 'state')
})

test('question variants are validated per kind', () => {
  expectPaths({ ...clone(baseRequest), questions: [{ kind: 'choice', id: 'x', instructions: 'i', options: [{ id: 'a', description: 'A' }] }] }, 'questions[0].options')
  expectPaths({ ...clone(baseRequest), questions: [{ kind: 'score', id: 'x', instructions: 'i', levels: [] }] }, 'questions[0].levels')
  expectPaths({ ...clone(baseRequest), questions: [{ kind: 'telepathy', id: 'x', instructions: 'i' }] }, 'questions[0].kind')
  expectPaths({
    ...clone(baseRequest),
    questions: [{ kind: 'boolean', id: 'dup', instructions: 'i' }, { kind: 'boolean', id: 'dup', instructions: 'i' }],
  }, 'questions')
})

test('validation collects every offending path, not just the first', () => {
  try {
    parseDecisionRequest({ ...clone(baseRequest), schemaVersion: '9', requestId: '', purpose: 'vibes' })
    assert.fail('expected rejection')
  } catch (e) {
    assert.ok(e instanceof ValidationError)
    assert.deepEqual([...e.paths].sort(), ['purpose', 'requestId', 'schemaVersion'])
  }
})

const okProvider = {
  kind: 'mock', providerVersion: '0', requestedModel: 'm', resolvedModel: 'm', modelRevision: null,
  weightsDigest: null, tokenizerRevision: null, templateDigest: 't', quantization: null, synthetic: true,
}

function responseWith(answers: unknown[]): unknown {
  return {
    schemaVersion: '1', requestId: 'req_1', snapshot: baseRequest.snapshot, status: 'ok',
    provider: okProvider,
    outcomes: answers,
    timing: { queueMs: 1, inferenceMs: 2, totalMs: 3 },
    usage: { inputTokens: null, outputTokens: null, costUsd: null, costBasis: 'unknown' },
    egress: { occurred: false, destinationId: null },
  }
}

const answered = (id: string, pYes: number) => ({
  id, status: 'answered',
  answer: { kind: 'boolean', pYes, probability: { origin: 'synthetic', calibration: 'uncalibrated', calibrationId: null } },
})

test('a valid response parses', () => {
  const r = parseDecisionResponse(responseWith([answered('advances-goal', 0.4)]))
  assert.equal(r.outcomes.length, 1)
  assert.equal(r.provider.synthetic, true)
})

test('probabilities outside [0,1] and non-finite numbers are rejected', () => {
  assert.throws(() => parseDecisionResponse(responseWith([answered('x', 1.5)])), e => e instanceof ValidationError && e.code === 'INVALID_RESPONSE')
  assert.throws(() => parseDecisionResponse(responseWith([answered('x', Number.NaN)])), ValidationError)
  assert.throws(() => parseDecisionResponse(responseWith([answered('x', 'yes' as unknown as number)])), ValidationError)
})

test('a choice answer must select a key it actually distributed over', () => {
  const bad = [{
    id: 'pick', status: 'answered',
    answer: {
      kind: 'choice', selected: 'c', probabilities: { a: 0.5, b: 0.5 },
      probability: { origin: 'provider-distribution', calibration: 'uncalibrated', calibrationId: null },
    },
  }]
  assert.throws(() => parseDecisionResponse(responseWith(bad)), (e: unknown) =>
    e instanceof ValidationError && e.paths.includes('outcomes[0].answer.selected'))
})

test('score expectedIndex must fit the distribution', () => {
  const bad = [{
    id: 'rank', status: 'answered',
    answer: {
      kind: 'score', expectedIndex: 5, levels: ['low', 'high'], probabilities: { low: 0.5, high: 0.5 },
      probability: { origin: 'provider-distribution', calibration: 'uncalibrated', calibrationId: null },
    },
  }]
  assert.throws(() => parseDecisionResponse(responseWith(bad)), (e: unknown) =>
    e instanceof ValidationError && e.paths.includes('outcomes[0].answer.expectedIndex'))
})

test('error outcomes must use a known code and explicit retryability', () => {
  assert.throws(() => parseDecisionResponse(responseWith([{ id: 'x', status: 'error', code: 'WENT_BADLY', retryable: false }])), ValidationError)
  assert.throws(() => parseDecisionResponse(responseWith([{ id: 'x', status: 'abstained', reason: 'too-vibes' }])), ValidationError)
  const ok = parseDecisionResponse(responseWith([{ id: 'x', status: 'error', code: 'RATE_LIMIT', retryable: true }]))
  assert.equal(ok.outcomes[0]?.status, 'error')
})

test('a response claiming answered with no answer is rejected', () => {
  assert.throws(() => parseDecisionResponse(responseWith([{ id: 'x', status: 'answered' }])), ValidationError)
})
