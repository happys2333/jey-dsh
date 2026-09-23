/**
 * Deterministic two-step model stand-in: one tool call, then plain text.
 * No network, no provider SDK — the loop's own request assembly is what is under test.
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PROBE_TOOL_NAME } from './probe-tool.ts'
import { pushProbeEvent } from './probe-plugin.ts'

/** Provider route this adapter owns; matches `AgentOptions.provider`. */
export const PROBE_LLM_ROUTE = 'jey-probe'

/** Text the script asks the model to echo through the probe tool. */
export const PROBE_TOOL_NOTE = 'probe-note-1'

function toolCallChunks(): StreamChunk[] {
  const id = ToolCallId('probe-call-1')
  const args = JSON.stringify({ note: PROBE_TOOL_NOTE })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: PROBE_TOOL_NAME, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: PROBE_TOOL_NAME, arguments: args } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Scripted adapter: step 1 calls the probe tool, step 2 answers in text and stops. */
export class ScriptedProbeLlm extends LlmAdapter {
  /** Every request the loop actually dispatched, for request-level assertions. */
  readonly requests: GenerateOptions[] = []
  #steps = 0

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    pushProbeEvent({ stage: 'llm-request', tools: (options.tools ?? []).map(tool => tool.name) })
    const chunks = this.#steps === 0 ? toolCallChunks() : textChunks('probe-final-answer')
    this.#steps += 1
    for (const chunk of chunks) yield chunk
  }
}

/** Plugin name reported to the Cordis registry. */
export const name = 'jey-probe-llm'

/** Services the adapter plugin needs. */
export const inject = ['llm']

/**
 * Registers the scripted adapter on the hosting context under {@link PROBE_LLM_ROUTE}.
 * @param ctx - a context with the LLM runtime active.
 */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter([PROBE_LLM_ROUTE], new ScriptedProbeLlm())
}

/** The plugin object form, for `ctx.plugin(scriptedLlmPlugin)`. */
export const scriptedLlmPlugin = { name, inject, apply }
