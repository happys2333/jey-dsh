import test from 'node:test'
import assert from 'node:assert/strict'
import { fitToBudget, type StateSection } from '../../src/index.ts'

const CJK = '不要在生产环境执行任何写操作，先看配置再动手'

function sections(overrides: Partial<Record<StateSection['id'], StateSection>> = {}): StateSection[] {
  const base: StateSection[] = [
    { id: 'policy', kind: 'policy', value: { constraints: [CJK] } },
    { id: 'call', kind: 'current-call', value: { tool: 'write_file', args: { path: 'a.txt' } } },
    { id: 'results', kind: 'recent-result', value: [{ tool: 'read_file', status: 'ok' }] },
    { id: 'chat', kind: 'conversation', value: [{ role: 'old' }, { role: 'mid' }, { role: 'new' }] },
  ]
  const merged = new Map(base.map(s => [s.id, s]))
  for (const [id, s] of Object.entries(overrides)) merged.set(id, s as StateSection)
  return [...merged.values()]
}

test('a payload that already fits comes back untouched', () => {
  const r = fitToBudget(sections(), 100_000)
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.deepEqual(r.omissions, [])
    assert.deepEqual(Object.keys(r.state).sort(), ['call', 'chat', 'policy', 'results'])
  }
})

test('conversation is dropped oldest-first, then the whole section', () => {
  const r = fitToBudget(sections(), 190)
  assert.equal(r.ok, true)
  if (r.ok) {
    const dropped = r.omissions.map(o => o.path)
    assert.ok(dropped.includes('chat[0]'), `expected chat[0] in ${dropped.join(',')}`)
    assert.deepEqual((r.state.chat as unknown[]).at(-1), { role: 'new' })
  }
})

test('dropping the whole section is recorded with how much it saved', () => {
  const r = fitToBudget(sections(), 150)
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal('chat' in r.state, false)
    const whole = r.omissions.find(o => o.path === 'chat')
    assert.ok(whole !== undefined && whole.originalBytes > 0 && whole.keptBytes === 0)
  }
})

test('a truncated payload is always still parseable JSON', () => {
  for (let budget = 40; budget < 400; budget += 7) {
    const r = fitToBudget(sections(), budget)
    if (r.ok) assert.doesNotThrow(() => JSON.parse(JSON.stringify(r.state)), `budget ${budget}`)
  }
})

test('protected leaves are shortened instead of failing, and say so', () => {
  const r = fitToBudget([{ id: 'policy', kind: 'policy', value: { constraints: [CJK.repeat(6)] } }], 120)
  assert.equal(r.ok, true)
  if (r.ok) {
    const omission = r.omissions.find(o => o.path.startsWith('policy'))
    assert.ok(omission !== undefined, 'the shortening must be reported, not silent')
    assert.ok(omission.originalBytes > omission.keptBytes)
    const text = (r.state.policy as { constraints: string[] }).constraints[0] as string
    assert.ok(text.endsWith('…'))
    assert.equal(Buffer.compare(Buffer.from(text, 'utf8'), Buffer.from(CJK.repeat(6), 'utf8')), -1)
  }
})

test('no codepoint is split at the cut', () => {
  const r = fitToBudget([{ id: 'policy', kind: 'policy', value: { note: '🥲'.repeat(40) } }], 60)
  assert.equal(r.ok, true)
  if (r.ok) {
    const text = (r.state.policy as { note: string }).note
    assert.equal(text.includes('\uFFFD'), false, 'replacement char means a split codepoint')
  }
})

test('policy plus current call that cannot fit reports INSUFFICIENT_CONTEXT', () => {
  const r = fitToBudget(sections(), 30)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.code, 'INSUFFICIENT_CONTEXT')
    assert.ok(r.neededBytes > 30)
  }
})

test('never returns a payload larger than the budget', () => {
  for (let budget = 60; budget < 500; budget += 11) {
    const r = fitToBudget(sections(), budget)
    if (r.ok) assert.ok(r.bytes <= budget, `budget ${budget} produced ${r.bytes}`)
  }
})
