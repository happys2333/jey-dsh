import type { JsonValue } from 'jey-contracts'
import { digestJson } from './canonical.ts'

/**
 * No-progress detection, spec section 9.
 *
 * Repeating the exact same failing call is a code-level fact, so it is counted here
 * and not handed to a model. Reaching the limit pauses *that path* with a
 * recoverable result — it never bans the agent, and never ends the user's task.
 */

export interface CallObservation {
  readonly toolName: string
  readonly normalizedArguments: JsonValue
  readonly status: 'success' | 'failure'
  /** Only a deterministic, recognisable error contributes to the fingerprint. */
  readonly deterministicError: string | null
  readonly resourceVersions: Readonly<Record<string, string>>
  /** PTC/嵌套调用 roll up to their root call so one failure counts once. */
  readonly rootCallId: string | null
  /** Status polling has its own budget and is not "stuck" by repeating. */
  readonly isPoll: boolean
  readonly observationSequence: number
}

export interface ProgressConfig {
  readonly maxIdenticalFailures: number
  readonly pollBudget: number
}

export interface PathState {
  readonly fingerprint: string
  readonly count: number
  readonly polls: number
  readonly paused: boolean
  readonly lastSequence: number
}

export type ProgressStore = Readonly<Record<string, PathState>>

export type ProgressOutcome =
  | { readonly kind: 'progress' }
  | { readonly kind: 'repeat-failure'; readonly count: number }
  | { readonly kind: 'path-paused'; readonly count: number }
  | { readonly kind: 'poll-budget-exhausted'; readonly polls: number }
  | { readonly kind: 'ignored-duplicate'; readonly reason: 'already-observed' }

export const EMPTY_PROGRESS: ProgressStore = {}

/** An initial example value, not a universal constant: it belongs to the config. */
export const DEFAULT_PROGRESS_CONFIG: ProgressConfig = { maxIdenticalFailures: 3, pollBudget: 20 }

function pathKey(obs: CallObservation): string {
  return obs.rootCallId ?? digestJson([obs.toolName, obs.normalizedArguments])
}

/**
 * Anything that legitimately differs — different arguments, a different
 * deterministic error, a moved resource version — produces a different fingerprint,
 * which resets the count instead of accumulating it.
 */
export function fingerprintOf(obs: CallObservation): string {
  return digestJson([
    obs.toolName,
    obs.normalizedArguments,
    obs.deterministicError,
    obs.resourceVersions,
  ])
}

export function isPathPaused(store: ProgressStore, obs: CallObservation): boolean {
  return store[pathKey(obs)]?.paused === true
}

export function observeCall(
  store: ProgressStore,
  obs: CallObservation,
  config: ProgressConfig = DEFAULT_PROGRESS_CONFIG,
): { readonly store: ProgressStore; readonly outcome: ProgressOutcome } {
  const key = pathKey(obs)
  const previous = store[key]

  // The same final result delivered twice (outer call plus its child, or a replayed
  // notification) must not read as two failures.
  if (previous !== undefined && obs.observationSequence <= previous.lastSequence) {
    return { store, outcome: { kind: 'ignored-duplicate', reason: 'already-observed' } }
  }

  if (obs.status === 'success') {
    const next = { ...store }
    delete next[key]
    return { store: next, outcome: { kind: 'progress' } }
  }

  if (obs.isPoll) {
    const polls = (previous?.polls ?? 0) + 1
    const state: PathState = {
      fingerprint: fingerprintOf(obs),
      count: previous?.count ?? 0,
      polls,
      paused: previous?.paused ?? false,
      lastSequence: obs.observationSequence,
    }
    if (polls > config.pollBudget) {
      return { store: { ...store, [key]: { ...state, paused: true } }, outcome: { kind: 'poll-budget-exhausted', polls } }
    }
    return { store: { ...store, [key]: state }, outcome: { kind: 'progress' } }
  }

  const fingerprint = fingerprintOf(obs)

  // A paused path stays paused on the same fingerprint. Resetting the count here
  // would hand back a fresh failure budget every round and let the agent loop
  // `maxIdenticalFailures` calls at a time indefinitely.
  if (previous !== undefined && previous.paused && previous.fingerprint === fingerprint) {
    const state: PathState = { ...previous, lastSequence: obs.observationSequence }
    return { store: { ...store, [key]: state }, outcome: { kind: 'path-paused', count: previous.count } }
  }

  const sameAsBefore = previous !== undefined && previous.fingerprint === fingerprint
  const count = sameAsBefore ? previous.count + 1 : 1

  if (count >= config.maxIdenticalFailures) {
    const state: PathState = { fingerprint, count, polls: previous?.polls ?? 0, paused: true, lastSequence: obs.observationSequence }
    return { store: { ...store, [key]: state }, outcome: { kind: 'path-paused', count } }
  }
  const state: PathState = { fingerprint, count, polls: previous?.polls ?? 0, paused: false, lastSequence: obs.observationSequence }
  return { store: { ...store, [key]: state }, outcome: { kind: 'repeat-failure', count } }
}
