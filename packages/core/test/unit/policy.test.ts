import test from 'node:test'
import assert from 'node:assert/strict'
import type { DecisionAction, HostDecision, QuestionOutcome } from 'jey-contracts'
import { combineHostAndJey, evaluatePolicy, REQUIRED_QUESTION_IDS } from '../../src/index.ts'

export const HOSTS: readonly HostDecision[] = [
  { kind: 'allow' },
  { kind: 'ask', reason: 'host-ask' },
  { kind: 'deny', reason: 'host-deny' },
  { kind: 'cancel' },
]

export const ACTIONS: readonly DecisionAction[] = ['abstain', 'ask', 'deny', 'cancel']

export function boolOutcomes(overrides: Partial<Record<string, number>> = {}): QuestionOutcome[] {
  return Object.entries({
    [REQUIRED_QUESTION_IDS.advancesGoal]: 0.9,
    [REQUIRED_QUESTION_IDS.evidenceSufficient]: 0.9,
    [REQUIRED_QUESTION_IDS.conflictsWithConstraint]: 0.02,
    ...overrides,
  }).map(([id, pYes]) => ({
    id,
    status: 'answered' as const,
    answer: {
      kind: 'boolean' as const,
      pYes: pYes as number,
      probability: { origin: 'synthetic' as const, calibration: 'uncalibrated' as const, calibrationId: null },
    },
  }))
}

test('table 1: abstain always leaves the host decision alone', () => {
  for (const host of HOSTS) {
    assert.deepEqual(combineHostAndJey(host, 'abstain'), host)
  }
})

test('table 1: an existing host ask is preserved, not upgraded or duplicated', () => {
  const host: HostDecision = { kind: 'ask', reason: 'host-ask' }
  assert.deepEqual(combineHostAndJey(host, 'ask'), host)
})

test('table 1: host deny and host cancel rows are absorbing', () => {
  for (const host of [{ kind: 'deny', reason: 'x' }, { kind: 'cancel' }] as HostDecision[]) {
    for (const action of ACTIONS) {
      assert.equal(combineHostAndJey(host, action).kind, host.kind)
    }
  }
})

test('table 1: full grid matches the specification table', () => {
  const grid = HOSTS.map(h => ACTIONS.map(a => combineHostAndJey(h, a).kind))
  assert.deepEqual(grid, [
    ['allow', 'ask', 'deny', 'cancel'],
    ['ask', 'ask', 'deny', 'cancel'],
    ['deny', 'deny', 'deny', 'deny'],
    ['cancel', 'cancel', 'cancel', 'cancel'],
  ])
})

test('evaluatePolicy: off never produces a restriction', () => {
  const r = evaluatePolicy({ mode: 'off', host: { kind: 'allow' }, outcomes: boolOutcomes({ [REQUIRED_QUESTION_IDS.conflictsWithConstraint]: 1 }) })
  assert.equal(r.action, 'abstain')
  assert.equal(r.combined.kind, 'allow')
  assert.deepEqual(r.reasonCodes, ['mode-off'])
})

test('evaluatePolicy: a hard rule denies without consulting the model', () => {
  const r = evaluatePolicy({ mode: 'enforce', host: { kind: 'allow' }, hardRuleViolations: ['path-outside-workspace'], outcomes: [] })
  assert.equal(r.action, 'deny')
  assert.ok(r.reasonCodes.includes('hard-rule:path-outside-workspace'))
})

test('evaluatePolicy: user cancellation outranks everything else', () => {
  const r = evaluatePolicy({ mode: 'enforce', host: { kind: 'allow' }, userCancelled: true, hardRuleViolations: ['x'], outcomes: [] })
  assert.equal(r.action, 'cancel')
  assert.deepEqual(r.reasonCodes, ['user-cancelled'])
})

test('evaluatePolicy: shadow never changes what the host decided (§0.2-3)', () => {
  const conflict = { [REQUIRED_QUESTION_IDS.conflictsWithConstraint]: 1 }
  const offTrack = { [REQUIRED_QUESTION_IDS.advancesGoal]: 0, [REQUIRED_QUESTION_IDS.evidenceSufficient]: 0 }
  const inputs = [
    { outcomes: boolOutcomes() },
    { outcomes: boolOutcomes(conflict), calibrationAvailable: true },
    { outcomes: boolOutcomes(offTrack) },
    { outcomes: [], approvalChannel: true },
    { outcomes: boolOutcomes(), snapshotFresh: false },
    { outcomes: boolOutcomes(), hardRuleViolations: ['rule-a'] },
    { outcomes: boolOutcomes(), userCancelled: true },
  ] as const
  for (const host of HOSTS) {
    for (const extra of inputs) {
      const r = evaluatePolicy({ mode: 'shadow', host, ...extra })
      assert.deepEqual(r.combined, host, `shadow changed ${host.kind} under ${JSON.stringify(extra)}`)
      assert.equal(r.action, 'abstain')
      assert.ok(r.reasonCodes.includes('shadow-observe-only'))
    }
  }
})

test('evaluatePolicy: shadow still records what it would have done', () => {
  const r = evaluatePolicy({
    mode: 'shadow', host: { kind: 'allow' },
    outcomes: boolOutcomes({ [REQUIRED_QUESTION_IDS.conflictsWithConstraint]: 0.95 }),
    calibrationAvailable: true, approvalChannel: true,
  })
  assert.equal(r.action, 'abstain')
  assert.ok(r.reasonCodes.includes('probability:conflict'))
})

test('evaluatePolicy: off is inert even against a hard rule', () => {
  const r = evaluatePolicy({ mode: 'off', host: { kind: 'allow' }, hardRuleViolations: ['rule-a'], outcomes: [] })
  assert.equal(r.action, 'abstain')
  assert.deepEqual(r.reasonCodes, ['mode-off'])
})

test('evaluatePolicy: a missing required execution check is never a pass', () => {
  const r = evaluatePolicy({ mode: 'enforce', host: { kind: 'allow' }, outcomes: [], approvalChannel: true })
  assert.equal(r.action, 'ask')
  assert.equal(r.checkFailed, true)
  assert.ok(r.reasonCodes.includes('required-check-unavailable'))
})

test('evaluatePolicy: enforce with no approval channel denies on unavailable check', () => {
  const r = evaluatePolicy({ mode: 'enforce', host: { kind: 'allow' }, outcomes: [{ id: REQUIRED_QUESTION_IDS.advancesGoal, status: 'abstained', reason: 'unsupported' }], approvalChannel: false })
  assert.equal(r.action, 'deny')
})

test('evaluatePolicy: an uncalibrated conflict signal may escalate but may not deny', () => {
  const uncalibrated = evaluatePolicy({ mode: 'enforce', host: { kind: 'allow' }, outcomes: boolOutcomes({ [REQUIRED_QUESTION_IDS.conflictsWithConstraint]: 0.99 }), approvalChannel: true, calibrationAvailable: false })
  assert.equal(uncalibrated.action, 'ask')
  assert.ok(uncalibrated.reasonCodes.includes('conflict-signal-uncalibrated'))

  const calibrated = evaluatePolicy({ mode: 'enforce', host: { kind: 'allow' }, outcomes: boolOutcomes({ [REQUIRED_QUESTION_IDS.conflictsWithConstraint]: 0.99 }), approvalChannel: true, calibrationAvailable: true })
  assert.equal(calibrated.action, 'deny')
})

test('evaluatePolicy: a stale snapshot invalidates a protective check', () => {
  const r = evaluatePolicy({ mode: 'enforce', host: { kind: 'allow' }, outcomes: boolOutcomes(), snapshotFresh: false, approvalChannel: true })
  assert.equal(r.action, 'ask')
  assert.ok(r.reasonCodes.includes('stale-snapshot'))
})

test('evaluatePolicy: healthy observations add no restriction', () => {
  const r = evaluatePolicy({ mode: 'enforce', host: { kind: 'allow' }, outcomes: boolOutcomes(), approvalChannel: true })
  assert.equal(r.action, 'abstain')
  assert.equal(r.combined.kind, 'allow')
})
