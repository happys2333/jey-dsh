/**
 * The production entry point: `ctx.plugin(jeyPlugin, config)` exactly as a cordis.yml
 * overlay would load it, with no injected provider and no injected sink. Everything the
 * mountJey tests bypass, this one has to go through.
 *
 * @module
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import type { Events } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { parseAuditLine, scanJournal, type AuditEvent } from 'jey-core'
import { jeyPlugin } from '../../src/jey-plugin.ts'
import { probeTool, probeToolBodyCalls, resetProbeToolBodyCalls } from '../../src/probe-tool.ts'
import { PROBE_LLM_ROUTE, scriptedLlmPlugin } from '../../src/scripted-llm.ts'

async function nextIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise(resolve => {
    const onStatus: Events['agent/status'] = payload => {
      if (payload.agent === agent && payload.status === 'idle') {
        dispose()
        resolve()
      }
    }
    const dispose = ctx.on('agent/status', onStatus)
  })
}

async function bootHost(): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(scriptedLlmPlugin)
  ctx.tools.register(probeTool)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('jey-entry-agent'), { provider: PROBE_LLM_ROUTE, model: 'entry-model' })
  return { ctx, agent }
}

const config = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: '1', mode: 'shadow', provider: { kind: 'mock' },
  egress: { mode: 'deny' }, limits: {}, features: {}, audit: {}, ...overrides,
})

describe('jey plugin loaded through its real cordis entry point', () => {
  const previous = process.env.JEY_AUDIT_PATH

  it('writes its audit trail to the configured file and the lines read back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jey-entry-'))
    const path = join(dir, 'diagnostics.jsonl')
    process.env.JEY_AUDIT_PATH = path
    try {
      resetProbeToolBodyCalls()
      const { ctx, agent } = await bootHost()
      await ctx.plugin(jeyPlugin, config())

      const settled = nextIdle(ctx, agent)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'note this down' }], source: { kind: 'user' } }))
      await settled

      assert.equal(probeToolBodyCalls().length, 1, 'shadow left execution alone')
      const text = readFileSync(path, 'utf8')
      const scan = scanJournal(text)
      assert.deepEqual(scan.isolated, [], `unexpected isolated lines: ${JSON.stringify(scan.isolated)}`)
      assert.equal(scan.confirmed.length, 1)
      const record = scan.confirmed[0] as AuditEvent
      assert.equal(record.kind, 'decision')
      assert.equal(record.action, 'abstain')
      assert.equal(record.hostDecision, 'allow')
      assert.equal(record.synthetic, true, 'the internally constructed provider is still labelled synthetic')
      assert.deepEqual(parseAuditLine(text.trim()), record)
      await ctx.fiber.dispose()
    } finally {
      if (previous === undefined) delete process.env.JEY_AUDIT_PATH
      else process.env.JEY_AUDIT_PATH = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses to load against the local provider, which M3 has not built yet', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await assert.rejects(
      async () => { await ctx.plugin(jeyPlugin, config({ mode: 'off', provider: { kind: 'local' } })) },
      /arrives with M3/,
    )
  })

  it('will not send state to a cloud destination that was never allowlisted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jey-egress-'))
    const path = join(dir, 'diagnostics.jsonl')
    const previousPath = process.env.JEY_AUDIT_PATH
    process.env.JEY_AUDIT_PATH = path
    const realFetch = globalThis.fetch
    let outbound = 0
    globalThis.fetch = (async () => {
      outbound += 1
      throw new Error('a contract test must never reach the network')
    }) as unknown as typeof globalThis.fetch
    const previousKey = process.env.JEY_TEST_ABSENT_KEY
    delete process.env.JEY_TEST_ABSENT_KEY

    try {
      const ctx = new Context()
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(scriptedLlmPlugin)
      resetProbeToolBodyCalls()
      ctx.tools.register(probeTool)
      await ctx.plugin(jeyPlugin, config({
        mode: 'shadow',
        provider: { kind: 'typesafe', typesafe: { credentialRef: 'env:JEY_TEST_ABSENT_KEY', model: 'jev-latest', endpointOrigin: 'https://api.typesafe.ai' } },
        // Origins alone are not a destination: without a named destination carrying its own
        // purpose and field allowlists, spec 5.3's conditions are unmet.
        egress: { mode: 'allowlist', allowedPurposes: ['tool-assessment'], allowedOrigins: ['https://api.typesafe.ai'] },
        features: { toolAssessment: true },
      }))
      const harness = await mountAgentLoopTestHarness(ctx)
      const agent = await harness.create(SessionId('jey-egress-agent'), { provider: PROBE_LLM_ROUTE, model: 'egress-model' })
      const settled = nextIdle(ctx, agent)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'check this' }], source: { kind: 'user' } }))
      await settled

      assert.equal(outbound, 0, 'nothing may leave the process without an allowlisted destination')
      assert.equal(probeToolBodyCalls().length, 1, 'shadow records the refusal and leaves execution alone')
      const scan = scanJournal(readFileSync(path, 'utf8'))
      const [record] = scan.confirmed
      assert.ok(record, `expected an audit record, got ${JSON.stringify(scan.isolated)}`)
      assert.equal(record.kind, 'decision')
      assert.ok(record.reasonCodes.some(c => c.startsWith('destination-not-named')), JSON.stringify(record.reasonCodes))
      assert.equal(record.reasonCodes.filter(c => c.startsWith('unusable:')).length, 3,
        'each unusable question is reported once, not once per reason it qualifies for')
      assert.equal(record.egressOccurred, false)
      await ctx.fiber.dispose()
    } finally {
      globalThis.fetch = realFetch
      if (previousPath === undefined) delete process.env.JEY_AUDIT_PATH
      else process.env.JEY_AUDIT_PATH = previousPath
      if (previousKey !== undefined) process.env.JEY_TEST_ABSENT_KEY = previousKey
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a config that would enforce on synthetic answers, at load time', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await assert.rejects(
      async () => { await ctx.plugin(jeyPlugin, config({ mode: 'enforce' })) },
      (e: unknown) => e instanceof Error && /ENFORCE_WITH_MOCK|invalid Jey configuration/.test(e.message),
    )
  })
})
