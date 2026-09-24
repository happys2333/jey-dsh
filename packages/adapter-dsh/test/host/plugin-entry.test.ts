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

  it('refuses to load against a provider this build does not implement', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await assert.rejects(
      async () => { await ctx.plugin(jeyPlugin, config({ mode: 'off', provider: { kind: 'local' } })) },
      /not implemented yet/,
    )
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
