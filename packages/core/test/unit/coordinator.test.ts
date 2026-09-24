import test from 'node:test'
import assert from 'node:assert/strict'
import type { DecisionProvider, DecisionRequest, DecisionResponse, ProviderCapabilities, QuestionOutcome, SnapshotRef } from 'jey-contracts'
import { DecisionCoordinator, IllegalTransition, Run, canTransition, isClosed, type CoordinatorLimits, type CoordinatorOutcome } from '../../src/index.ts'

const IDS = { goal: 'advances-goal', evidence: 'evidence-sufficient', conflict: 'conflicts-with-constraint' }

function ref(overrides: Partial<SnapshotRef> = {}): SnapshotRef {
  return {
    sessionId: 's1', agentId: 'a1', turn: 0, step: 0, generation: 1, taskVersion: 1,
    policyVersion: 'p1', catalogDigest: 'sha256:c', callDigest: 'sha256:k', observationSequence: 3,
    ...overrides,
  }
}

function request(id = 'r1', snapshot: SnapshotRef = ref()): DecisionRequest {
  return {
    schemaVersion: '1', requestId: id, purpose: 'tool-assessment', snapshot,
    state: { goal: 'g' },
    questions: [
      { kind: 'boolean', id: IDS.goal, instructions: 'i' },
      { kind: 'boolean', id: IDS.evidence, instructions: 'i' },
      { kind: 'boolean', id: IDS.conflict, instructions: 'i' },
    ],
    budget: { maxElapsedMs: 500, maxInputBytes: 4096 },
  }
}

function response(forRequest: DecisionRequest, probabilities: Record<string, number> = { [IDS.goal]: 0.9, [IDS.evidence]: 0.9, [IDS.conflict]: 0.02 }): DecisionResponse {
  const outcomes: QuestionOutcome[] = Object.entries(probabilities).map(([id, pYes]) => ({
    id, status: 'answered' as const,
    answer: { kind: 'boolean' as const, pYes, probability: { origin: 'synthetic' as const, calibration: 'uncalibrated' as const, calibrationId: null } },
  }))
  return {
    schemaVersion: '1', requestId: forRequest.requestId, snapshot: forRequest.snapshot,
    status: 'ok',
    provider: {
      kind: 'mock', providerVersion: '0', requestedModel: 'scripted', resolvedModel: 'scripted',
      modelRevision: null, weightsDigest: null, tokenizerRevision: null, templateDigest: 'sha256:t',
      quantization: null, synthetic: true,
    },
    outcomes,
    timing: { queueMs: 0, inferenceMs: 1, totalMs: 1 },
    usage: { inputTokens: null, outputTokens: null, costUsd: null, costBasis: 'unknown' },
    egress: { occurred: false, destinationId: null },
  }
}

type Behaviour = (index: number, request: DecisionRequest, signal: AbortSignal) => Promise<DecisionResponse>

class ScriptedProvider implements DecisionProvider {
  calls = 0
  aborted = 0
  closed = 0
  readonly seen: { requestId: string; signalAborted: boolean }[] = []
  readonly behaviour: Behaviour

  constructor(behaviour: Behaviour) { this.behaviour = behaviour }

  async capabilities(): Promise<ProviderCapabilities> {
    throw new Error('not used by the coordinator')
  }

  evaluate(request: DecisionRequest, context: { signal: AbortSignal }): Promise<DecisionResponse> {
    const index = this.calls++
    context.signal.addEventListener('abort', () => { this.aborted += 1 }, { once: true })
    return this.behaviour(index, request, context.signal).then(r => {
      this.seen.push({ requestId: request.requestId, signalAborted: context.signal.aborted })
      return r
    })
  }

  async close(): Promise<void> { this.closed += 1 }
}

const immediate = (probabilities?: Record<string, number>): Behaviour => async () => response(request('unused'), probabilities)

function coordinator(provider: DecisionProvider, limits: Partial<CoordinatorLimits> = {}, diagnostics: { key: string; kind: string }[] = []): DecisionCoordinator {
  return new DecisionCoordinator(provider, {
    limits: { maxConcurrent: 2, maxQueue: 4, deadlineMs: 200, ...limits },
    onDiagnostic: e => diagnostics.push(e),
  })
}

const deferred = (): { promise: Promise<DecisionResponse>; resolve: (r: DecisionResponse) => void } & Behaviour => {
  let resolve = (_r: DecisionResponse): void => {}
  const promise = new Promise<DecisionResponse>(res => { resolve = res })
  return Object.assign((() => promise) as Behaviour, { promise, resolve })
}

const policy = (action: 'abstain' | 'ask' | 'deny' = 'abstain', appliesTo: SnapshotRef = ref()) => ({
  action, reasonCodes: ['test'], requiredQuestionIds: Object.values(IDS), observationRequestId: 'r1', appliesTo,
})

test('a normal run reaches recorded and its application applies once', async () => {
  const c = coordinator(new ScriptedProvider(immediate()))
  const outcome = await c.submit(request(), { signal: new AbortController().signal })
  assert.equal(outcome.kind, 'response')
  if (outcome.kind !== 'response') return

  const first = outcome.application.apply(ref(), { kind: 'allow' }, policy())
  assert.deepEqual(first, { kind: 'applied', decision: { kind: 'allow' } })
  assert.equal(outcome.application.phase, 'recorded')

  const second = outcome.application.apply(ref(), { kind: 'allow' }, policy('deny'))
  assert.deepEqual(second, { kind: 'already-applied' }, 'a decision cannot be applied twice')
})

test('a snapshot that moved makes the observation unapplicable', async () => {
  const c = coordinator(new ScriptedProvider(immediate()))
  const outcome = await c.submit(request(), { signal: new AbortController().signal })
  if (outcome.kind !== 'response') { assert.fail('expected response'); return }

  assert.deepEqual(outcome.application.apply(ref({ taskVersion: 2 }), { kind: 'allow' }, policy('deny')), { kind: 'stale' })
  assert.equal(outcome.application.phase, 'recorded')
})

test('the applied decision is the table-1 combination, never an invented allow', async () => {
  const c = coordinator(new ScriptedProvider(immediate()))
  const outcome = await c.submit(request(), { signal: new AbortController().signal })
  if (outcome.kind !== 'response') { assert.fail('expected response'); return }
  const r = outcome.application.apply(ref(), { kind: 'ask', reason: 'host' }, policy('deny'))
  assert.deepEqual(r, { kind: 'applied', decision: { kind: 'deny', reason: 'jey-denied: host' } })
})

test('the same (session, requestId, generation) is only ever run once', async () => {
  const gate = deferred()
  const provider = new ScriptedProvider(gate)
  const c = coordinator(provider)
  const first = c.submit(request('dup'), { signal: new AbortController().signal })
  gate.resolve(response(request('dup')))
  await first
  const second = await c.submit(request('dup'), { signal: new AbortController().signal })
  assert.deepEqual(second, { kind: 'duplicate' })
  assert.equal(provider.calls, 1)
})

test('a saturated coordinator refuses admission synchronously and never calls the provider for it', async () => {
  const gate = deferred()
  const provider = new ScriptedProvider(gate)
  const c = coordinator(provider, { maxConcurrent: 1, maxQueue: 0 })
  const running = c.submit(request('a'), { signal: new AbortController().signal })
  const rejected: Promise<CoordinatorOutcome> = c.submit(request('b'), { signal: new AbortController().signal })
  assert.deepEqual(await rejected, { kind: 'queue-full', retryable: true })
  assert.equal(provider.calls, 1)
  gate.resolve(response(request('a')))
  await running
})

test('a queue wait that eats the deadline times out before the provider is reached', async () => {
  const gate = deferred()
  const provider = new ScriptedProvider(gate)
  const c = coordinator(provider, { maxConcurrent: 1, maxQueue: 2, deadlineMs: 5 })
  const first = c.submit(request('a'), { signal: new AbortController().signal })
  const queued = c.submit(request('b'), { signal: new AbortController().signal })
  await new Promise(r => setTimeout(r, 30))
  gate.resolve(response(request('a')))
  await first
  assert.deepEqual(await queued, { kind: 'timed-out', stage: 'queue' })
  assert.equal(provider.calls, 1, 'a run that never got a slot must not consume model budget')
})

test('a queued run is served when a slot frees', async () => {
  const firstGate = deferred()
  let calls = 0
  const provider = new ScriptedProvider(async () => {
    calls += 1
    return calls === 1 ? firstGate.promise : response(request('late'))
  })
  const c = coordinator(provider, { maxConcurrent: 1, maxQueue: 2, deadlineMs: 500 })
  const a = c.submit(request('a'), { signal: new AbortController().signal })
  const b = c.submit(request('b'), { signal: new AbortController().signal })
  assert.equal(provider.calls, 1)
  firstGate.resolve(response(request('a')))
  assert.equal((await a).kind, 'response')
  assert.equal((await b).kind, 'response')
  assert.equal(provider.calls, 2)
})

test('aborting the caller reaches the provider instead of only discarding the answer', async () => {
  const never = new Promise<DecisionResponse>(() => {})
  const provider = new ScriptedProvider((_i, _r, signal) => new Promise<DecisionResponse>((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('provider stopped')), { once: true })
  }))
  void never
  const c = coordinator(provider)
  const abort = new AbortController()
  const pending = c.submit(request('a'), { signal: abort.signal })
  abort.abort()
  assert.deepEqual(await pending, { kind: 'cancelled' })
  assert.equal(provider.aborted, 1)
})

test('a late answer after the deadline is a diagnostic, not a second terminal state', async () => {
  const diagnostics: { key: string; kind: string }[] = []
  const provider = new ScriptedProvider(async () => {
    await new Promise(r => setTimeout(r, 25))
    return response(request('a'))
  })
  const c = coordinator(provider, { deadlineMs: 5 }, diagnostics)
  const outcome = await c.submit(request('a'), { signal: new AbortController().signal })
  assert.equal(outcome.kind, 'timed-out')
  await new Promise(r => setTimeout(r, 40))
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0]?.kind, 'timeout-after-answer')
})

test('a failed observation reports the provider error code', async () => {
  const provider = new ScriptedProvider(async (_i, req) => ({ ...response(req), status: 'failed' as const, outcomes: [{ id: IDS.goal, status: 'error' as const, code: 'RATE_LIMIT' as const, retryable: true }] }))
  const c = coordinator(provider)
  assert.deepEqual(await c.submit(request('a'), { signal: new AbortController().signal }), { kind: 'failed', code: 'RATE_LIMIT' })
})

test('a throwing provider fails the run rather than hanging it', async () => {
  const provider = new ScriptedProvider(async () => { throw new Error('boom') })
  const c = coordinator(provider)
  const outcome = await c.submit(request('a'), { signal: new AbortController().signal })
  assert.equal(outcome.kind, 'failed')
})

test('closing stops admission, cancels what is queued and closes the provider', async () => {
  const gate = deferred()
  const provider = new ScriptedProvider(gate)
  const c = coordinator(provider, { maxConcurrent: 1, maxQueue: 2 })
  const running = c.submit(request('a'), { signal: new AbortController().signal })
  const queued = c.submit(request('b'), { signal: new AbortController().signal })
  await c.close()
  assert.equal(provider.closed, 1)
  assert.deepEqual(await queued, { kind: 'cancelled' })
  // Close aborts in-flight work too; the answer that arrives afterwards is a diagnostic.
  assert.deepEqual(await running, { kind: 'cancelled' })
  gate.resolve(response(request('a')))
  assert.deepEqual(await c.submit(request('c'), { signal: new AbortController().signal }), { kind: 'closed' })
})

test('the lifecycle table is closed at the end and rejects skips', () => {
  const run = new Run(request('a'))
  assert.equal(run.phase, 'created')
  assert.throws(() => run.to('recorded'), IllegalTransition)
  run.to('snapshotted').to('admitted').to('queued').to('running').to('observed').to('validated').to('policy_applied').to('recorded')
  assert.equal(canTransition('recorded', 'observed'), false)
  assert.equal(isClosed('recorded'), true)
  assert.throws(() => run.to('observed'), IllegalTransition)
})
