import test from 'node:test'
import assert from 'node:assert/strict'
import type { DecisionRequest, SnapshotRef } from 'jey-contracts'
import { EMPTY_BUDGET, keyOf, refundBudget, reserveBudget, spent, type BudgetLedger } from '../../src/index.ts'

const LIMITS = { perTurnCalls: 3, perSessionCalls: 5 }

const key = (turn: number, sessionId = 's1', agentId = 'a1') => ({ sessionId, agentId, turn })

function request(turn: number, sessionId = 's1', agentId = 'a1'): DecisionRequest {
  const snapshot = {
    sessionId, agentId, turn, step: 0, generation: 1, taskVersion: 1, policyVersion: 'p1',
    catalogDigest: 'sha256:c', callDigest: null, observationSequence: 0,
  } satisfies SnapshotRef
  return {
    schemaVersion: '1', requestId: 'r', purpose: 'tool-assessment', snapshot, state: {},
    questions: [{ kind: 'boolean', id: 'q', instructions: 'i' }],
    budget: { maxElapsedMs: 1, maxInputBytes: 1 },
  }
}

test('keyOf reads the identity that scopes a budget', () => {
  assert.deepEqual(keyOf(request(4, 'sX', 'aY')), { sessionId: 'sX', agentId: 'aY', turn: 4 })
})

test('nothing is spent on an empty ledger', () => {
  assert.deepEqual(spent(EMPTY_BUDGET, key(0)), { turn: 0, session: 0 })
})

test('the turn ceiling is enforced and reported with the numbers behind it', () => {
  let ledger: BudgetLedger = EMPTY_BUDGET
  for (let i = 0; i < 3; i += 1) {
    const r = reserveBudget(ledger, key(0), LIMITS)
    assert.equal(r.allowed, true)
    ledger = r.ledger
  }
  const refused = reserveBudget(ledger, key(0), LIMITS)
  assert.equal(refused.allowed, false)
  if (!refused.allowed) assert.deepEqual({ scope: refused.scope, used: refused.used, limit: refused.limit }, { scope: 'turn', used: 3, limit: 3 })
})

test('a new turn gets a fresh allowance under the same session ceiling', () => {
  let ledger: BudgetLedger = EMPTY_BUDGET
  for (const turn of [0, 1, 2]) {
    const r = reserveBudget(ledger, key(turn), LIMITS)
    assert.equal(r.allowed, true)
    ledger = r.ledger
  }
  // three turns, one call each: session is at 3, each turn at 1.
  assert.deepEqual(spent(ledger, key(3)), { turn: 0, session: 3 })
  const fourth = reserveBudget(ledger, key(3), LIMITS)
  assert.equal(fourth.allowed, true)
  const sixth = reserveBudget(fourth.ledger, key(4), LIMITS)
  assert.equal(sixth.allowed, true)
  const seventh = reserveBudget(sixth.ledger, key(5), LIMITS)
  assert.equal(seventh.allowed, false)
  if (!seventh.allowed) assert.equal(seventh.scope, 'session')
})

test('refusing a reservation leaves the ledger exactly as it was', () => {
  let ledger: BudgetLedger = EMPTY_BUDGET
  for (let i = 0; i < 3; i += 1) ledger = (reserveBudget(ledger, key(0), LIMITS) as { ledger: BudgetLedger }).ledger
  const refused = reserveBudget(ledger, key(0), LIMITS)
  assert.equal(refused.allowed, false)
  assert.equal(refused.ledger, ledger, 'a refused reserve must not mutate or copy the ledger')
})

test('a refund gives capacity back, and only once', () => {
  const reserved = reserveBudget(EMPTY_BUDGET, key(2), LIMITS)
  assert.equal(reserved.allowed, true)
  const refunded = refundBudget(reserved.ledger, key(2))
  assert.deepEqual(spent(refunded, key(2)), { turn: 0, session: 0 })
  assert.equal(refundBudget(refunded, key(2)), refunded, 'refunding what was never held changes nothing')
})

test('a refund never drives a counter negative', () => {
  const refunded = refundBudget(EMPTY_BUDGET, key(9))
  assert.deepEqual(spent(refunded, key(9)), { turn: 0, session: 0 })
})

test('two agents in one session share the session ceiling but not the turn counter', () => {
  let ledger: BudgetLedger = EMPTY_BUDGET
  ledger = (reserveBudget(ledger, key(0, 's1', 'aA'), LIMITS) as { ledger: BudgetLedger }).ledger
  ledger = (reserveBudget(ledger, key(0, 's1', 'aB'), LIMITS) as { ledger: BudgetLedger }).ledger
  assert.deepEqual(spent(ledger, key(0, 's1', 'aA')), { turn: 1, session: 2 })
  assert.deepEqual(spent(ledger, key(0, 's1', 'aB')), { turn: 1, session: 2 })
})

test('a zero call budget refuses immediately', () => {
  const r = reserveBudget(EMPTY_BUDGET, key(0), { perTurnCalls: 3, perSessionCalls: 0 })
  assert.equal(r.allowed, false)
  if (!r.allowed) assert.equal(r.scope, 'session')
})
