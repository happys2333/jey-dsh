/**
 * A real registered tool, reached only through the host pipeline: its body records
 * invocations so a policy denial can be proved to have stopped the call before dispatch.
 *
 * @module
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Model-visible name of the probe tool. */
export const PROBE_TOOL_NAME = 'jey_probe_note'

const bodyCalls: string[] = []

/** Notes the tool body actually received; a denial must leave this empty. */
export function probeToolBodyCalls(): readonly string[] {
  return bodyCalls
}

/** Forgets recorded body invocations. */
export function resetProbeToolBodyCalls(): void {
  bodyCalls.length = 0
}

/** The probe tool definition, ready for `ctx.tools.register`. */
export const probeTool = defineTool({
  name: PROBE_TOOL_NAME,
  description: 'Records one note and echoes it back. Used by the host contract probe.',
  parameters: {
    note: { type: 'string', description: 'text to echo back', required: true },
  },
  output: {
    schema: {
      type: 'object',
      properties: { note: { type: 'string', required: true } },
      additionalProperties: false,
    },
    render(_args, value) {
      return [{ type: 'text', text: value.note }]
    },
  },
  async execute(args) {
    bodyCalls.push(args.note)
    return { note: args.note }
  },
})
