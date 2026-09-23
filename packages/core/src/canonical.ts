import { createHash } from 'node:crypto'
import type { JsonValue } from 'jey-contracts'

/**
 * Deterministic digests. Every "did anything relevant change" question in Jey is
 * answered by comparing two of these, so the encoding has to be stable across
 * runs and independent of key insertion order.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('cannot digest a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k] as JsonValue)}`).join(',')}}`
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

export function digestJson(value: JsonValue): string {
  return `sha256:${sha256(canonicalJson(value))}`
}

/** UTF-8 bytes, which is the only honest unit when no tokenizer is in play (§5.2). */
export function utf8Bytes(input: string): number {
  return Buffer.byteLength(input, 'utf8')
}
