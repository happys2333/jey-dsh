import type { DecisionAction, HostDecision, Mode, QuestionOutcome } from 'jey-contracts'

/**
 * The two tables of spec section 7.2, as pure functions. No clock, no I/O, no
 * network: everything that can quietly grant permission lives where a test can
 * read it.
 */

/** `allow < ask < deny`, and `cancel` is terminal. Mirrors the DSH `PreToolDecision` union. */
export type Restriction = 'allow' | 'ask' | 'deny' | 'cancel'

/** How far a decision withholds execution. `cancel` is terminal. */
export const RESTRICTION_RANK: Record<Restriction, number> = { allow: 0, ask: 1, deny: 2, cancel: 3 }

/**
 * Table 1: host original decision x Jey action -> decision that reaches the host.
 *
 * The load-bearing property is that no cell produces `allow` from a host decision
 * that was not already `allow`, and `deny`/`cancel` rows are absorbing. That is
 * "AI never widens permissions" (§0.2-1) as a function rather than a slogan.
 */
export function combineHostAndJey(host: HostDecision, action: DecisionAction): HostDecision {
  if (host.kind === 'cancel') return { kind: 'cancel' }
  if (host.kind === 'deny') return host

  switch (action) {
    case 'abstain':
      return host
    case 'cancel':
      return { kind: 'cancel' }
    case 'deny':
      return { kind: 'deny', reason: reasonOf(action, host) }
    case 'ask':
      // An existing ask is kept, never downgraded, and never silently upgraded twice.
      return host.kind === 'ask' ? host : { kind: 'ask', reason: reasonOf(action, host) }
  }
}

function reasonOf(action: DecisionAction, host: HostDecision): string {
  const why = action === 'deny' ? 'jey-denied' : 'jey-required-approval'
  return host.kind === 'ask' && host.reason !== undefined ? `${why}: ${host.reason}` : why
}

/** Question ids the assessment template always compiles. See `QuestionCompiler`. */
export const REQUIRED_QUESTION_IDS = {
  advancesGoal: 'advances-goal',
  evidenceSufficient: 'evidence-sufficient',
  conflictsWithConstraint: 'conflicts-with-constraint',
} as const

export interface PolicyThresholds {
  /** P(conflicts) at or above which the call is at least escalated. */
  readonly conflictAskAtOrAbove: number
  /** P(conflicts) at or above which a deny is allowed — honoured only when calibrated. */
  readonly conflictDenyAtOrAbove: number
  /** P(advances-goal) below which the call is escalated. */
  readonly goalBelow: number
  /** P(evidence-sufficient) below which the call is escalated. */
  readonly evidenceBelow: number
}

export interface PolicyInput {
  readonly mode: Mode
  readonly host: HostDecision
  /** Deterministic code rules. A conflict here never consults a model (§2.2). */
  readonly hardRuleViolations?: readonly string[]
  readonly userCancelled?: boolean
  /** False when the snapshot tuple moved between capture and apply (§10.1). */
  readonly snapshotFresh?: boolean
  readonly requiredQuestionIds?: readonly string[]
  readonly outcomes?: readonly QuestionOutcome[]
  /** Whether the host can actually surface an approval for this call (§7.2). */
  readonly approvalChannel?: boolean
  readonly thresholds?: PolicyThresholds
  /** Probability-driven denial is unavailable until a held-out calibration exists (§6.4). */
  readonly calibrationAvailable?: boolean
}

export interface PolicyResult {
  readonly action: DecisionAction
  readonly reasonCodes: readonly string[]
  readonly combined: HostDecision
  /** True when a provider call was expected but the answer was unusable. */
  readonly checkFailed: boolean
}

const DEFAULT_THRESHOLDS: PolicyThresholds = {
  conflictAskAtOrAbove: 0.5,
  conflictDenyAtOrAbove: 0.9,
  goalBelow: 0.2,
  evidenceBelow: 0.5,
}

function boolAnswer(outcomes: readonly QuestionOutcome[], id: string): number | null {
  const found = outcomes.find(o => o.id === id)
  if (found === undefined || found.status !== 'answered' || found.answer.kind !== 'boolean') return null
  return found.answer.pYes
}

function restrict(host: HostDecision, action: DecisionAction, reasonCodes: string[], checkFailed = false): PolicyResult {
  return { action, reasonCodes, combined: combineHostAndJey(host, action), checkFailed }
}

/**
 * Table 2: where a failure happened decides what happens next. Different failure
 * kinds deliberately get different treatments; a single catch-all would either
 * make the layer unsafe (fail open under enforce) or useless (fail closed in shadow).
 *
 * Mode handling lives in `evaluatePolicy`, not here: shadow must be inert by
 * construction rather than by every branch remembering to check.
 */
function decide(input: {
  readonly host: HostDecision
  readonly hardRuleViolations: readonly string[]
  readonly userCancelled: boolean
  readonly snapshotFresh: boolean
  readonly requiredQuestionIds: readonly string[]
  readonly outcomes: readonly QuestionOutcome[]
  readonly approvalChannel: boolean
  readonly thresholds: PolicyThresholds
  readonly calibrationAvailable: boolean
}): PolicyResult {
  const { host, hardRuleViolations, userCancelled, snapshotFresh, requiredQuestionIds,
    outcomes, approvalChannel, thresholds, calibrationAvailable } = input

  if (userCancelled) return restrict(host, 'cancel', ['user-cancelled'])
  if (hardRuleViolations.length > 0) {
    return restrict(host, 'deny', ['hard-rule-conflict', ...hardRuleViolations.map(v => `hard-rule:${v}`)])
  }

  const missing = requiredQuestionIds.filter(id => !outcomes.some(o => o.id === id && o.status === 'answered'))
  const unusable = [
    ...missing,
    ...outcomes.filter(o => o.status === 'error').map(o => o.id),
    ...outcomes.filter(o => o.status === 'abstained').map(o => o.id),
  ]

  // §4.3: a missing or failed required execution check is never treated as a pass.
  if (unusable.length > 0) {
    return restrict(host, approvalChannel ? 'ask' : 'deny',
      ['required-check-unavailable', ...unusable.map(id => `unusable:${id}`)], true)
  }
  if (!snapshotFresh) {
    return restrict(host, approvalChannel ? 'ask' : 'deny', ['stale-snapshot'], true)
  }

  const conflict = boolAnswer(outcomes, REQUIRED_QUESTION_IDS.conflictsWithConstraint)
  const goal = boolAnswer(outcomes, REQUIRED_QUESTION_IDS.advancesGoal)
  const evidence = boolAnswer(outcomes, REQUIRED_QUESTION_IDS.evidenceSufficient)

  if (conflict !== null && conflict >= thresholds.conflictDenyAtOrAbove && calibrationAvailable) {
    return restrict(host, 'deny', ['probability:conflict'])
  }
  // An uncalibrated score may escalate but may not deny on its own (§6.4, §14).
  if (conflict !== null && conflict >= thresholds.conflictAskAtOrAbove) {
    return restrict(host, 'ask', calibrationAvailable ? ['probability:conflict'] : ['conflict-signal-uncalibrated'])
  }
  if (goal !== null && goal < thresholds.goalBelow) return restrict(host, 'ask', ['probability:goal-off-track'])
  if (evidence !== null && evidence < thresholds.evidenceBelow) return restrict(host, 'ask', ['insufficient-evidence'])

  // Nothing to add. Note there is no `allow` action to return: the host keeps its own decision.
  return restrict(host, 'abstain', ['no-jey-restriction'])
}

/**
 * `off` never reaches a provider and never restricts; `shadow` computes the same
 * restriction, records it, and hands the host decision over untouched.
 */
export function evaluatePolicy(input: PolicyInput): PolicyResult {
  const {
    mode, host,
    hardRuleViolations = [],
    userCancelled = false,
    snapshotFresh = true,
    requiredQuestionIds = Object.values(REQUIRED_QUESTION_IDS),
    outcomes = [],
    approvalChannel = false,
    thresholds = DEFAULT_THRESHOLDS,
    calibrationAvailable = false,
  } = input

  if (mode === 'off') return { action: 'abstain', reasonCodes: ['mode-off'], combined: host, checkFailed: false }

  const raw = decide({
    host, hardRuleViolations, userCancelled, snapshotFresh,
    requiredQuestionIds, outcomes, approvalChannel, thresholds, calibrationAvailable,
  })

  if (mode === 'shadow') {
    return { action: 'abstain', reasonCodes: ['shadow-observe-only', ...raw.reasonCodes], combined: host, checkFailed: raw.checkFailed }
  }
  return raw
}
