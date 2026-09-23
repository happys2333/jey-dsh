import test from 'node:test'
import assert from 'node:assert/strict'
import * as fc from 'fast-check'
import type { JsonValue } from 'jey-contracts'
import {
  DEFAULT_PROGRESS_CONFIG,
  EMPTY_PROGRESS,
  fitToBudget,
  observeCall,
  type CallObservation,
  type ProgressStore,
  type SectionKind,
  type StateSection,
} from '../../src/index.ts'

const arbJson: fc.Arbitrary<JsonValue> = fc.jsonValue() as fc.Arbitrary<JsonValue>
const arbKind: fc.Arbitrary<SectionKind> = fc.constantFrom('policy', 'current-call', 'recent-result', 'conversation')

const arbSections: fc.Arbitrary<StateSection[]> = fc.array(
  fc.record({ id: fc.stringMatching(/^[a-z]{1,6}$/), kind: arbKind, value: arbJson }),
  { minLength: 1, maxLength: 6 },
).chain(items => {
  const unique = new Map(items.map(s => [s.id, s]))
  return fc.constant([...unique.values()])
})

test('property: an accepted payload never exceeds the budget and stays parseable', () => {
  fc.assert(fc.property(arbSections, fc.integer({ min: 1, max: 900 }), (sections, budget) => {
    const r = fitToBudget(sections, budget)
    if (!r.ok) return true
    assert.ok(r.bytes <= budget)
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(r.state)))
    return true
  }), { numRuns: 400 })
})

test('property: rejection only ever happens with INSUFFICIENT_CONTEXT', () => {
  fc.assert(fc.property(arbSections, fc.integer({ min: 1, max: 40 }), (sections, budget) => {
    const r = fitToBudget(sections, budget)
    return r.ok || r.code === 'INSUFFICIENT_CONTEXT'
  }), { numRuns: 400 })
})

test('property: hard policy and this call are never dropped wholesale', () => {
  fc.assert(fc.property(arbSections, fc.integer({ min: 1, max: 900 }), (sections, budget) => {
    const r = fitToBudget(sections, budget)
    if (!r.ok) return true
    for (const s of sections) {
      if (s.kind !== 'policy' && s.kind !== 'current-call') continue
      if (!(s.id in r.state)) return false
    }
    return true
  }), { numRuns: 400 })
})

test('property: anything removed is reported', () => {
  fc.assert(fc.property(arbSections, fc.integer({ min: 1, max: 900 }), (sections, budget) => {
    const r = fitToBudget(sections, budget)
    if (!r.ok) return true
    const missing = sections.some(s => !(s.id in r.state))
    const shrank = sections.some(s => {
      const original = JSON.stringify(s.value).length
      const kept = s.id in r.state ? JSON.stringify(r.state[s.id]).length : 0
      return kept < original
    })
    return (!missing && !shrank) || r.omissions.length > 0
  }), { numRuns: 400 })
})

const arbObs = (sequence: number): fc.Arbitrary<CallObservation> => fc.record({
  toolName: fc.constantFrom('deploy', 'read_file'),
  normalizedArguments: fc.record({ target: fc.constantFrom('staging', 'prod') }) as fc.Arbitrary<JsonValue>,
  status: fc.constant('failure' as const),
  deterministicError: fc.constantFrom('EACCES', 'ETIMEOUT', null),
  resourceVersions: fc.record({ 'file:a': fc.constantFrom('v1', 'v2') }),
  rootCallId: fc.constant(null),
  isPoll: fc.boolean(),
  observationSequence: fc.constant(sequence),
})

function reduce(observations: readonly CallObservation[], config = DEFAULT_PROGRESS_CONFIG): { store: ProgressStore; kinds: string[] } {
  let store: ProgressStore = EMPTY_PROGRESS
  const kinds: string[] = []
  for (const o of observations) {
    const r = observeCall(store, o, config)
    store = r.store
    kinds.push(r.outcome.kind)
  }
  return { store, kinds }
}

test('property: a path cannot pause before the configured identical-failure limit', () => {
  const arbList = fc.array(arbObs(1), { minLength: 1, maxLength: 8 })
    .map(list => list.map((o, i) => ({ ...o, observationSequence: i + 1 })))
  fc.assert(fc.property(arbList, fc.integer({ min: 2, max: 6 }), (observations, limit) => {
    const { store } = reduce(observations, { ...DEFAULT_PROGRESS_CONFIG, maxIdenticalFailures: limit })
    return Object.values(store).every(state => !state.paused || state.count >= limit)
  }), { numRuns: 400 })
})

test('property: identical failures in a row reach the limit exactly once counting is monotonic', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 8 }), (n) => {
    const same = Array.from({ length: n }, (_, i) => ({
      toolName: 'deploy',
      normalizedArguments: { target: 'staging' } as JsonValue,
      status: 'failure' as const,
      deterministicError: 'EACCES',
      resourceVersions: {},
      rootCallId: null,
      isPoll: false,
      observationSequence: i + 1,
    }))
    const { store } = reduce(same, { maxIdenticalFailures: 3, pollBudget: 20 })
    const state = Object.values(store)[0]
    return state !== undefined && state.count <= 3 && state.count === Math.min(n, 3)
  }), { numRuns: 100 })
})

test('property: a success clears the path it belongs to', () => {
  fc.assert(fc.property(fc.array(arbObs(1), { minLength: 1, maxLength: 4 }), (list) => {
    // Pin every observation to one path so the assertion is about clearing, not keying.
    const first = list[0] as CallObservation
    const one = list.map((o, i) => ({
      ...o,
      toolName: first.toolName,
      normalizedArguments: first.normalizedArguments,
      observationSequence: i + 1,
    }))
    const cleared = reduce([...one, { ...one[one.length - 1] as CallObservation, status: 'success', observationSequence: one.length + 1 }])
    return Object.keys(cleared.store).length === 0
  }), { numRuns: 300 })
})
