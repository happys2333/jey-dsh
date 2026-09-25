import type { DecisionRequest } from 'jey-contracts'

/**
 * Call budgets, spec section 10.4.
 *
 * Counted in calls, not dollars: without a reported cost field, a money figure would
 * be a guess, and a guess that silently stops spending looks like a working limit.
 *
 * Admission is a reserve-then-settle pair. `reserveBudget` is synchronous, and in a
 * single-threaded runtime that is enough to make it atomic — two callers competing for
 * the last slot cannot both be told yes.
 */

export interface BudgetLimits {
  readonly perTurnCalls: number
  readonly perSessionCalls: number
}

export type BudgetLedger = Readonly<Record<string, number>>

export const EMPTY_BUDGET: BudgetLedger = {}

export interface BudgetKey {
  readonly sessionId: string
  readonly agentId: string
  readonly turn: number
}

export type BudgetVerdict =
  | { readonly allowed: true; readonly ledger: BudgetLedger }
  | {
      readonly allowed: false
      readonly code: 'BUDGET_EXCEEDED'
      readonly scope: 'turn' | 'session'
      readonly used: number
      readonly limit: number
      readonly ledger: BudgetLedger
    }

const turnKey = (k: BudgetKey): string => `turn:${k.sessionId}/${k.agentId}/${k.turn}`
/**
 * The session ceiling is keyed on the session alone: sub-agents spawned inside one
 * session share its budget, otherwise each nested agent would arrive with a fresh
 * allowance and the ceiling would not bound anything a user would recognise as "this run".
 */
const sessionKey = (k: BudgetKey): string => `session:${k.sessionId}`

/** True when a later turn's allowance must not be spent by an earlier one. */
export function keyOf(request: DecisionRequest): BudgetKey {
  const { sessionId, agentId, turn } = request.snapshot
  return { sessionId, agentId, turn }
}

export function spent(ledger: BudgetLedger, k: BudgetKey): { readonly turn: number; readonly session: number } {
  return { turn: ledger[turnKey(k)] ?? 0, session: ledger[sessionKey(k)] ?? 0 }
}

export function reserveBudget(ledger: BudgetLedger, k: BudgetKey, limits: BudgetLimits): BudgetVerdict {
  const used = spent(ledger, k)
  // Checked session-first: a session-level refusal is the more specific explanation when
  // both are exhausted, and the caller only needs one reason to report.
  if (used.session >= limits.perSessionCalls) {
    return { allowed: false, code: 'BUDGET_EXCEEDED', scope: 'session', used: used.session, limit: limits.perSessionCalls, ledger }
  }
  if (used.turn >= limits.perTurnCalls) {
    return { allowed: false, code: 'BUDGET_EXCEEDED', scope: 'turn', used: used.turn, limit: limits.perTurnCalls, ledger }
  }
  return {
    allowed: true,
    ledger: { ...ledger, [turnKey(k)]: used.turn + 1, [sessionKey(k)]: used.session + 1 },
  }
}

/**
 * Give a reservation back when no provider work was ever started — a deadline spent
 * waiting in the queue must not eat the model budget it never used (spec 10.2).
 */
export function refundBudget(ledger: BudgetLedger, k: BudgetKey): BudgetLedger {
  const used = spent(ledger, k)
  if (used.turn === 0 && used.session === 0) return ledger
  const next: Record<string, number> = { ...ledger }
  const t = turnKey(k)
  const s = sessionKey(k)
  if (next[t] !== undefined && next[t] > 0) next[t] = (next[t] as number) - 1
  else delete next[t]
  if (next[s] !== undefined && next[s] > 0) next[s] = (next[s] as number) - 1
  else delete next[s]
  return next
}
