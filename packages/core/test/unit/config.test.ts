import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ConfigError, SCHEMA_PATH, loadConfig, reloadDecision, schemaDefaults, type HostCapabilities, type JeyConfig } from '../../src/index.ts'

const HOST: HostCapabilities = { approvalChannel: false, scopedRestrict: true, postExecuteWaterfall: true }

function minimal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1',
    mode: 'off',
    provider: { kind: 'unconfigured' },
    egress: { mode: 'deny' },
    limits: {},
    features: {},
    audit: {},
    ...overrides,
  }
}

function codes(config: unknown, host = HOST): string[] {
  try {
    loadConfig(config, host)
    return []
  } catch (e) {
    assert.ok(e instanceof ConfigError, `expected ConfigError, got ${String(e)}`)
    return e.errors.map(x => x.code)
  }
}

function load(config: unknown, host = HOST): JeyConfig {
  return loadConfig(config, host)
}

test('off + unconfigured is a legal resting state', () => {
  const config = load(minimal())
  assert.equal(config.mode, 'off')
  assert.equal(config.provider.kind, 'unconfigured')
})

test('defaults come from the schema, not a second list in code', () => {
  const config = load(minimal()) as unknown as Record<string, Record<string, unknown>>
  assert.equal(config.limits?.deadlineMs, 1500)
  assert.equal(config.limits?.maxConcurrent, 2)
  assert.equal(config.features?.modelRouting, false)
  assert.equal(config.audit?.rawContent, false)
  assert.equal(config.audit?.retainedEvents, 2000)

  // Defaults that live inside optional sub-objects only materialise when that
  // object is present, so the required sections are checked here and the rest below.
  for (const [path, value] of Object.entries(schemaDefaults())) {
    if (!/^\/(limits|features|audit)\//.test(path)) continue
    const parts = path.split('/').filter(p => p !== '')
    let node: unknown = config
    for (const part of parts) node = (node as Record<string, unknown>)[part]
    assert.deepEqual(node, value, `${path} disagrees with the schema default`)
  }

  const withLocal = load(minimal({ mode: 'shadow', provider: localProvider, egress: { mode: 'local-only', allowedPurposes: ['tool-assessment'], allowedOrigins: ['http://127.0.0.1:17861'] } }))
  assert.equal(withLocal.provider.local?.ownership, 'external')
})

test('a host that merely starts with 127. is not loopback', () => {
  const sneaky = {
    ...localProvider,
    local: { ...localProvider.local, endpoint: 'http://127.evil.com/v1/decide' },
  }
  const codes = [] as string[]
  try {
    load(minimal({ mode: 'shadow', provider: sneaky, egress: { mode: 'local-only', allowedPurposes: ['tool-assessment'], allowedOrigins: ['http://127.0.0.1:17861'] } }))
  } catch (e) {
    assert.ok(e instanceof ConfigError)
    codes.push(...e.errors.map(x => `${x.code} ${x.path}`))
  }
  assert.deepEqual(codes, ['PATTERN /provider/local/endpoint'])
})

test('unknown fields are refused instead of silently ignored', () => {
  const errors: string[] = []
  try {
    loadConfig(minimal({ providerTpye: 'mock' }), HOST)
  } catch (e) {
    assert.ok(e instanceof ConfigError)
    errors.push(...e.errors.map(x => `${x.code} ${x.path}`))
  }
  assert.deepEqual(errors, ['UNKNOWN_FIELD /providerTpye'])
})

test('a misspelled nested field is reported with its path', () => {
  try {
    load(minimal({ limits: { deadlineMS: 500 } }))
    assert.fail('expected rejection')
  } catch (e) {
    assert.ok(e instanceof ConfigError)
    assert.ok(e.errors.some(x => x.code === 'UNKNOWN_FIELD' && x.path === '/limits/deadlineMS'), JSON.stringify(e.errors))
  }
})

test('a const switch without a default would read as undefined instead of off', () => {
  // A `const: false` with no `default` leaves the property absent when omitted, and
  // `undefined !== false` silently inverts the meaning of a safety switch.
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>
  const audit = (schema as { properties: { audit: { properties: Record<string, unknown> } } }).properties.audit
  const features = (schema as { properties: { features: { properties: Record<string, unknown> } } }).properties.features
  for (const [section, props] of [['audit', audit.properties], ['features', features.properties]] as const) {
    for (const [name, def] of Object.entries(props)) {
      const d = def as { const?: unknown; default?: unknown }
      if ('const' in d) {
        assert.ok('default' in d, `${section}.${name} is const without a default`)
        assert.deepEqual(d.default, d.const, `${section}.${name} default must equal its const`)
      }
    }
  }
  const loaded = load(minimal())
  assert.equal(loaded.audit.rawContent, false)
  assert.equal(loaded.features.modelRouting, false)
})

test('mode other than off needs a provider', () => {
  assert.deepEqual(codes(minimal({ mode: 'shadow' })), ['MODE_WITHOUT_PROVIDER'])
  assert.deepEqual(codes(minimal({ mode: 'enforce' })), ['MODE_WITHOUT_PROVIDER'])
})

test('enforce never runs on synthetic answers', () => {
  assert.deepEqual(codes(minimal({ mode: 'enforce', provider: { kind: 'mock' } })), ['ENFORCE_WITH_MOCK'])
  assert.deepEqual(codes(minimal({ mode: 'shadow', provider: { kind: 'mock' } })), [])
})

const localProvider = {
  kind: 'local',
  local: {
    endpoint: 'http://127.0.0.1:17861/v1/decide',
    tokenRef: 'env:JEY_LOCAL_TOKEN',
    ownership: 'external',
    expectedModel: { requested: 'Qwen_Qwen3.5-4B-Q4_K_M', revision: '4168f45a' },
  },
}

const cloudProvider = {
  kind: 'typesafe',
  typesafe: { credentialRef: 'env:TYPESAFE_API_KEY', model: 'jev-1', endpointOrigin: 'https://api.typesafe.ai' },
}

test('a local provider with egress denied cannot be reached', () => {
  assert.deepEqual(codes(minimal({ mode: 'shadow', provider: localProvider, egress: { mode: 'deny' } })),
    ['LOCAL_WITH_EGRESS_DENY'])
})

test('a cloud provider needs an allowlist, not just a credential', () => {
  assert.deepEqual(codes(minimal({ mode: 'shadow', provider: cloudProvider, egress: { mode: 'deny' } })),
    ['CLOUD_WITHOUT_ALLOWLIST'])
  // Two independent problems are reported together rather than one at a time.
  assert.deepEqual(codes(minimal({ mode: 'shadow', provider: cloudProvider, egress: { mode: 'local-only', allowedPurposes: ['tool-assessment'] } })),
    ['CLOUD_WITHOUT_ALLOWLIST', 'LOCAL_ONLY_NEEDS_ORIGIN'])
})

test('a non-loopback local endpoint is refused by the schema itself', () => {
  const bad = { ...localProvider, local: { ...localProvider.local, endpoint: 'http://localhost:17861/v1/decide' } }
  try {
    load(minimal({ mode: 'shadow', provider: bad, egress: { mode: 'local-only', allowedPurposes: ['tool-assessment'], allowedOrigins: ['http://localhost:17861'] } }))
    assert.fail('expected rejection')
  } catch (e) {
    assert.ok(e instanceof ConfigError)
    assert.ok(e.errors.some(x => x.code === 'PATTERN'), JSON.stringify(e.errors))
  }
})

test('local-only still rejects a cloud origin in the allowlist', () => {
  assert.deepEqual(codes(minimal({
    mode: 'shadow', provider: localProvider,
    egress: { mode: 'local-only', allowedPurposes: ['tool-assessment'], allowedOrigins: ['https://api.typesafe.ai'] },
  })), ['LOCAL_ONLY_REJECTS_CLOUD_ORIGIN'])
})

test('local-only with no origin is unusable, an empty purpose list is a silent dead end', () => {
  assert.deepEqual(codes(minimal({ mode: 'shadow', provider: localProvider, egress: { mode: 'local-only', allowedPurposes: ['tool-assessment'] } })),
    ['LOCAL_ONLY_NEEDS_ORIGIN'])
  assert.deepEqual(codes(minimal({ mode: 'shadow', provider: localProvider, egress: { mode: 'local-only', allowedOrigins: ['http://127.0.0.1:17861'] } })),
    ['EMPTY_PURPOSE_ALLOWLIST'])
})

test('a wildcard origin cannot be expressed at all', () => {
  const codes = [] as string[]
  try {
    load(minimal({ mode: 'shadow', provider: localProvider, egress: { mode: 'local-only', allowedPurposes: ['tool-assessment'], allowedOrigins: ['http://127.0.0.1:*'] } }))
  } catch (e) {
    assert.ok(e instanceof ConfigError)
    codes.push(...e.errors.map(x => x.code))
  }
  assert.deepEqual(codes, ['PATTERN'])
})

test('approval requests need a host channel that was actually detected', () => {
  const wantsApproval = minimal({ mode: 'enforce', provider: { kind: 'mock' }, features: { approvalRequests: true } })
  assert.ok(codes(wantsApproval).includes('ENFORCE_WITH_MOCK'))
  const cloud = minimal({ mode: 'shadow', provider: cloudProvider, egress: { mode: 'allowlist', allowedPurposes: ['tool-assessment'], allowedOrigins: ['https://api.typesafe.ai'] }, features: { approvalRequests: true } })
  assert.deepEqual(codes(cloud, HOST), ['APPROVAL_WITHOUT_HOST_CHANNEL'])
  assert.deepEqual(codes(cloud, { ...HOST, approvalChannel: true }), [])
})

test('v1 refuses a config that claims automatic model routing', () => {
  const r = [] as string[]
  try {
    load(minimal({ features: { modelRouting: true } }))
  } catch (e) {
    assert.ok(e instanceof ConfigError)
    r.push(...e.errors.map(x => x.code))
  }
  assert.deepEqual(r, ['CONST'])
})

test('a calibration that cannot state what it applies to is not honoured', () => {
  const bare = minimal({ mode: 'shadow', provider: { kind: 'mock' }, calibration: { id: 'cal-1' } })
  assert.ok(codes(bare).includes('CALIBRATION_APPLICABILITY_MISSING'))

  const inverted = minimal({
    mode: 'shadow', provider: { kind: 'mock' },
    calibration: {
      id: 'cal-1',
      appliesTo: { model: { requested: 'm', revision: 'r' }, templateDigest: 'sha256:t', task: 'tool-assessment' },
      conflictDenyAtOrAbove: 0.4,
      conflictAskAtOrAbove: 0.6,
      goalBelow: 0.2,
      evidenceBelow: 0.5,
    },
  })
  assert.deepEqual(codes(inverted), ['CALIBRATION_THRESHOLD_ORDER'])
})

test('fail-closed auditing while off describes nothing that can run', () => {
  assert.deepEqual(codes(minimal({ audit: { onFailure: 'fail-closed-before-dispatch' } })), ['FAIL_CLOSED_WHILE_OFF'])
})

test('a bad enum and an out-of-range limit are both structural rejections', () => {
  assert.ok(codes(minimal({ mode: 'yolo' })).includes('ENUM'))
  assert.ok(codes(minimal({ limits: { deadlineMs: 999_999 } })).includes('MAXIMUM'))
  assert.ok(codes(minimal({ provider: { kind: 'unconfigured', local: localProvider.local } })).length > 0)
})

test('every reported issue uses a JSON pointer path', () => {
  try {
    load(minimal({ mode: 'yolo', limits: { deadlineMs: -1 } }))
    assert.fail('expected rejection')
  } catch (e) {
    assert.ok(e instanceof ConfigError)
    assert.ok(e.errors.length >= 2)
    for (const issue of e.errors) assert.match(issue.path, /^\//)
  }
})

test('an identical reload keeps the generation, any policy change advances it', () => {
  const first = load(minimal())
  const same = reloadDecision(first, load(minimal()), 4)
  assert.equal(same.changed, false)
  assert.equal(same.generation, 4)

  const changed = reloadDecision(first, load(minimal({ mode: 'shadow', provider: { kind: 'mock' } })), 4)
  assert.equal(changed.changed, true)
  assert.equal(changed.generation, 5)
  assert.notEqual(changed.policyVersion, same.policyVersion)
  assert.match(changed.policyVersion, /^sha256:[0-9a-f]{64}$/)
})
