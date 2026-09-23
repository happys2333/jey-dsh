/**
 * Real-host integration probe: a Cordis context, the published DSH services, the
 * agent-loop testkit harness, a scripted adapter, and one registered tool. Nothing here
 * mocks the host pipeline — it runs.
 *
 * @module
 */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import type { Events } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  PROBE_GUARD_DENIAL,
  installDenyingGuard,
  probePlugin,
  probeSequence,
  probeTrace,
  resetProbeTrace,
} from '../../src/probe-plugin.ts'
import type { AssembleEvent, ProbeEvent } from '../../src/probe-plugin.ts'
import { PROBE_TOOL_NAME, probeTool, probeToolBodyCalls, resetProbeToolBodyCalls } from '../../src/probe-tool.ts'
import { PROBE_LLM_ROUTE, PROBE_TOOL_NOTE, scriptedLlmPlugin } from '../../src/scripted-llm.ts'

interface ProbeHost {
  readonly ctx: Context
  readonly agent: Agent
}

/** Mounts dependencies, the probe, the scripted adapter, the tool, then the loop harness. */
async function mountHost(): Promise<ProbeHost> {
  resetProbeTrace()
  resetProbeToolBodyCalls()
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(probePlugin)
  await ctx.plugin(scriptedLlmPlugin)
  ctx.tools.register(probeTool)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('jey-probe-agent'), {
    provider: PROBE_LLM_ROUTE,
    model: 'probe-model',
  })
  return { ctx, agent }
}

/** Resolves once `agent` reports idle again; the subscription is armed before sending. */
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

/** Sends one user message and waits for the turn to finish. */
async function runTurn(ctx: Context, agent: Agent, text: string): Promise<void> {
  const settled = nextIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await settled
}

type EventOf<TStage extends ProbeEvent['stage']> = Extract<ProbeEvent, { stage: TStage }>

function eventsOf<TStage extends ProbeEvent['stage']>(stage: TStage): Array<EventOf<TStage>> {
  return probeTrace().filter((event): event is EventOf<TStage> => event.stage === stage)
}

/** Model-facing text of every durable `tool/result` event. */
function durableToolResults(agent: Agent): string[] {
  const texts: string[] = []
  for (const event of agent.session.snapshotEvents()) {
    if (event.type === 'tool/result') {
      for (const block of event.data.message.content) {
        if (block.type === 'text') texts.push(block.text)
      }
    }
  }
  return texts
}

/** Asserts exactly one durable tool result whose model-facing text matches `pattern`. */
function assertSingleToolResult(agent: Agent, pattern: RegExp): void {
  const texts = durableToolResults(agent)
  assert.equal(texts.length, 1, JSON.stringify(texts))
  assert.match(texts[0] ?? '', pattern)
}

function firstIndex(seq: readonly string[], stage: string): number {
  const index = seq.indexOf(stage)
  assert.notEqual(index, -1, `expected stage "${stage}" in ${JSON.stringify(seq)}`)
  return index
}

describe('DSH host ordering probe', () => {
  it('observes assemble -> pre-step -> pre-execute -> execute -> result on the real runtime', async () => {
    const { ctx, agent } = await mountHost()
    await runTurn(ctx, agent, 'go')
    const seq = probeSequence()
    const positions = ['assemble', 'pre-step', 'llm-request', 'pre-execute', 'execute', 'result'].map(stage =>
      firstIndex(seq, stage),
    )
    for (let index = 1; index < positions.length; index += 1) {
      const previous = positions[index - 1]
      const current = positions[index]
      assert.ok(
        (previous ?? -1) < (current ?? -1),
        `stage order violated: ${JSON.stringify(positions)} in ${JSON.stringify(seq)}`,
      )
    }
    // The probe tool ran and the second step answered in text, so the turn is complete.
    assert.deepEqual(probeToolBodyCalls(), [PROBE_TOOL_NOTE], seq.join(' '))
    assert.ok(agent.session.snapshotEvents().some(event => event.type === 'turn/end'))
    // Reproducible compatibility evidence: `JEY_TRACE_FILE=<path> pnpm test` rewrites the
    // artifact field instead of transcribing it by hand.
    if (process.env.JEY_TRACE_FILE) writeFileSync(process.env.JEY_TRACE_FILE, JSON.stringify({
      sequence: seq,
      trace: probeTrace(),
      requestHeaders: eventsOf('assemble').map(event => event.returned),
    }, null, 2) + '\n')
    await ctx.fiber.dispose()
  })

  it('advertises exactly the assembled tool set to the model', async () => {
    const { ctx, agent } = await mountHost()
    await runTurn(ctx, agent, 'go')
    const assemblies = eventsOf('assemble')
    const requests = eventsOf('llm-request')
    assert.equal(assemblies.length, 2)
    assert.equal(requests.length, 2)
    assemblies.forEach((event: AssembleEvent, index: number) => {
      assert.deepEqual(event.advertised, [PROBE_TOOL_NAME])
      assert.deepEqual(event.returned, [PROBE_TOOL_NAME])
      const request = requests[index]
      assert.deepEqual(request?.tools, event.returned)
    })
    await ctx.fiber.dispose()
  })

  it('stops the tool body when a tools/pre-execute listener denies the call', async () => {
    const { ctx, agent } = await mountHost()
    const deny: Events['tools/pre-execute'] = async () => ({ kind: 'deny', reason: 'probe-policy-denied' })
    ctx.on('tools/pre-execute', deny)
    await runTurn(ctx, agent, 'go')

    assert.deepEqual(probeToolBodyCalls(), [])
    const decisions = eventsOf('pre-execute-decision')
    assert.equal(decisions.length, 1)
    assert.equal(decisions[0]?.decision, 'deny')
    assert.equal(probeSequence().includes('execute'), false)
    assertSingleToolResult(agent, /^Error: probe-policy-denied$/)
    await ctx.fiber.dispose()
  })

  it('lets a monotonic guard denial outrank a waterfall allow', async () => {
    const { ctx, agent } = await mountHost()
    const allow: Events['tools/pre-execute'] = async () => ({ kind: 'allow' })
    ctx.on('tools/pre-execute', allow)
    const disposeGuard = installDenyingGuard(ctx, PROBE_TOOL_NAME)
    await runTurn(ctx, agent, 'go')

    const decisions = eventsOf('pre-execute-decision')
    assert.equal(decisions.length, 1)
    assert.equal(decisions[0]?.decision, 'allow')
    assert.ok(firstIndex(probeSequence(), 'guard') > firstIndex(probeSequence(), 'pre-execute'))
    assert.deepEqual(probeToolBodyCalls(), [])
    assert.equal(probeSequence().includes('execute'), false)
    assertSingleToolResult(agent, new RegExp(`^Error: ${PROBE_GUARD_DENIAL}$`))
    disposeGuard()
    await ctx.fiber.dispose()
  })

  it('gives tools/result observers a frozen outcome and no return channel', async () => {
    const { ctx, agent } = await mountHost()
    const mutationAttempts: string[] = []
    const attempt = (label: string, action: () => void): void => {
      try {
        action()
        mutationAttempts.push(`${label}:accepted`)
      } catch (error) {
        mutationAttempts.push(`${label}:${error instanceof TypeError ? 'TypeError' : 'other'}`)
      }
    }
    const observer: Events['tools/result'] = (_exec, result) => {
      attempt('result', () => Object.assign(result, { meta: { tampered: true } }))
      attempt('result.content', () => Object.assign(result.content, [{ type: 'text', text: 'tampered' }]))
      return undefined
    }
    ctx.on('tools/result', observer)
    await runTurn(ctx, agent, 'go')

    const results = eventsOf('result')
    assert.equal(results.length, 1)
    assert.equal(results[0]?.execFrozen, true)
    assert.equal(results[0]?.resultFrozen, true)
    assert.equal(results[0]?.contentFrozen, true)
    assert.equal(results[0]?.isError, false)
    assert.deepEqual(mutationAttempts, ['result:TypeError', 'result.content:TypeError'])
    // The model still reads the tool's own rendered value, not the observer's attempt.
    assert.deepEqual(durableToolResults(agent), [PROBE_TOOL_NOTE])
    await ctx.fiber.dispose()
  })

  it('degrades an ask decision to a denial because no approval service is composed', async () => {
    const { ctx, agent } = await mountHost()
    const ask: Events['tools/pre-execute'] = async (_exec, _next) => ({ kind: 'ask', reason: 'probe-ask' })
    ctx.on('tools/pre-execute', ask)
    await runTurn(ctx, agent, 'go')

    assert.deepEqual(probeToolBodyCalls(), [])
    const decisions = eventsOf('pre-execute-decision')
    assert.equal(decisions[0]?.decision, 'ask')
    assert.equal(probeSequence().includes('execute'), false)
    assertSingleToolResult(agent, /^Error: probe-ask$/)
    await ctx.fiber.dispose()
  })

  it('reports frozen parsed arguments to pre-execute listeners', async () => {
    const { ctx, agent } = await mountHost()
    await runTurn(ctx, agent, 'go')
    const calls = eventsOf('pre-execute')
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.tool, PROBE_TOOL_NAME)
    assert.equal(calls[0]?.argumentsFrozen, true)
    assert.equal(calls[0]?.argumentsJson, JSON.stringify({ note: PROBE_TOOL_NOTE }))
    await ctx.fiber.dispose()
  })
})
