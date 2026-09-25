/**
 * The identity gate between `provider.local.expectedModel` and what the service reports.
 *
 * @module
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type {
  DecisionProvider, DecisionRequest, DecisionResponse, ProviderCapabilities, ProviderIdentity,
} from 'jey-contracts'
import { isErrorCode, type ModelIdentity } from 'jey-core'
import { ExpectedProvider, identityMismatches } from '../../src/identity.ts'

const MODEL_REVISION = '4168f45a16a1290d65a4ec0fa312ae917a4c15d6'
const WEIGHTS_DIGEST = '13c16f426047e2de38cd075bdade4a7bcbc8c774384876f677740cda65f8a983'
const TOKENIZER_REVISION = '851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a'

const IDENTITY: ProviderIdentity = {
  kind: 'local', providerVersion: 'local_decider/semif-0.3.35',
  requestedModel: 'bartowski/Qwen_Qwen3.5-4B-GGUF',
  resolvedModel: 'bartowski/Qwen_Qwen3.5-4B-GGUF#Qwen_Qwen3.5-4B-Q4_K_M.gguf',
  modelRevision: MODEL_REVISION,
  weightsDigest: WEIGHTS_DIGEST,
  tokenizerRevision: TOKENIZER_REVISION,
  templateDigest: 'sha256:04ebb64b', quantization: 'Q4_K_M', synthetic: false,
}

const EXPECTED: ModelIdentity = {
  requested: 'bartowski/Qwen_Qwen3.5-4B-GGUF', revision: MODEL_REVISION,
  weightsDigest: `sha256:${WEIGHTS_DIGEST}`,
  tokenizerRevision: TOKENIZER_REVISION, quantization: 'Q4_K_M',
}

const REQUEST: DecisionRequest = {
  schemaVersion: '1', requestId: 'req-1', purpose: 'tool-assessment',
  snapshot: {
    sessionId: 's', agentId: 'a', turn: 1, step: 1, generation: 1, taskVersion: 1,
    policyVersion: 'p', catalogDigest: 'sha256:c', callDigest: null, observationSequence: 1,
  },
  state: { goal: 'do the thing', constraints: ['read-only'] },
  questions: [{ kind: 'boolean', id: 'relevant', instructions: 'Does it help?' }],
  budget: { maxElapsedMs: 5000, maxInputBytes: 32768 },
}

const RESPONSE: DecisionResponse = {
  schemaVersion: '1', requestId: 'req-1', snapshot: REQUEST.snapshot, status: 'ok',
  provider: IDENTITY,
  outcomes: [{
    id: 'relevant', status: 'answered',
    answer: { kind: 'boolean', pYes: 0.9, probability: { origin: 'native-logits', calibration: 'uncalibrated', calibrationId: null } },
  }],
  timing: { queueMs: 0, inferenceMs: 1, totalMs: 1 },
  usage: { inputTokens: 100, outputTokens: 0, costUsd: null, costBasis: 'unknown' },
  egress: { occurred: false, destinationId: null },
}

class Fake implements DecisionProvider {
  probes = 0
  evaluations = 0
  closed = 0
  failProbe: Error | null = null
  readonly identity: ProviderIdentity

  constructor(identity: ProviderIdentity = IDENTITY) { this.identity = identity }

  async capabilities(): Promise<ProviderCapabilities> {
    this.probes += 1
    if (this.failProbe !== null) throw this.failProbe
    return {
      provider: this.identity, questionKinds: ['boolean'], maxInputBytes: 32768,
      maxQuestions: 8, cancellation: 'discard-only',
    }
  }

  async evaluate(): Promise<DecisionResponse> { this.evaluations += 1; return RESPONSE }

  async close(): Promise<void> { this.closed += 1 }
}

const signal = (): AbortSignal => new AbortController().signal

test('a service that names the pinned checkpoint is used', async () => {
  const fake = new Fake()
  const provider = new ExpectedProvider(fake, EXPECTED)
  assert.equal((await provider.evaluate(REQUEST, { signal: signal() })).status, 'ok')
  assert.equal(fake.evaluations, 1)
})

test('the probe happens once, not per decision', async () => {
  const fake = new Fake()
  const provider = new ExpectedProvider(fake, EXPECTED)
  await provider.evaluate(REQUEST, { signal: signal() })
  await provider.evaluate(REQUEST, { signal: signal() })
  await provider.capabilities()
  assert.equal(fake.probes, 1)
})

test('every field the config pins is compared', async () => {
  const cases: [string, Partial<ProviderIdentity>][] = [
    ['requested', { requestedModel: 'someone-else/model' }],
    ['revision', { modelRevision: '0'.repeat(40) }],
    ['weightsDigest', { weightsDigest: 'f'.repeat(64) }],
    ['tokenizerRevision', { tokenizerRevision: 'a'.repeat(40) }],
    ['quantization', { quantization: 'Q8_0' }],
    ['synthetic', { synthetic: true }],
  ]
  for (const [field, override] of cases) {
    const fake = new Fake({ ...IDENTITY, ...override })
    const provider = new ExpectedProvider(fake, EXPECTED)
    await assert.rejects(provider.evaluate(REQUEST, { signal: signal() }), (error: unknown) => {
      const e = error as { fields: string[] }
      assert.deepEqual(e.fields, [field], field)
      return true
    })
    assert.equal(fake.evaluations, 0, `${field} mismatch must not send state`)
  }
})

test('a digest is compared as bytes, not as a stringly-typed prefix', () => {
  assert.deepEqual(identityMismatches({ ...EXPECTED, weightsDigest: WEIGHTS_DIGEST }, IDENTITY), [])
  assert.deepEqual(identityMismatches({ ...EXPECTED, weightsDigest: `SHA256:${WEIGHTS_DIGEST.toUpperCase()}` }, IDENTITY), [])
  // Pinning a digest the provider cannot report at all is a mismatch, not a free pass.
  assert.deepEqual(identityMismatches(EXPECTED, { ...IDENTITY, weightsDigest: null }), ['weightsDigest'])
  // Unpinned optional fields are not invented.
  assert.deepEqual(identityMismatches({ requested: EXPECTED.requested, revision: EXPECTED.revision }, IDENTITY), [])
})

test('an unreachable service is not cached as a refusal', async () => {
  const fake = new Fake()
  fake.failProbe = Object.assign(new Error('down'), { code: 'LOCAL_NOT_READY', retryable: true })
  const provider = new ExpectedProvider(fake, EXPECTED)
  await assert.rejects(provider.evaluate(REQUEST, { signal: signal() }), /down/)
  fake.failProbe = null
  assert.equal((await provider.evaluate(REQUEST, { signal: signal() })).status, 'ok')
  assert.equal(fake.probes, 2)
})

test('the mismatch is a named provider error, not a generic one', async () => {
  const provider = new ExpectedProvider(new Fake({ ...IDENTITY, quantization: 'Q2_K' }), EXPECTED)
  let failure: (Error & { code: string; retryable: boolean }) | null = null
  try {
    await provider.evaluate(REQUEST, { signal: signal() })
  } catch (error) {
    failure = error as Error & { code: string; retryable: boolean }
  }
  assert.ok(failure !== null, 'a wrong checkpoint must not answer')
  assert.ok(isErrorCode(failure.code), `code ${failure.code} must survive the coordinator`)
  assert.equal(failure.retryable, false, 'a wrong checkpoint does not become right on retry')
})

test('close resets the gate so a remount re-probes', async () => {
  const fake = new Fake()
  const provider = new ExpectedProvider(fake, EXPECTED)
  await provider.capabilities()
  await provider.close()
  assert.equal(fake.closed, 1)
  await provider.capabilities()
  assert.equal(fake.probes, 2)
})
