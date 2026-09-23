/**
 * Jey-shaped probe plugin: observes the DSH tool/prompt/step extension points on a
 * real agent loop and records what actually happens into an ordered in-memory trace.
 *
 * Every listener is annotated with the published `Events['<name>']` signature it claims to
 * implement, so a drift between this probe and the host contract fails compilation here. A
 * negative typecheck probe showed `ctx.on()` already rejects a disagreeing listener on its
 * own (TS2322), so the annotations document intent rather than work around a hole.
 *
 * @module
 */
import type { Context, Events } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'

/** One observed stage of the host pipeline. */
export type ProbeStage =
  | 'assemble'
  | 'pre-step'
  | 'llm-request'
  | 'pre-execute'
  | 'pre-execute-decision'
  | 'execute'
  | 'post-execute'
  | 'result'
  | 'guard'

/** A `system-prompt/assemble` observation: model-visible tools before and after the waterfall. */
export interface AssembleEvent {
  readonly stage: 'assemble'
  readonly advertised: readonly string[]
  readonly returned: readonly string[]
}

/** An `agent/pre-step` observation, including whether the inner chain replaced messages. */
export interface PreStepEvent {
  readonly stage: 'pre-step'
  readonly turn: number
  readonly step: number
  readonly outcome: 'enter' | 'reject'
  readonly messagesReplaced: boolean
}

/** The model request the adapter actually received, plus the tool set it carried. */
export interface LlmRequestEvent {
  readonly stage: 'llm-request'
  readonly tools: readonly string[]
}

/** A `tools/pre-execute` observation, recorded as the call enters the waterfall. */
export interface PreExecuteEvent {
  readonly stage: 'pre-execute'
  readonly tool: string
  readonly argumentsFrozen: boolean
  readonly argumentsJson: string
}

/** The decision the `tools/pre-execute` chain settled on, seen by the probe listener. */
export interface PreExecuteDecisionEvent {
  readonly stage: 'pre-execute-decision'
  readonly tool: string
  readonly decision: PreToolDecision['kind']
}

/** A `tools/execute` around-dispatch observation. */
export interface ExecuteEvent {
  readonly stage: 'execute'
  readonly tool: string
}

/** A `tools/post-execute` observation. */
export interface PostExecuteEvent {
  readonly stage: 'post-execute'
  readonly tool: string
  readonly isError: boolean
}

/** A `tools/result` observation, including the freeze the host applies to both arguments. */
export interface ResultEvent {
  readonly stage: 'result'
  readonly tool: string
  readonly execFrozen: boolean
  readonly resultFrozen: boolean
  readonly contentFrozen: boolean
  readonly isError: boolean
}

/** A monotonic `ctx.tools.guard()` invocation marker. */
export interface GuardEvent {
  readonly stage: 'guard'
  readonly tool: string
}

/** One entry of the ordered trace. */
export type ProbeEvent =
  | AssembleEvent
  | PreStepEvent
  | LlmRequestEvent
  | PreExecuteEvent
  | PreExecuteDecisionEvent
  | ExecuteEvent
  | PostExecuteEvent
  | ResultEvent
  | GuardEvent

const trace: ProbeEvent[] = []

/** The trace in observation order; the array index is the sequence position. */
export function probeTrace(): readonly ProbeEvent[] {
  return trace
}

/** The trace as the flat stage sequence used as compatibility evidence. */
export function probeSequence(): readonly string[] {
  return trace.map(event => event.stage)
}

/** Clears the trace. Tests own this because the trace is module state. */
export function resetProbeTrace(): void {
  trace.length = 0
}

/** Appends one observation. The scripted adapter uses this to record model requests. */
export function pushProbeEvent(event: ProbeEvent): void {
  trace.push(event)
}

/**
 * Denial reason returned by the guard installed through {@link installDenyingGuard};
 * exported so a test can assert a monotonic guard denial survived a waterfall allow.
 */
export const PROBE_GUARD_DENIAL = 'jey-probe-guard-denied'

/** Installs a monotonic guard that denies `toolName`, returning its exact disposer. */
export function installDenyingGuard(ctx: Context, toolName: string): () => void {
  return ctx.tools.guard((execution: Readonly<ToolExecution>): string | undefined =>
    execution.name === toolName ? PROBE_GUARD_DENIAL : undefined)
}

/** Installs the observation guard marker on `ctx`, returning its exact disposer. */
export function installGuardMarker(ctx: Context): () => void {
  return ctx.tools.guard((execution: Readonly<ToolExecution>): string | undefined => {
    pushProbeEvent({ stage: 'guard', tool: execution.name })
    return undefined
  })
}

/** Plugin name reported to the Cordis registry. */
export const name = 'jey-probe-plugin'

/** Services the probe needs: the tool registry hosts `guard()` and the tool events. */
export const inject = ['tools']

/**
 * Registers the probe's listeners on the hosting context.
 * @param ctx - a context with `tools` active; listeners are fiber-owned.
 */
export function apply(ctx: Context): void {
  const assemble: Events['system-prompt/assemble'] = async (assembly, _context, next) => {
    const advertised = assembly.tools.map(tool => tool.name)
    const result: PromptAssembly = await next()
    pushProbeEvent({ stage: 'assemble', advertised, returned: result.tools.map(tool => tool.name) })
    return result
  }
  ctx.on('system-prompt/assemble', assemble)

  const preStep: Events['agent/pre-step'] = async (payload, next) => {
    const decision = await next()
    pushProbeEvent({
      stage: 'pre-step',
      turn: payload.turn,
      step: payload.step,
      outcome: decision.kind,
      messagesReplaced: decision.kind === 'enter' && decision.messages !== payload.messages,
    })
    return decision
  }
  ctx.on('agent/pre-step', preStep)

  const preExecute: Events['tools/pre-execute'] = async (exec, next) => {
    pushProbeEvent({
      stage: 'pre-execute',
      tool: exec.name,
      argumentsFrozen: Object.isFrozen(exec.arguments),
      argumentsJson: JSON.stringify(exec.arguments),
    })
    const decision = await next()
    pushProbeEvent({ stage: 'pre-execute-decision', tool: exec.name, decision: decision.kind })
    return decision
  }
  ctx.on('tools/pre-execute', preExecute)

  const execute: Events['tools/execute'] = async (exec, next) => {
    pushProbeEvent({ stage: 'execute', tool: exec.name })
    return next()
  }
  ctx.on('tools/execute', execute)

  const postExecute: Events['tools/post-execute'] = async (exec, result, next) => {
    const decision = await next()
    pushProbeEvent({ stage: 'post-execute', tool: exec.name, isError: result.isError })
    return decision
  }
  ctx.on('tools/post-execute', postExecute)

  // `tools/result` is an emit: its declared return is `undefined`, so the host gives the
  // observer no channel to change the outcome it is reporting.
  const result: Events['tools/result'] = (exec, outcome) => {
    pushProbeEvent({
      stage: 'result',
      tool: exec.name,
      execFrozen: Object.isFrozen(exec),
      resultFrozen: Object.isFrozen(outcome),
      contentFrozen: Object.isFrozen(outcome.content),
      isError: outcome.isError,
    })
    return undefined
  }
  ctx.on('tools/result', result)

  ctx.effect(() => installGuardMarker(ctx))
}

/** The plugin object form, for `ctx.plugin(probePlugin)`. */
export const probePlugin = { name, inject, apply }
