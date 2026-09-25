/**
 * Contract tests for the TypeSafe / Jev wire format. Fully offline: fixtures are
 * documentation-derived shapes and the transport is a stub. No credential exists in
 * this package's tests and none is read.
 *
 * @module
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { DecisionRequest, Question } from 'jey-contracts'
import { ProviderError, parseAnswer, parseResponse, toWireQuestions, toWireRequest } from '../../src/index.ts'

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8'))

const request = (questions: readonly Question[], overrides: Partial<DecisionRequest> = {}): DecisionRequest => ({
  schemaVersion: '1', requestId: 'req-1', purpose: 'tool-assessment',
  snapshot: {
    sessionId: 's1', agentId: 'a1', turn: 1, step: 2, generation: 1, taskVersion: 1,
    policyVersion: 'p1', catalogDigest: 'sha256:c', callDigest: null, observationSequence: 3,
  },
  state: { userTask: 'payouts have been failing for 3 days' },
  questions,
  budget: { maxElapsedMs: 3000, maxInputBytes: 32_768 },
  ...overrides,
})

const NOUL: Question = { kind: 'boolean', id: 'is_urgent', instructions: 'Does this convey urgency?' }
const CHOICE: Question = {
  kind: 'choice', id: 'department', instructions: 'Which team owns this?',
  options: [{ id: 'billing', description: 'billing issues' }, { id: 'technical', description: 'technical faults' }, { id: 'sales', description: 'sales questions' }],
}
const SCORE: Question = { kind: 'score', id: 'frustration', instructions: 'How frustrated is this?', levels: ['Calm', 'Frustrated', 'Very angry'] }

test('the outbound body is the documented envelope and nothing more', () => {
  const body = toWireRequest(request([NOUL, CHOICE, SCORE]), 'jev-latest')
  assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state'])
  assert.equal(body.model, 'jev-latest')
  assert.deepEqual(body.state, { userTask: 'payouts have been failing for 3 days' })
  // questions is a map keyed by our own ids, not an array.
  assert.deepEqual(Object.keys(body.questions).sort(), ['department', 'frustration', 'is_urgent'])
  assert.deepEqual(body.questions.is_urgent, { type: 'noul', instructions: 'Does this convey urgency?' })
  assert.deepEqual(body.questions.department, {
    type: 'choice',
    instructions: 'Which team owns this?',
    criteria: { billing: 'billing issues', technical: 'technical faults', sales: 'sales questions' },
  })
  assert.deepEqual(body.questions.frustration, {
    type: 'score', instructions: 'How frustrated is this?', criteria: ['Calm', 'Frustrated', 'Very angry'],
  })
})

test('internal identity never travels to the vendor', () => {
  const body = toWireRequest(request([NOUL]), 'm') as unknown as Record<string, unknown>
  const serialised = JSON.stringify(body)
  for (const internal of ['snapshot', 'sessionId', 'policyVersion', 'catalogDigest', 'budget', 'purpose', 'requestId']) {
    assert.equal(serialised.includes(internal), false, `${internal} must not be sent`)
  }
})

test('a duplicate question id is refused rather than silently overwriting in a map', () => {
  assert.throws(() => toWireQuestions(request([NOUL, { ...NOUL }])), (e: unknown) =>
    e instanceof ProviderError && e.code === 'INVALID_INPUT')
})

test('noul parses to a boolean observation and carries no invented confidence', () => {
  const parsed = parseResponse(request([NOUL]), fixture('noul-basic.response.json'), 'jev-latest')
  assert.equal(parsed.status, 'ok')
  const outcome = parsed.outcomes[0]
  assert.ok(outcome?.status === 'answered')
  assert.equal(outcome.answer.kind === 'boolean' && outcome.answer.pYes, 0.95)
  assert.equal(parsed.provider.kind, 'typesafe')
  assert.equal(parsed.provider.synthetic, false)
  assert.equal(parsed.provider.resolvedModel, 'jev-1.13.0')
  assert.equal(parsed.provider.requestedModel, 'jev-latest')
  assert.equal(parsed.usage.inputTokens, 307)
  assert.equal(parsed.usage.outputTokens, 20)
  assert.equal(parsed.usage.costUsd, null, 'the vendor reports no cost field, so cost stays unknown rather than zero')
  assert.equal(parsed.usage.costBasis, 'unknown')
})

test('choice keeps the raw distribution and the provider confidence separate', () => {
  const parsed = parseResponse(request([CHOICE]), fixture('choice-basic.response.json'), 'jev-latest')
  const outcome = parsed.outcomes[0]
  assert.ok(outcome?.status === 'answered' && outcome.answer.kind === 'choice')
  assert.equal(outcome.answer.selected, 'billing')
  assert.deepEqual(outcome.answer.probabilities, { billing: 0.88, technical: 0.12, sales: 0 })
  assert.equal(outcome.answer.probability.origin, 'provider-distribution')
  assert.equal(outcome.answer.probability.calibration, 'uncalibrated')
  assert.equal(outcome.answer.probability.providerConfidence, 0.81, 'a distribution statistic, not a probability of being right')
})

test('score recomputes expectedIndex and rejects a provider number that disagrees', () => {
  const parsed = parseResponse(request([SCORE]), fixture('score-basic.response.json'), 'jev-latest')
  const outcome = parsed.outcomes[0]
  assert.ok(outcome?.status === 'answered' && outcome.answer.kind === 'score')
  // 0*0 + 1*0.95 + 2*0.05 = 1.05, matching the documented `score`.
  assert.ok(Math.abs(outcome.answer.expectedIndex - 1.05) < 1e-9)
  assert.deepEqual(outcome.answer.levels, ['Calm', 'Frustrated', 'Very angry'])

  const lying = {
    model: 'jev-1.13.0',
    answers: { frustration: { type: 'score', score: 0.1, legend: { 0: 'Calm', 1: 'Frustrated', 2: 'Very angry' }, probabilities: { 0: 0, 1: 0.95, 2: 0.05 } } },
    usage: {},
  }
  const rejected = parseResponse(request([SCORE]), lying, 'm')
  assert.equal(rejected.status, 'failed')
  const failure = rejected.outcomes[0]
  assert.ok(failure?.status === 'error')
  assert.equal(failure.code, 'INVALID_RESPONSE')
})

test('a single bad answer still surfaces as a thrown ProviderError when parsed alone', () => {
  assert.throws(() => parseAnswer('frustration', SCORE, {
    type: 'score', score: 0.1, legend: { 0: 'Calm', 1: 'Frustrated', 2: 'Very angry' }, probabilities: { 0: 0, 1: 0.95, 2: 0.05 },
  }), (e: unknown) => e instanceof ProviderError && /Σ\(i×p_i\)/.test(e.message))
})

test('a question may be dropped or invented by neither direction', () => {
  const dropped = { model: 'm', answers: {}, usage: {} }
  assert.throws(() => parseResponse(request([NOUL]), dropped, 'm'), /were asked/)
  const invented = { model: 'm', answers: { is_urgent: { type: 'noul', noul: 0.5 }, bonus: { type: 'noul', noul: 0.5 } }, usage: {} }
  assert.throws(() => parseResponse(request([NOUL]), invented, 'm'), ProviderError)
})

test('answer shape violations are refused one by one', () => {
  const bad = (answer: unknown): void => {
    assert.throws(() => parseAnswer('q', NOUL, answer), (e: unknown) => e instanceof ProviderError && e.code === 'INVALID_RESPONSE')
  }
  bad({ type: 'choice', choice: 'x', probabilities: { x: 1 } })
  bad({ type: 'noul', noul: 1.5 })
  bad({ type: 'noul', noul: Number.NaN })
  bad({ type: 'noul' })
  bad({ type: 'noul', noul: 0.5, confidence: 0.9 })

  const choice = (answer: unknown): void => {
    assert.throws(() => parseAnswer('department', CHOICE, answer), (e: unknown) => e instanceof ProviderError && e.code === 'INVALID_RESPONSE')
  }
  choice({ type: 'choice', choice: 'marketing', probabilities: { billing: 1, technical: 0, sales: 0 } })
  choice({ type: 'choice', choice: 'billing', probabilities: { billing: 0.5, technical: 0.5 } })
  choice({ type: 'choice', choice: 'billing', probabilities: { billing: 0.9, technical: 0.9, sales: 0 } })

  const score = (answer: unknown): void => {
    assert.throws(() => parseAnswer('frustration', SCORE, answer), (e: unknown) => e instanceof ProviderError && e.code === 'INVALID_RESPONSE')
  }
  score({ type: 'score', score: 1, legend: { 0: 'Calm', 1: 'Angry', 2: 'Nope' }, probabilities: { 0: 0, 1: 1, 2: 0 } })
  score({ type: 'score', score: 1, legend: { 0: 'Calm', 1: 'Frustrated' }, probabilities: { 0: 0, 1: 1 } })
  score({ type: 'score', score: 1, legend: { 0: 'Calm', 1: 'Frustrated', 2: 'Very angry' }, probabilities: { 0: 0, 1: 1, 2: null } })
})

test('a response without a resolved model is refused', () => {
  assert.throws(() => parseResponse(request([NOUL]), { answers: { is_urgent: { type: 'noul', noul: 0.5 } } }, 'm'),
    /resolved model/)
})

test('one unusable answer degrades the batch to partial instead of discarding the rest', () => {
  const two = request([
    { kind: 'boolean', id: 'a', instructions: 'i' },
    { kind: 'score', id: 'b', instructions: 'i', levels: ['x', 'y'] },
  ])
  const mixed = { model: 'm', answers: { a: { type: 'noul', noul: 0.9 }, b: { type: 'noul', noul: 0.1 } }, usage: {} }
  const parsed = parseResponse(two, mixed, 'm')
  assert.equal(parsed.status, 'partial')
  const [first, second] = parsed.outcomes
  assert.equal(first?.status, 'answered')
  assert.ok(second?.status === 'error')
  assert.equal(second.code, 'INVALID_RESPONSE')
  assert.equal(second.retryable, false)

  const none = { model: 'm', answers: { a: { type: 'choice', choice: 'nope', probabilities: { x: 1 } }, b: { type: 'noul', noul: 2 } }, usage: {} }
  assert.equal(parseResponse(two, none, 'm').status, 'failed', 'a batch with nothing usable is failed, not silently ok')
})
