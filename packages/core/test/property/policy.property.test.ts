import test from 'node:test'
import assert from 'node:assert/strict'
import * as fc from 'fast-check'
import type { DecisionAction, HostDecision, Mode, ProviderKind, QuestionOutcome } from 'jey-contracts'
import { combineHostAndJey, evaluatePolicy, RESTRICTION_RANK, REQUIRED_QUESTION_IDS, checkEgress, type EgressConfig } from '../../src/index.ts'

const arbProviderKind: fc.Arbitrary<ProviderKind> = fc.constantFrom('local', 'typesafe', 'mock')

const arbHost: fc.Arbitrary<HostDecision> = fc.oneof(
  fc.constant<HostDecision>({ kind: 'allow' }),
  fc.record({ kind: fc.constant('ask' as const), reason: fc.string({ minLength: 0, maxLength: 8 }) }),
  fc.record({ kind: fc.constant('deny' as const), reason: fc.string({ minLength: 1, maxLength: 8 }) }),
  fc.constant<HostDecision>({ kind: 'cancel' }),
)

const arbAction: fc.Arbitrary<DecisionAction> = fc.constantFrom('abstain', 'ask', 'deny', 'cancel')
const arbMode: fc.Arbitrary<Mode> = fc.constantFrom('off', 'shadow', 'enforce')
const arbProb = fc.double({ min: 0, max: 1, noNaN: true })

const arbOutcome = (id: string): fc.Arbitrary<QuestionOutcome> => fc.oneof(
  arbProb.map(pYes => ({
    id, status: 'answered' as const,
    answer: {
      kind: 'boolean' as const, pYes,
      probability: { origin: 'synthetic' as const, calibration: 'uncalibrated' as const, calibrationId: null },
    },
  })),
  fc.constant<QuestionOutcome>({ id, status: 'abstained', reason: 'uncertain' }),
  fc.constant<QuestionOutcome>({ id, status: 'error', code: 'OVERLOADED', retryable: false }),
)

const arbOutcomes: fc.Arbitrary<QuestionOutcome[]> = fc.tuple(
  arbOutcome(REQUIRED_QUESTION_IDS.advancesGoal),
  arbOutcome(REQUIRED_QUESTION_IDS.evidenceSufficient),
  arbOutcome(REQUIRED_QUESTION_IDS.conflictsWithConstraint),
).chain(t => fc.option(fc.constant(t), { nil: [] }))

test('property: Jey can never loosen the host decision', () => {
  fc.assert(fc.property(arbHost, arbAction, (host, action) => {
    const out = combineHostAndJey(host, action)
    return RESTRICTION_RANK[out.kind] >= RESTRICTION_RANK[host.kind]
  }), { numRuns: 500 })
})

test('property: an allow outcome requires an allow host', () => {
  fc.assert(fc.property(arbHost, arbAction, (host, action) => {
    return combineHostAndJey(host, action).kind !== 'allow' || (host.kind === 'allow' && action === 'abstain')
  }), { numRuns: 500 })
})

test('property: shadow mode never changes the decision that reaches the host', () => {
  fc.assert(fc.property(
    arbHost, arbOutcomes, fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(),
    fc.array(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 3 }),
    (host, outcomes, fresh, approval, cancelled, calibrated, rules) => {
      const r = evaluatePolicy({
        mode: 'shadow', host, outcomes, snapshotFresh: fresh, approvalChannel: approval,
        userCancelled: cancelled, calibrationAvailable: calibrated, hardRuleViolations: rules,
      })
      return r.combined.kind === host.kind && r.action === 'abstain'
    },
  ), { numRuns: 1000 })
})

test('property: under enforce a hard rule denies whatever the model said', () => {
  fc.assert(fc.property(arbHost, arbOutcomes, fc.boolean(), fc.boolean(), (host, outcomes, approval, calibrated) => {
    const r = evaluatePolicy({
      mode: 'enforce', host, outcomes, hardRuleViolations: ['rule-a'],
      approvalChannel: approval, calibrationAvailable: calibrated,
    })
    // deny and cancel rows of table 1 are absorbing; everywhere else the hard rule wins.
    return r.combined.kind === 'deny' || host.kind === 'deny' || host.kind === 'cancel'
  }), { numRuns: 500 })
})

test('property: off and shadow never restrict, whatever the inputs', () => {
  fc.assert(fc.property(arbMode, arbHost, arbOutcomes, fc.boolean(), (mode, host, outcomes, cancelled) => {
    if (mode === 'enforce') return true
    const r = evaluatePolicy({ mode, host, outcomes, hardRuleViolations: ['rule-a'], userCancelled: cancelled })
    return r.action === 'abstain' && r.combined.kind === host.kind
  }), { numRuns: 500 })
})

test('property: with no usable observations, enforce never abstains', () => {
  fc.assert(fc.property(arbHost, fc.boolean(), (host, approval) => {
    const r = evaluatePolicy({ mode: 'enforce', host, outcomes: [], approvalChannel: approval })
    return host.kind === 'deny' || host.kind === 'cancel' || (r.action === 'ask' && approval) || (r.action === 'deny' && !approval)
  }), { numRuns: 500 })
})

const arbEndpoint = fc.constantFrom('http://127.0.0.1:17861/v1/decide', 'https://api.typesafe.ai', 'http://localhost:9999/x')
const arbConfig: fc.Arbitrary<EgressConfig> = fc.record({
  mode: fc.constantFrom('deny' as const, 'local-only' as const, 'allowlist' as const),
  localOrigins: fc.constantFrom([], ['http://127.0.0.1:17861'], ['http://127.0.0.1:17861', 'http://127.0.0.2:1']),
  destinations: fc.constantFrom([], [{ id: 'jev-prod', endpoint: 'https://api.typesafe.ai', purposes: ['tool-assessment' as const], fields: ['task'] }]),
})

test('property: mode=deny is absolute for every provider and purpose', () => {
  fc.assert(fc.property(arbEndpoint, fc.string({ maxLength: 6 }), (endpoint, destinationId) => {
    const v = checkEgress({ mode: 'deny', localOrigins: [] }, {
      providerKind: 'typesafe', destinationId, endpoint, purpose: 'tool-assessment',
      fields: ['task'], credentialConfigured: true, providerExplicitlySelected: true,
    })
    return v.allowed === false && v.reasons.length > 0
  }), { numRuns: 200 })
})

test('property: anything allowed travelled through a configured origin or destination', () => {
  fc.assert(fc.property(arbConfig, arbEndpoint, arbProviderKind, (config, endpoint, providerKind) => {
    const verdict = checkEgress(config, {
      providerKind, destinationId: 'jev-prod', endpoint, purpose: 'tool-assessment',
      fields: ['task'], credentialConfigured: true, providerExplicitlySelected: true,
    })
    if (!verdict.allowed) return true
    if (providerKind === 'mock') return false
    const origin = new URL(endpoint).origin
    return providerKind === 'local'
      ? config.localOrigins.includes(origin)
      : (config.destinations ?? []).some(d => d.endpoint === endpoint)
  }), { numRuns: 500 })
})

test('property: an unconfigured allowlist allows nothing, whatever the mode', () => {
  const unconfigured: EgressConfig[] = [
    { mode: 'deny', localOrigins: [] },
    { mode: 'local-only', localOrigins: [] },
    { mode: 'allowlist', localOrigins: [], destinations: [] },
  ]
  fc.assert(fc.property(arbEndpoint, arbProviderKind, (endpoint, providerKind) => unconfigured
    .every(config => !checkEgress(config, {
      providerKind, destinationId: 'jev-prod', endpoint, purpose: 'tool-assessment',
      fields: ['task'], credentialConfigured: true, providerExplicitlySelected: true,
    }).allowed)), { numRuns: 200 })
})
