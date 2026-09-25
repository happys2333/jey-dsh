/**
 * HTTP behaviour contract. A stubbed transport stands in for the vendor: the point is
 * what the adapter does with statuses, redirects and cancellation, not reaching the
 * network. `cloud-inference` stays BLOCKED until a real key and budget exist.
 *
 * @module
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { DecisionRequest, Question } from 'jey-contracts'
import { JEV_ENDPOINT, ProviderError, TypesafeProvider } from '../../src/index.ts'

const SECRET = 'tsk_live_never_log_me'

const question: Question = { kind: 'boolean', id: 'is_urgent', instructions: 'Does this convey urgency?' }

const request: DecisionRequest = {
  schemaVersion: '1', requestId: 'req-http', purpose: 'tool-assessment',
  snapshot: {
    sessionId: 's1', agentId: 'a1', turn: 0, step: 0, generation: 1, taskVersion: 1,
    policyVersion: 'p1', catalogDigest: 'sha256:c', callDigest: null, observationSequence: 1,
  },
  state: { userTask: 'payouts failing' },
  questions: [question],
  budget: { maxElapsedMs: 1000, maxInputBytes: 4096 },
}

interface Recorded {
  url: string
  init: RequestInit
}

function stub(handler: (call: Recorded) => Response | Promise<Response>): { fetch: typeof globalThis.fetch; calls: Recorded[] } {
  const calls: Recorded[] = []
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call = { url: String(url), init: init ?? {} }
    calls.push(call)
    return handler(call)
  }
  return { fetch: impl as unknown as typeof globalThis.fetch, calls }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const OK_BODY = { model: 'jev-1.13.0', answers: { is_urgent: { type: 'noul', noul: 0.91 } }, usage: { input_tokens: 12, output_tokens: 3 } }

function provider(fetch: typeof globalThis.fetch, credential: () => string | undefined = () => SECRET): TypesafeProvider {
  return new TypesafeProvider({ model: 'jev-latest', credential, fetchImpl: fetch, destinationId: 'jev-prod' })
}

async function failure(p: TypesafeProvider): Promise<ProviderError> {
  try {
    await p.evaluate(request, { signal: new AbortController().signal })
  } catch (e) {
    assert.ok(e instanceof ProviderError, `expected ProviderError, got ${String(e)}`)
    return e
  }
  throw new Error('expected the provider to fail')
}

test('a successful call reports egress to the configured alias, never to a URL', async () => {
  const { fetch, calls } = stub(() => json(OK_BODY))
  const response = await provider(fetch).evaluate(request, { signal: new AbortController().signal })
  assert.equal(response.egress.occurred, true)
  assert.equal(response.egress.destinationId, 'jev-prod')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, JEV_ENDPOINT)
  assert.equal(response.outcomes[0]?.status, 'answered')
})

test('the credential is sent as a bearer header and never appears in an error', async () => {
  const { fetch, calls } = stub(() => json(OK_BODY))
  await provider(fetch).evaluate(request, { signal: new AbortController().signal })
  const headers = calls[0]?.init.headers as Record<string, string>
  assert.equal(headers.authorization, `Bearer ${SECRET}`)

  const failing = stub(() => new Response('boom', { status: 500 }))
  const error = await failure(provider(failing.fetch))
  assert.equal(error.message.includes(SECRET), false, error.message)
})

test('no credential means no request at all', async () => {
  const { fetch, calls } = stub(() => json(OK_BODY))
  const p = new TypesafeProvider({ model: 'm', credential: () => undefined, fetchImpl: fetch })
  const error = await failure(p)
  assert.equal(error.code, 'AUTH')
  assert.equal(calls.length, 0, 'the state must not leave while unauthenticated')
  assert.equal(p.calls, 0)
})

test('a missing key is 403 in practice even though the docs say 401', async () => {
  for (const status of [401, 403]) {
    const { fetch } = stub(() => new Response(JSON.stringify({ detail: { error_type: 'authentication_error' } }), { status }))
    const error = await failure(provider(fetch))
    assert.equal(error.code, 'AUTH', `status ${status}`)
    assert.equal(error.retryable, false)
    assert.equal(error.status, status)
  }
})

test('capacity responses are retryable, schema responses are not', async () => {
  const rate = await failure(provider(stub(() => new Response('', { status: 429 })).fetch))
  assert.deepEqual({ code: rate.code, retryable: rate.retryable }, { code: 'RATE_LIMIT', retryable: true })
  const overloaded = await failure(provider(stub(() => new Response('', { status: 529 })).fetch))
  assert.deepEqual({ code: overloaded.code, retryable: overloaded.retryable }, { code: 'OVERLOADED', retryable: true })
  const schema = await failure(provider(stub(() => new Response('', { status: 422 })).fetch))
  assert.deepEqual({ code: schema.code, retryable: schema.retryable }, { code: 'INVALID_INPUT', retryable: false })
})

test('a redirect is refused instead of followed', async () => {
  const { fetch, calls } = stub(() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example' } }))
  const error = await failure(provider(fetch))
  assert.equal(error.code, 'EGRESS_DENIED')
  assert.equal(error.message.includes('elsewhere'), false, 'the redirect target is not our business to repeat')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.init.redirect, 'manual', 'fetch must not resolve the redirect itself')
})

test('a 200 with a non-JSON body is an invalid response, not a crash', async () => {
  const error = await failure(provider(stub(() => new Response('<html>maintenance</html>', { status: 200 })).fetch))
  assert.equal(error.code, 'INVALID_RESPONSE')
})

test('an unclassified failure is reported without pretending to be one of the known ones', async () => {
  const thrown = await failure(provider(stub(() => { throw new TypeError('fetch failed') }).fetch))
  assert.equal(thrown.code, 'OVERLOADED')
  assert.equal(thrown.retryable, true)
  const unknownStatus = await failure(provider(stub(() => new Response('', { status: 418 })).fetch))
  assert.deepEqual({ code: unknownStatus.code, retryable: unknownStatus.retryable }, { code: 'INVALID_RESPONSE', retryable: false })
})

test('cancelling the caller aborts the request rather than only discarding the answer', async () => {
  let outbound: AbortSignal | undefined
  // Behaves like fetch(): a pending request rejects once its signal aborts. A stub that
  // never settled would hide exactly the hang this test is about.
  const { fetch } = stub(call => new Promise<Response>((_resolve, reject) => {
    outbound = (call.init as { signal?: AbortSignal }).signal
    outbound?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true })
  }))
  const controller = new AbortController()
  const pending = provider(fetch).evaluate(request, { signal: controller.signal })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(outbound?.aborted, false, 'the request should still be in flight before the abort')

  controller.abort()
  const error = await pending.then(() => null).catch((e: unknown) => e)
  assert.ok(error instanceof ProviderError, `expected ProviderError, got ${String(error)}`)
  assert.equal(error.code, 'CANCELLED')
  assert.equal(outbound?.aborted, true, 'the outbound fetch must have been signalled too')
})
