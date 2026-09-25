/**
 * Contract tests for the local RPC client, against a stubbed transport. The service it
 * talks to is specified in `docs/handoff/docs/06_PROTOCOL_AND_CONFIG_CN.md` section 1;
 * these tests pin the client to that spec without needing a model loaded.
 *
 * @module
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { DecisionRequest, ErrorCode, SnapshotRef } from 'jey-contracts'
import { LocalError, LocalProvider, isLoopbackEndpoint } from '../../src/index.ts'

const TOKEN = 'local-random-token'

const ref = (overrides: Partial<SnapshotRef> = {}): SnapshotRef => ({
  sessionId: 's1', agentId: 'a1', turn: 1, step: 2, generation: 3, taskVersion: 1,
  policyVersion: 'p1', catalogDigest: 'sha256:c', callDigest: 'sha256:k', observationSequence: 12,
  ...overrides,
})

const request = (overrides: Partial<DecisionRequest> = {}): DecisionRequest => ({
  schemaVersion: '1', requestId: 'req-1', purpose: 'tool-assessment', snapshot: ref(),
  state: { trustedPolicy: ['仅做只读检查'], userTask: '定位测试失败原因' },
  questions: [{ kind: 'boolean', id: 'relevant', instructions: '该调用是否有助于定位失败原因？' }],
  budget: { maxElapsedMs: 3000, maxInputBytes: 32_768 },
  ...overrides,
})

const CAPABILITIES = {
  provider: {
    kind: 'local', providerVersion: '0.1.0', requestedModel: 'Qwen3.5-4B', resolvedModel: 'Qwen3.5-4B',
    modelRevision: '851bf6e8', weightsDigest: 'sha256:w', tokenizerRevision: '851bf6e8',
    templateDigest: 'sha256:t', quantization: 'Q4_K_M', synthetic: false,
  },
  questionKinds: ['boolean'],
  maxInputBytes: 32_768,
  maxQuestions: 8,
  cancellation: 'discard-only',
}

function decideResult(forRequest: DecisionRequest, overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: '1', requestId: forRequest.requestId, snapshot: forRequest.snapshot, status: 'ok',
    provider: CAPABILITIES.provider,
    outcomes: [{
      id: 'relevant', status: 'answered',
      answer: { kind: 'boolean', pYes: 0.8, probability: { origin: 'native-logits', calibration: 'uncalibrated', calibrationId: null } },
    }],
    timing: { queueMs: 1, inferenceMs: 40, totalMs: 41 },
    usage: { inputTokens: null, outputTokens: null, costUsd: null, costBasis: 'unknown' },
    egress: { occurred: true, destinationId: 'local-scoring' },
    ...overrides,
  }
}

interface Recorded { url: string; init: RequestInit }

function stub(handler: (call: Recorded) => unknown | Promise<unknown>): { fetch: typeof globalThis.fetch; calls: Recorded[] } {
  const calls: Recorded[] = []
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call = { url: String(url), init: init ?? {} }
    calls.push(call)
    const result = await handler(call)
    if (result instanceof Response) return result
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetch: impl as unknown as typeof globalThis.fetch, calls }
}

function local(
  handler: (call: Recorded) => unknown | Promise<unknown>,
  options: { token?: () => string | undefined; now?: () => number; endpoint?: string } = {},
): LocalProvider {
  const { fetch } = stub(handler)
  return new LocalProvider({
    endpoint: options.endpoint ?? 'http://127.0.0.1:17861',
    token: options.token ?? (() => TOKEN),
    fetchImpl: fetch,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
}

async function failure(p: LocalProvider, signal?: AbortSignal): Promise<LocalError> {
  try {
    await p.evaluate(request(), { signal: signal ?? new AbortController().signal })
  } catch (e) {
    assert.ok(e instanceof LocalError, `expected LocalError, got ${String(e)}`)
    return e
  }
  throw new Error('expected the client to fail')
}

test('only a loopback literal counts as local', () => {
  for (const ok of ['http://127.0.0.1:17861', 'http://127.0.0.42/v1/decide', 'http://[::1]:17861']) {
    assert.equal(isLoopbackEndpoint(ok), true, ok)
  }
  // Each of these has looked "local" to somebody: a prefix match, a resolvable name, or a
  // private address that is not this machine.
  for (const bad of ['http://127.evil.com/v1/decide', 'http://localhost:17861', 'http://192.168.1.7:17861',
    'http://10.0.0.5:17861', 'http://[::ffff:8.8.8.8]:17861', 'https://api.typesafe.ai', '127.0.0.1:17861', '']) {
    assert.equal(isLoopbackEndpoint(bad), false, bad)
  }
  assert.throws(() => local(() => ({}), { endpoint: 'http://localhost:17861' }), (e: unknown) =>
    e instanceof LocalError && e.code === 'EGRESS_DENIED')
})

test('a decision round trip preserves identity and remeasures total latency locally', async () => {
  let clock = 1000
  const p = local(async call => {
    clock = 1240
    return decideResult(JSON.parse(call.init.body as string) as DecisionRequest)
  }, { now: () => clock })
  const response = await p.evaluate(request(), { signal: new AbortController().signal })
  assert.equal(response.status, 'ok')
  assert.equal(response.outcomes[0]?.status, 'answered')
  assert.equal(response.timing.totalMs, 240, 'the service cannot see client-side queueing')
  assert.equal(response.timing.inferenceMs, 40, 'server-reported stages are kept, not overwritten')
})

test('the client passes the given budget through untouched and refuses a spent one', async () => {
  const { fetch, calls } = stub(async call => decideResult(JSON.parse(call.init.body as string) as DecisionRequest))
  const p = new LocalProvider({ endpoint: 'http://127.0.0.1:17861', token: () => TOKEN, fetchImpl: fetch })
  await p.evaluate(request({ budget: { maxElapsedMs: 500, maxInputBytes: 32_768 } }), { signal: new AbortController().signal })
  const sent = JSON.parse(calls[0]?.init.body as string) as DecisionRequest
  assert.equal(sent.budget.maxElapsedMs, 500, 'queue time belongs to the coordinator; the client may only tighten')
  assert.equal(calls.length, 1)

  const zero = new LocalProvider({ endpoint: 'http://127.0.0.1:17861', token: () => TOKEN, fetchImpl: fetch })
  const error = await zero.evaluate(request({ budget: { maxElapsedMs: 0, maxInputBytes: 32_768 } }), { signal: new AbortController().signal })
    .then(() => null, (e: unknown) => e)
  assert.ok(error instanceof LocalError)
  assert.equal(error.code, 'TIMEOUT')
  assert.equal(error.retryable, false, 'a spent deadline cannot be retried into existence')
  assert.equal(calls.length, 1, 'the refused request never left')
})

test('a request with a deadline already spent is refused before any request leaves', async () => {
  const { fetch, calls } = stub(() => ({}))
  const p = new LocalProvider({ endpoint: 'http://127.0.0.1:17861', token: () => TOKEN, fetchImpl: fetch })
  await p.evaluate(request({ budget: { maxElapsedMs: -1, maxInputBytes: 32_768 } }), { signal: new AbortController().signal })
    .then(() => assert.fail('expected rejection'), (e: unknown) => assert.ok(e instanceof LocalError))
  assert.equal(calls.length, 0)
})

test('an oversized body is refused locally instead of asking the service to reject it', async () => {
  const { fetch, calls } = stub(() => decideResult(request()))
  const p = new LocalProvider({
    endpoint: 'http://127.0.0.1:17861', token: () => TOKEN, fetchImpl: fetch, maxRequestBytes: 64,
  })
  const error = await failure(p)
  assert.equal(error.code, 'INVALID_INPUT')
  assert.equal(error.retryable, false)
  assert.equal(calls.length, 0, 'the request was never sent')
})

test('every endpoint except liveness requires the token, and it is never read implicitly', async () => {
  const { fetch, calls } = stub(() => CAPABILITIES)
  const p = new LocalProvider({ endpoint: 'http://127.0.0.1:17861', token: () => undefined, fetchImpl: fetch })
  await assert.rejects(() => p.capabilities(), (e: unknown) => e instanceof LocalError && e.code === 'AUTH')
  assert.equal(calls.length, 0)
  assert.equal(await p.live(), false, 'liveness is answered by the stub as a failure here, which must not throw')
})

test('liveness needs no token but readiness does, and neither triggers a download', async () => {
  const seen: Recorded[] = []
  const { fetch } = stub(call => {
    seen.push(call)
    return call.url.endsWith('/health/live') ? { live: true } : { ready: true }
  })
  const p = new LocalProvider({ endpoint: 'http://127.0.0.1:17861', token: () => TOKEN, fetchImpl: fetch })
  assert.equal(await p.live(), true)
  assert.deepEqual(await p.ready(), { ready: true, code: null })
  assert.equal(seen[1]?.init.headers && Object.keys(seen[1].init.headers as object).includes('authorization'), true)
})

test('a 503 readiness is a state, not an exception', async () => {
  const { fetch } = stub(() => new Response(JSON.stringify({ ready: false, code: 'LOCAL_NOT_READY' }), { status: 503 }))
  const p = new LocalProvider({ endpoint: 'http://127.0.0.1:17861', token: () => TOKEN, fetchImpl: fetch })
  assert.deepEqual(await p.ready(), { ready: false, code: 'LOCAL_NOT_READY' })
})

test('documented statuses map to the protocol codes, and the body can refine retryability', async () => {
  const cases: readonly [number, ErrorCode][] = [
    [400, 'INVALID_INPUT'], [401, 'AUTH'], [403, 'AUTH'], [413, 'INVALID_INPUT'],
    [422, 'UNSUPPORTED_CAPABILITY'], [429, 'QUEUE_FULL'], [503, 'LOCAL_NOT_READY'], [504, 'TIMEOUT'],
  ] as readonly [number, ErrorCode][]
  for (const [status, code] of cases) {
    const error = await failure(local(() => new Response('{}', { status })))
    assert.equal(error.code, code, `status ${status}`)
    assert.equal(error.status, status)
  }
  const toldOtherwise = await failure(local(() => new Response(
    JSON.stringify({ schemaVersion: '1', requestId: null, error: { code: 'QUEUE_FULL', retryable: false } }),
    { status: 503 },
  )))
  assert.equal(toldOtherwise.code, 'QUEUE_FULL', 'a service-declared code wins over the status default')
  assert.equal(toldOtherwise.retryable, false)
})

test('a redirect is refused rather than followed', async () => {
  const { fetch, calls } = stub(() => new Response(null, { status: 302, headers: { location: 'http://127.0.0.2:9' } }))
  const p = new LocalProvider({ endpoint: 'http://127.0.0.1:17861', token: () => TOKEN, fetchImpl: fetch })
  const error = await p.evaluate(request(), { signal: new AbortController().signal }).then(() => null, (e: unknown) => e)
  assert.ok(error instanceof LocalError)
  assert.equal(error.code, 'EGRESS_DENIED')
  assert.equal(calls[0]?.init.redirect, 'manual')
})

test('cancellation reports that the client gave up, never that the compute stopped', async () => {
  const controller = new AbortController()
  const { fetch } = stub(call => new Promise<Response>((_resolve, reject) => {
    (call.init as { signal?: AbortSignal }).signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  }))
  const p = new LocalProvider({ endpoint: 'http://127.0.0.1:17861', token: () => TOKEN, fetchImpl: fetch })
  const pending = p.evaluate(request(), { signal: controller.signal })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  const error = await pending.then(() => null, (e: unknown) => e)
  assert.ok(error instanceof LocalError)
  assert.equal(error.code, 'CANCELLED')
  assert.equal(p.discarded, 1, 'the client counts its own discard, which is not a claim the worker stopped')
})

test('responses are validated, not cast', async () => {
  const wrongId = async (): Promise<Response> => new Response(JSON.stringify(decideResult(request(), { requestId: 'other' })), { status: 200 })
  const error = await failure(local(wrongId))
  assert.equal(error.code, 'INVALID_RESPONSE')

  const fabricatedIdentity = await failure(local(async () => {
    const body = decideResult(request()) as Record<string, unknown>
    body.snapshot = ref({ sessionId: 'victim' })
    return new Response(JSON.stringify(body), { status: 200 })
  }))
  assert.equal(fabricatedIdentity.code, 'INVALID_RESPONSE')

  const outOfRange = await failure(local(async () => {
    const body = decideResult(request()) as { outcomes: Record<string, unknown>[] }
    body.outcomes = [{ id: 'relevant', status: 'answered', answer: { kind: 'boolean', pYes: 4, probability: { origin: 'native-logits', calibration: 'uncalibrated', calibrationId: null } } }]
    return new Response(JSON.stringify(body), { status: 200 })
  }))
  assert.equal(outOfRange.code, 'INVALID_RESPONSE', 'a pYes outside [0,1] is refused at the boundary')
})

test('capabilities require a named model identity before anything can be cached against it', async () => {
  const anonymous = structuredClone(CAPABILITIES) as { provider: Record<string, unknown> }
  delete anonymous.provider.modelRevision
  const { fetch } = stub(() => anonymous)
  const p = new LocalProvider({ endpoint: 'http://127.0.0.1:17861', token: () => TOKEN, fetchImpl: fetch })
  await assert.rejects(() => p.capabilities(), /modelRevision/)
  assert.equal(p.sawCapabilities, false)

  const discardOnly = await local(() => CAPABILITIES).capabilities()
  assert.equal(discardOnly.cancellation, 'discard-only', 'the service says honestly whether it can stop computing')

  const lying = structuredClone(CAPABILITIES) as Record<string, unknown>
  lying.cancellation = 'cooperative-magic'
  const { fetch: f2 } = stub(() => lying)
  await assert.rejects(() => new LocalProvider({ endpoint: 'http://127.0.0.1:17861', token: () => TOKEN, fetchImpl: f2 }).capabilities(),
    /cooperative or discard-only/)
})

test('capabilities are fetched once and can be refreshed on request', async () => {
  const { fetch, calls } = stub(() => CAPABILITIES)
  const p = new LocalProvider({ endpoint: 'http://127.0.0.1:17861', token: () => TOKEN, fetchImpl: fetch })
  await p.capabilities()
  await p.capabilities()
  assert.equal(calls.length, 1)
  await p.capabilities({ refresh: true })
  assert.equal(calls.length, 2)
})
