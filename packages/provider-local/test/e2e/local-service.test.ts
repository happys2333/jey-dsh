/**
 * End-to-end: the TypeScript client against the real Python service on real weights.
 *
 * This is the only test in the repository that puts a quantized checkpoint behind
 * the policy layer, so it is opt-in: without `JEY_E2E_LOCAL=1` and verified weights
 * it skips and says so. A skip is not a pass — `test:contract` proves the client,
 * and nothing here is evidence about answer quality beyond "the pipeline runs".
 *
 * @module
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DecisionRequest, SnapshotRef } from 'jey-contracts'
import { assessmentState, compileAssessment, evaluatePolicy } from 'jey-core'
import { LocalProvider } from '../../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..', '..')
const lock = JSON.parse(readFileSync(join(repoRoot, 'python', 'models.lock.json'), 'utf8')) as {
  reference: { repository: string; revision: string }
  weights: { sha256: string; repository: string; revision: string; file: string; quantization: string }
}

const enabled = process.env.JEY_E2E_LOCAL === '1'
const skip = enabled ? false : 'set JEY_E2E_LOCAL=1 with the pinned weights downloaded'
const TOKEN = `e2e-${randomUUID()}`
const STARTUP_BUDGET_MS = 180_000

const ref = (overrides: Partial<SnapshotRef> = {}): SnapshotRef => ({
  sessionId: 'e2e-session', agentId: 'e2e-agent', turn: 1, step: 1, generation: 1, taskVersion: 1,
  policyVersion: 'policy-e2e', catalogDigest: 'sha256:catalog', callDigest: 'sha256:call',
  observationSequence: 7, ...overrides,
})

async function startService(): Promise<{
  readonly provider: LocalProvider
  readonly endpoint: string
  readonly stop: () => void
}> {
  const child = spawn(process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python',
    ['-m', 'local_decider.service', '--host', '127.0.0.1', '--port', '0'],
    { cwd: join(repoRoot, 'python'), env: { ...process.env, JEY_LOCAL_TOKEN: TOKEN }, stdio: 'pipe' })
  const stop = (): void => { child.kill('SIGTERM') }
  const endpoint = await new Promise<string>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error(`the service never reported a listening port`)), STARTUP_BUDGET_MS)
    let buffer = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      buffer += chunk
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(buffer)
      if (match !== null && match[1] !== undefined) {
        clearTimeout(timer)
        accept(match[1])
      }
    })
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`service exited with ${code}: ${buffer}`)) })
  })

  const provider = new LocalProvider({ endpoint, token: () => TOKEN })
  // Liveness is served before the checkpoint finishes loading, so poll readiness too.
  const deadline = Date.now() + STARTUP_BUDGET_MS
  for (;;) {
    if (await provider.live() && (await provider.ready()).ready) break
    if (Date.now() > deadline) { child.kill('SIGTERM'); throw new Error('the local service never became ready') }
    await new Promise(done => setTimeout(done, 500))
  }
  return { provider, endpoint, stop }
}

test('the loopback service answers the real execution-gate questions', { skip, timeout: STARTUP_BUDGET_MS * 2 }, async () => {
  const { provider, endpoint, stop } = await startService()
  try {
    const capabilities = await provider.capabilities()
    const identity = capabilities.provider
    assert.equal(identity.kind, 'local')
    assert.equal(identity.synthetic, false, 'a real checkpoint must never be labelled synthetic')
    // Field by field against models.lock.json: this is what `ExpectedProvider` compares
    // against `provider.local.expectedModel` before it will send any state.
    assert.equal(identity.requestedModel, lock.weights.repository)
    assert.equal(identity.modelRevision, lock.weights.revision)
    assert.equal(identity.tokenizerRevision, lock.reference.revision)
    assert.equal(identity.weightsDigest, lock.weights.sha256)
    assert.equal(`sha256:${lock.weights.sha256}`.replace(/^sha256:/i, ''), identity.weightsDigest,
      'the config spells a digest `sha256:<hex>` and the service reports bare hex; they must agree')
    assert.equal(identity.quantization, lock.weights.quantization)
    assert.ok(identity.resolvedModel.includes(lock.weights.file),
      'the identity must name the file it opened, not just the repo')
    assert.equal(capabilities.cancellation, 'discard-only')
    assert.deepEqual(capabilities.questionKinds, ['boolean', 'choice', 'score'])

    const questions = compileAssessment()
    const request: DecisionRequest = {
      schemaVersion: '1', requestId: `req-${randomUUID()}`, purpose: 'tool-assessment',
      snapshot: ref(),
      state: assessmentState({
        toolName: 'read_test_log', frozenArguments: { logId: 'test-1' },
        goal: 'locate the cause of the failing test', constraints: ['read-only inspection only'],
      }),
      questions,
      // The largest budget the config schema will issue (limits.deadlineMs.maximum).
      budget: { maxElapsedMs: 60_000, maxInputBytes: 32_768 },
    }
    const response = await provider.evaluate(request, { signal: new AbortController().signal })

    assert.equal(response.requestId, request.requestId)
    assert.equal(response.snapshot.observationSequence, 7)
    assert.equal(response.provider.kind, 'local')
    // Every question must be accounted for exactly once; a dropped question would
    // otherwise look like "no opinion" rather than "no answer".
    const ids = response.outcomes.map(o => o.id).sort()
    assert.deepEqual(ids, questions.map(q => q.id).sort())
    assert.ok(['ok', 'partial'].includes(response.status), `status was ${response.status}`)
    for (const outcome of response.outcomes) {
      if (outcome.status !== 'answered') continue
      assert.equal(outcome.answer.kind, 'boolean')
      assert.equal(outcome.answer.probability.origin, 'native-logits')
      assert.equal(outcome.answer.probability.calibration, 'uncalibrated',
        'nothing here has been calibrated against held-out data')
      assert.equal(outcome.answer.probability.calibrationId, null)
      assert.ok(outcome.answer.pYes >= 0 && outcome.answer.pYes <= 1)
    }
    assert.equal(response.usage.outputTokens, 0, 'this readout generates no token')
    assert.equal(response.usage.costUsd, null)
    assert.equal(response.egress.occurred, false, 'a loopback call must not be reported as egress')

    // The point of the whole chain: a real, uncalibrated observation may escalate but
    // can never deny on its own (§6.4). Asserted as a property, not as this run's
    // numbers, because a different checkpoint would legitimately answer differently.
    const policy = evaluatePolicy({ mode: 'enforce', host: { kind: 'allow' }, outcomes: response.outcomes,
      approvalChannel: true, calibrationAvailable: false })
    const conflict = response.outcomes.find(o => o.id === 'conflicts-with-constraint')
    assert.notEqual(policy.action, 'deny', JSON.stringify(response.outcomes))
    assert.equal(policy.checkFailed, false)
    if (policy.action === 'ask') {
      assert.deepEqual(policy.reasonCodes, ['conflict-signal-uncalibrated'],
        `escalation must name the uncalibrated signal that caused it: ${JSON.stringify(conflict)}`)
    } else {
      assert.deepEqual(policy.reasonCodes, ['no-jey-restriction'])
      assert.equal(policy.combined.kind, 'allow', 'with nothing to add, the host decision stands')
    }

    // Opt-in evidence: what the real checkpoint actually said, so STATUS can quote a
    // number that came from a run rather than from a fixture.
    const report = process.env.JEY_LOCAL_E2E_REPORT
    if (report !== undefined) {
      // Resolved against the repo root, not the script's cwd, which is the package
      // directory under pnpm.
      writeFileSync(join(repoRoot, report), JSON.stringify({
        endpoint,
        provider: response.provider,
        status: response.status,
        outcomes: response.outcomes,
        usage: response.usage,
        timing: response.timing,
        policy: { action: policy.action, reasonCodes: policy.reasonCodes, combined: policy.combined.kind },
      }, null, 2), 'utf8')
    }
  } finally {
    stop()
  }
})

test('a cancelled request is reported as cancelled, not as an answer', { skip, timeout: STARTUP_BUDGET_MS * 2 }, async () => {
  const { provider, stop } = await startService()
  try {
    const controller = new AbortController()
    const request: DecisionRequest = {
      schemaVersion: '1', requestId: `req-${randomUUID()}`, purpose: 'explicit-query', snapshot: ref(),
      state: assessmentState({ toolName: 'read_file', frozenArguments: {}, goal: 'g', constraints: [] }),
      questions: compileAssessment(),
      // The largest budget the config schema will issue (limits.deadlineMs.maximum).
      budget: { maxElapsedMs: 60_000, maxInputBytes: 32_768 },
    }
    setTimeout(() => controller.abort(), 250)
    await assert.rejects(provider.evaluate(request, { signal: controller.signal }), (error: unknown) => {
      const code = (error as { code?: string }).code
      // Whichever side notices first, the client must not invent an answer.
      assert.ok(code === 'CANCELLED' || code === 'TIMEOUT', `unexpected code ${String(code)}`)
      return true
    })
    assert.ok(provider.calls >= 1)
  } finally {
    stop()
  }
})
