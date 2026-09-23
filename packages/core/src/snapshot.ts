import type { JsonValue, SnapshotRef } from 'jey-contracts'
import { digestJson } from './canonical.ts'

/**
 * Snapshot construction and freshness, spec sections 4.2 and 10.1.
 *
 * A snapshot is the record of what Jey was actually shown. It is not an
 * authorization: nothing in here may widen what the host permits, and a
 * constraint summary is model input, not an enforceable rule.
 */

export interface TaskConstraint {
  readonly text: string
  /** Where the user said it, so a later turn cannot silently retire it. */
  readonly sourceRef: string
  readonly revokedAt: number | null
}

export interface TaskEnvelope {
  readonly initialGoal: string | null
  readonly currentSubgoal: string | null
  readonly constraints: readonly TaskConstraint[]
  readonly latestRevisionEvent: string | null
  /**
   * True when the host never surfaced an initial user requirement. Absence of
   * visible constraints must be recorded as unknown, not as "user has no limits"
   * (§5.1) — a compaction that dropped "don't touch prod config" is invisible here.
   */
  readonly requirementsUnavailable: boolean
}

export interface ToolCatalogEntry {
  readonly name: string
  readonly schemaDigest: string
}

export interface ObservedCall {
  readonly toolName: string
  readonly frozenArguments: JsonValue
  readonly executionToken: string
  readonly observationSequence: number
}

export interface SnapshotFacts {
  readonly sessionId: string
  readonly agentId: string
  readonly turn: number
  readonly step: number
  readonly generation: number
  readonly policyVersion: string
  readonly task: TaskEnvelope
  readonly taskVersion: number
  readonly catalog: readonly ToolCatalogEntry[]
  readonly call: ObservedCall | null
  readonly recentResults: readonly { readonly toolName: string; readonly status: string }[]
  readonly observationSequence: number
  readonly truncated: readonly string[]
}

export interface DecisionSnapshot {
  readonly ref: SnapshotRef
  readonly facts: SnapshotFacts
}

export function buildSnapshot(facts: SnapshotFacts): DecisionSnapshot {
  const ref: SnapshotRef = {
    sessionId: facts.sessionId,
    agentId: facts.agentId,
    turn: facts.turn,
    step: facts.step,
    generation: facts.generation,
    taskVersion: facts.taskVersion,
    policyVersion: facts.policyVersion,
    // Computed from the tools visible in *this* scope, never from a process-global
    // `tools/change` counter: that event also fires for our own restriction, which
    // would make the snapshot invalidate itself and cross-contaminate other agents.
    catalogDigest: catalogDigestOf(facts.catalog),
    callDigest: facts.call === null ? null : digestJson(facts.call.frozenArguments),
    observationSequence: facts.observationSequence,
  }
  return Object.freeze({ ref: Object.freeze(ref), facts: Object.freeze({ ...facts }) })
}

export function catalogDigestOf(catalog: readonly ToolCatalogEntry[]): string {
  return digestJson(catalog.map(e => [e.name, e.schemaDigest]))
}

/**
 * Every bound field must still match when the decision is applied. A matching
 * digest is not proof about the outside world — filesystem and network state can
 * still move underneath us, which is why execution stays with the host (§10.1).
 */
export function isFresh(captured: SnapshotRef, current: SnapshotRef): boolean {
  return captured.sessionId === current.sessionId
    && captured.agentId === current.agentId
    && captured.generation === current.generation
    && captured.policyVersion === current.policyVersion
    && captured.taskVersion === current.taskVersion
    && captured.catalogDigest === current.catalogDigest
    && captured.callDigest === current.callDigest
    && captured.observationSequence === current.observationSequence
}

/** Active constraints are the ones the user has not revoked, regardless of recency. */
export function activeConstraints(task: TaskEnvelope): readonly TaskConstraint[] {
  return task.constraints.filter(c => c.revokedAt === null)
}
