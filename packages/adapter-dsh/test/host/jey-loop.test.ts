/**
 * M2 closed loop: Jey's decision core driving a real DSH agent loop and a real
 * ToolRuntime, with only the model replaced by a scripted adapter and the decision
 * provider replaced by the synthetic mock. Nothing here stubs the host pipeline.
 *
 * @module
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import type { Events } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ConfigError, scanJournal, type AuditEvent, type LineSink } from 'jey-core'
import { mountJey, type JeyRuntime } from '../../src/jey-plugin.ts'
import { MockProvider } from '../../src/providers/mock.ts'
import { PROBE_TOOL_NAME, probeTool, probeToolBodyCalls, resetProbeToolBodyCalls } from '../../src/probe-tool.ts'
import { PROBE_LLM_ROUTE, scriptedLlmPlugin } from '../../src/scripted-llm.ts'

function jeyConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1',
    mode: 'shadow',
    provider: { kind: 'mock' },
    egress: { mode: 'deny' },
    limits: {},
    features: {},
    audit: {},
    ...overrides,
  }
}

interface Loop {
  readonly ctx: Context
  readonly agent: Agent
  readonly runtime: JeyRuntime
  readonly provider: MockProvider
  readonly lines: string[]
}

async function mountLoop(config: Record<string, unknown>, answers?: Record<string, number>): Promise<Loop> {
  resetProbeToolBodyCalls()
  const lines: string[] = []
  const audit: LineSink = { writeLine: line => { lines.push(line) } }
  const provider = new MockProvider(answers)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(scriptedLlmPlugin)
  ctx.tools.register(probeTool)
  const runtime = mountJey(ctx, config, { provider, audit })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('jey-loop-agent'), { provider: PROBE_LLM_ROUTE, model: 'loop-model' })
  return { ctx, agent, runtime, provider, lines }
}

function nextIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise(resolve => {
    const onStatus: Events['agent/status'] = payload => {
      if (payload.agent === agent && payload.status === 'idle') {
        disposeStatus()
        resolve()
      }
    }
    const disposeStatus = ctx.on('agent/status', onStatus)
  })
}

async function runTurn(ctx: Context, agent: Agent, text: string): Promise<void> {
  const settled = nextIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await settled
}

function decisions(runtime: JeyRuntime): readonly AuditEvent[] {
  return runtime.records.filter(r => r.kind === 'decision')
}

describe('Jey closed loop on a real DSH agent', () => {
  it('observes a tool call in shadow without changing what the host decided', async () => {
    const loop = await mountLoop(jeyConfig())
    await runTurn(loop.ctx, loop.agent, 'note this down')

    assert.deepEqual(probeToolBodyCalls().length, 1, 'shadow must not stop the call')
    assert.equal(loop.provider.calls, 1, 'the provider was consulted')

    const [record] = decisions(loop.runtime)
    assert.ok(record, 'expected one decision record')
    assert.equal(record.action, 'abstain')
    assert.equal(record.hostDecision, 'allow')
    assert.equal(record.synthetic, true, 'a mock answer is always labelled synthetic')
    assert.equal(record.egressOccurred, false)
    assert.equal(record.snapshot.taskVersion, 1, 'the user message reached the task state')
    assert.deepEqual(scanJournal(`${loop.lines.join('\n')}\n`).isolated, [])
    assert.equal(scanJournal(`${loop.lines.join('\n')}\n`).confirmed.length, 1)
    loop.runtime.close()
  })

  it('does not consult anything at all while off', async () => {
    const loop = await mountLoop(jeyConfig({ mode: 'off' }))
    await runTurn(loop.ctx, loop.agent, 'note this down')
    assert.equal(loop.provider.calls, 0)
    assert.deepEqual(decisions(loop.runtime), [])
    assert.deepEqual(loop.lines, [])
    assert.equal(probeToolBodyCalls().length, 1)
    loop.runtime.close()
  })

  it('refuses to install itself as an enforcer backed by synthetic answers', async () => {
    await assert.rejects(async () => mountLoop(jeyConfig({ mode: 'enforce' })), (e: unknown) => {
      assert.ok(e instanceof ConfigError, `expected ConfigError, got ${String(e)}`)
      assert.ok(e.errors.some(x => x.code === 'ENFORCE_WITH_MOCK'), JSON.stringify(e.errors))
      return true
    })
  })

  it('denies a paused path on deterministic rules alone, without reaching a provider', async () => {
    const loop = await mountLoop(jeyConfig({ mode: 'shadow' }))
    // The pause is a recorded fact about what already happened, so it needs no model and
    // no permission to guess: it holds even in shadow, which is also what the sync guard does.
    loop.runtime.progress = {
      [PROBE_TOOL_NAME]: { fingerprint: 'frozen', count: 3, polls: 0, paused: true, lastSequence: 0 },
    }
    await runTurn(loop.ctx, loop.agent, 'note this down')

    assert.equal(loop.provider.calls, 0, 'a hard rule must not pay for a model call')
    assert.deepEqual(probeToolBodyCalls(), [], 'the tool body never ran')
    const [record] = decisions(loop.runtime)
    assert.equal(record?.action, 'deny')
    assert.ok(record?.reasonCodes.some(c => c.startsWith('hard-rule:path-paused')))
    assert.equal(scanJournal(`${loop.lines.join('\n')}\n`).confirmed.length, 1)
    loop.runtime.close()
  })

  it('stops observing once the plugin instance is disposed', async () => {
    const loop = await mountLoop(jeyConfig())
    await runTurn(loop.ctx, loop.agent, 'first')
    assert.equal(loop.provider.calls, 1)
    loop.runtime.close()

    await runTurn(loop.ctx, loop.agent, 'second')
    assert.equal(loop.provider.calls, 1, 'a disposed instance must leave no listener behind')
    assert.equal(decisions(loop.runtime).length, 1)
  })

  it('records the three stages separately so a prediction cannot read as an outcome', async () => {
    const loop = await mountLoop(jeyConfig())
    await runTurn(loop.ctx, loop.agent, 'note this down')
    const [record] = decisions(loop.runtime)
    assert.ok(record)
    assert.equal(record.action, 'abstain', 'what policy said')
    assert.equal(record.hostDecision, 'allow', 'what the host decided')
    assert.equal(record.execution, null, 'what actually ran is a separate stage, never inferred from the first two')
    assert.deepEqual(record.questionStatuses.map(o => o.status), ['answered', 'answered', 'answered'])
    loop.runtime.close()
  })
})
