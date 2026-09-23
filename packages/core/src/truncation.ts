import type { JsonValue } from 'jey-contracts'
import { utf8Bytes } from './canonical.ts'

/**
 * Context assembly under a byte budget, spec section 5.2.
 *
 * Stage 1 drops whole low-priority sections and, within an array section, its
 * oldest entries. Stage 2 shortens string leaves across what remains. Both stages
 * cut at JSON boundaries, so the payload can never become invalid, and both record
 * what they removed — a silently shortened string would let the model render a
 * confident verdict about text it was never shown.
 */

export type SectionKind = 'policy' | 'current-call' | 'recent-result' | 'conversation'

export interface StateSection {
  readonly id: string
  readonly kind: SectionKind
  readonly value: JsonValue
}

export interface Omission {
  readonly path: string
  readonly originalBytes: number
  readonly keptBytes: number
  readonly droppedItems: number
}

export type Fit =
  | { readonly ok: true; readonly state: Record<string, JsonValue>; readonly bytes: number; readonly omissions: readonly Omission[] }
  | { readonly ok: false; readonly code: 'INSUFFICIENT_CONTEXT'; readonly reason: string; readonly neededBytes: number }

const DROPPABLE: readonly SectionKind[] = ['conversation', 'recent-result']
const MIN_LEAF_BYTES = 24
const ELLIPSIS = '…'

function bytesOf(state: Record<string, JsonValue>): number {
  return utf8Bytes(JSON.stringify(state))
}

function maxLeafBytes(value: JsonValue): number {
  if (typeof value === 'string') return utf8Bytes(value)
  if (Array.isArray(value)) return value.reduce<number>((m, v) => Math.max(m, maxLeafBytes(v as JsonValue)), 0)
  if (value !== null && typeof value === 'object') {
    return Object.values(value).reduce<number>((m, v) => Math.max(m, maxLeafBytes(v as JsonValue)), 0)
  }
  return 0
}

function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0
  let out = ''
  for (const char of text) {
    const next = utf8Bytes(char)
    if (bytes + next > maxBytes - utf8Bytes(ELLIPSIS)) break
    out += char
    bytes += next
  }
  return out + ELLIPSIS
}

/** Copy with every string leaf above `limit` shortened, recording each one. */
function shrink(value: JsonValue, path: string, limit: number, omissions: Omission[]): JsonValue {
  if (typeof value === 'string') {
    if (utf8Bytes(value) <= limit) return value
    const kept = truncateUtf8(value, limit)
    omissions.push({ path, originalBytes: utf8Bytes(value), keptBytes: utf8Bytes(kept), droppedItems: 0 })
    return kept
  }
  if (Array.isArray(value)) return value.map((item, i) => shrink(item, `${path}[${i}]`, limit, omissions))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value)) out[key] = shrink(item as JsonValue, path === '' ? key : `${path}.${key}`, limit, omissions)
    return out
  }
  return value
}

export function fitToBudget(sections: readonly StateSection[], maxBytes: number): Fit {
  const state: Record<string, JsonValue> = {}
  for (const s of sections) state[s.id] = s.value
  const omissions: Omission[] = []

  for (let guard = 0; bytesOf(state) > maxBytes; guard++) {
    if (guard > 500) return { ok: false, code: 'INSUFFICIENT_CONTEXT', reason: 'did not converge', neededBytes: bytesOf(state) }

    const target = sections.find(s => DROPPABLE.includes(s.kind) && s.id in state)
    if (target !== undefined) {
      const value = state[target.id] as JsonValue
      if (Array.isArray(value) && value.length > 1) {
        const [oldest, ...rest] = value as JsonValue[]
        state[target.id] = rest
        omissions.push({
          path: `${target.id}[0]`,
          originalBytes: utf8Bytes(JSON.stringify(oldest)),
          keptBytes: 0,
          droppedItems: 1,
        })
        continue
      }
      delete state[target.id]
      omissions.push({
        path: target.id,
        originalBytes: utf8Bytes(JSON.stringify(value)),
        keptBytes: 0,
        droppedItems: Array.isArray(value) ? value.length : 1,
      })
      continue
    }

    // Nothing may be dropped any more: shorten protected leaves instead.
    const present = sections.filter(s => s.id in state)
    const largest = Math.max(...present.map(s => maxLeafBytes(state[s.id] as JsonValue)))
    if (largest <= MIN_LEAF_BYTES) {
      return {
        ok: false,
        code: 'INSUFFICIENT_CONTEXT',
        reason: 'policy and current call do not fit the budget',
        neededBytes: bytesOf(state),
      }
    }
    const limit = Math.max(MIN_LEAF_BYTES, Math.floor((largest - MIN_LEAF_BYTES) / 2) + MIN_LEAF_BYTES)
    for (const s of present) state[s.id] = shrink(state[s.id] as JsonValue, s.id, limit, omissions)
  }

  return { ok: true, state, bytes: bytesOf(state), omissions }
}
