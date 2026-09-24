import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// Named import on purpose: ajv is CJS with no `exports` map, so under NodeNext the
// `default` binding arrives as the module namespace object and is not constructable.
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { ErrorObject } from 'ajv'
import type { Mode, Purpose } from 'jey-contracts'

/**
 * Config loading. Two separate jobs, deliberately not merged:
 *
 * 1. `config/config.schema.json` owns structure, ranges and provider-shape rules.
 * 2. This file owns contradictions that are well-formed but unusable — a schema
 *    cannot say "enforce + mock is nonsense".
 *
 * Both run before anything is activated. Capability that a host does not have is
 * reported rather than assumed, and defaults are taken from the schema itself so
 * the document and the code cannot drift apart.
 */

export const SCHEMA_PATH = fileURLToPath(new URL('../../../config/config.schema.json', import.meta.url))

export type ProviderKindConfig = 'unconfigured' | 'mock' | 'local' | 'typesafe'

export interface ModelIdentity {
  readonly requested: string
  readonly revision: string
  readonly weightsDigest?: string
  readonly tokenizerRevision?: string
  readonly quantization?: string
}

export interface JeyConfig {
  readonly schemaVersion: '1'
  readonly mode: Mode
  readonly provider: {
    readonly kind: ProviderKindConfig
    readonly local?: {
      readonly endpoint: string
      readonly tokenRef: string
      readonly ownership: 'external' | 'managed'
      readonly expectedModel: ModelIdentity
    }
    readonly typesafe?: {
      readonly credentialRef: string
      readonly model: string
      readonly endpointOrigin: string
    }
  }
  readonly egress: {
    readonly mode: 'deny' | 'local-only' | 'allowlist'
    readonly allowedPurposes?: readonly Purpose[]
    readonly allowedOrigins?: readonly string[]
  }
  readonly calibration?: {
    readonly id: string
    readonly appliesTo: { readonly model: ModelIdentity; readonly templateDigest: string; readonly task: 'tool-assessment' | 'tool-relevance' }
    readonly conflictDenyAtOrAbove: number
    readonly conflictAskAtOrAbove: number
    readonly goalBelow: number
    readonly evidenceBelow: number
  }
  readonly limits: {
    readonly deadlineMs: number
    readonly maxConcurrent: number
    readonly maxQueue: number
    readonly maxStateBytes: number
    readonly maxQuestions: number
    readonly perTurnCalls: number
    readonly perSessionCalls: number
    readonly maxIdenticalFailures: number
    readonly pollBudget: number
  }
  readonly features: {
    readonly toolAssessment: boolean
    readonly toolRelevance: boolean
    readonly presentationFilter: boolean
    readonly approvalRequests: boolean
    readonly modelRouting: false
  }
  readonly audit: {
    readonly rawContent: false
    readonly onFailure: 'keep-execution' | 'fail-closed-before-dispatch'
    readonly retainedEvents: number
    readonly maxFileBytes: number
  }
}

/** What the host actually gave us. Detected at load, never inferred from config. */
export interface HostCapabilities {
  readonly approvalChannel: boolean
  readonly scopedRestrict: boolean
  readonly postExecuteWaterfall: boolean
}

export interface ConfigIssue {
  readonly code: string
  readonly path: string
  readonly message: string
}

export type ConfigResult =
  | { readonly ok: true; readonly config: JeyConfig }
  | { readonly ok: false; readonly errors: readonly ConfigIssue[] }

export class ConfigError extends Error {
  readonly errors: readonly ConfigIssue[]
  constructor(errors: readonly ConfigIssue[]) {
    super(`invalid Jey configuration: ${errors.map(e => `${e.code}@${e.path}`).join(', ')}`)
    this.name = 'ConfigError'
    this.errors = errors
  }
}

function pointer(path: string): string {
  return path.replace(/^\./, '').replace(/\./g, '/').replace(/\/(\d+)/g, '/$1')
}

function validateStructure(data: Record<string, unknown>): ConfigIssue[] {
  // strictRequired is off because the conditional branches below declare
  // `required: ["local"]` alongside a `properties` block they do not repeat.
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, useDefaults: true })
  const validate = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as object)
  if (validate(data)) return []
  return (validate.errors ?? []).map((e: ErrorObject) => {
    const extra = typeof e.params?.additionalProperty === 'string' ? `/${e.params.additionalProperty}` : ''
    return {
      code: e.keyword === 'additionalProperties' ? 'UNKNOWN_FIELD' : (e.keyword ?? 'INVALID').toUpperCase(),
      path: pointer(`${e.instancePath ?? ''}${extra}`),
      message: e.message ?? 'invalid',
    }
  })
}

/**
 * Every default the schema declares, as `path -> value`. Tests compare this against
 * the documented defaults so the schema stays the single source of both.
 */
export function schemaDefaults(): Record<string, unknown> {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>
  const found: Record<string, unknown> = {}
  const walk = (node: unknown, prefix: string): void => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return
    const properties = (node as Record<string, unknown>).properties
    if (properties !== undefined && typeof properties === 'object') {
      for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
        const path = `${prefix}/${key}`
        if (child !== null && typeof child === 'object' && 'default' in child) {
          found[path] = (child as { default: unknown }).default
        }
        walk(child, path)
      }
    }
    for (const key of ['items', 'additionalProperties']) {
      const child = (node as Record<string, unknown>)[key]
      if (child !== null && typeof child === 'object' && !Array.isArray(child)) walk(child, `${prefix}[]`)
    }
    for (const branch of ((node as Record<string, unknown>).allOf as unknown[] | undefined) ?? []) walk(branch, prefix)
  }
  walk(schema, '')
  return found
}

function isLoopbackLiteral(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.replace(/^\[|\]$/g, '')
    return host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
  } catch {
    return false
  }
}

/**
 * Well-formed but unusable combinations. Each of these used to be able to install
 * "successfully" and then silently do nothing, or do something its operator never
 * asked for.
 */
function contradictions(config: JeyConfig, host: HostCapabilities): ConfigIssue[] {
  const errors: ConfigIssue[] = []
  const push = (code: string, path: string, message: string): void => { errors.push({ code, path, message }) }

  if (config.mode !== 'off' && config.provider.kind === 'unconfigured') {
    push('MODE_WITHOUT_PROVIDER', '/provider/kind', `mode=${config.mode} requires a configured provider`)
  }
  if (config.mode === 'enforce' && config.provider.kind === 'mock') {
    push('ENFORCE_WITH_MOCK', '/provider/kind', 'mock answers are synthetic and must not gate execution')
  }
  if (config.provider.kind === 'typesafe' && config.egress.mode !== 'allowlist') {
    push('CLOUD_WITHOUT_ALLOWLIST', '/egress/mode', 'a cloud provider requires egress.mode=allowlist')
  }
  if (config.provider.kind === 'local' && config.egress.mode === 'deny') {
    push('LOCAL_WITH_EGRESS_DENY', '/egress/mode', 'local provider cannot be reached while every connection is denied')
  }
  // The schema already pins /provider/local/endpoint to a loopback literal, so this
  // only has to police the origin list, whose pattern admits any https host.
  if (config.egress.mode === 'local-only') {
    for (const origin of config.egress.allowedOrigins ?? []) {
      if (!isLoopbackLiteral(origin)) push('LOCAL_ONLY_REJECTS_CLOUD_ORIGIN', '/egress/allowedOrigins', `${origin} is not loopback`)
    }
    if ((config.egress.allowedOrigins?.length ?? 0) === 0) {
      push('LOCAL_ONLY_NEEDS_ORIGIN', '/egress/allowedOrigins', 'local-only with no allowlisted origin can never reach a service')
    }
  }
  if (config.egress.mode !== 'deny' && (config.egress.allowedPurposes?.length ?? 0) === 0) {
    push('EMPTY_PURPOSE_ALLOWLIST', '/egress/allowedPurposes', 'no purpose means no request may leave; set egress.mode=deny instead of an empty list')
  }
  if (config.features.approvalRequests && !host.approvalChannel) {
    push('APPROVAL_WITHOUT_HOST_CHANNEL', '/features/approvalRequests',
      'the host did not expose an approval channel; an ask would be degraded to a denial')
  }
  if (config.features.presentationFilter && !host.scopedRestrict) {
    push('FILTER_WITHOUT_HOST_RESTRICT', '/features/presentationFilter', 'host restriction is unavailable in this scope')
  }
  if (config.calibration !== undefined) {
    const missing = config.calibration.appliesTo === undefined
    if (missing || config.calibration.id === undefined) {
      push('CALIBRATION_APPLICABILITY_MISSING', '/calibration', 'a calibration without id + model/template/task applicability cannot be honoured')
    }
    if (!missing && config.calibration.conflictDenyAtOrAbove <= config.calibration.conflictAskAtOrAbove) {
      push('CALIBRATION_THRESHOLD_ORDER', '/calibration/conflictDenyAtOrAbove', 'deny threshold must sit above the ask threshold')
    }
  }
  if (config.audit.onFailure === 'fail-closed-before-dispatch' && config.mode === 'off') {
    push('FAIL_CLOSED_WHILE_OFF', '/audit/onFailure', 'nothing runs to fail closed on while mode=off')
  }
  return errors
}

/**
 * Parse and activate a configuration. Throws `ConfigError` listing every problem at
 * once, because a half-read config is worse than a refused one.
 */
export function loadConfig(raw: unknown, host: HostCapabilities): JeyConfig {
  const candidate = structuredClone(raw) as Record<string, unknown>
  const issues = validateStructure(candidate)
  if (issues.length > 0) throw new ConfigError(issues)

  const config = candidate as unknown as JeyConfig
  const errors = contradictions(config, host)
  if (errors.length > 0) throw new ConfigError(errors)
  return config
}

/**
 * A reload is not a free swap: the generation must advance so every in-flight
 * observation tied to the previous config becomes invalid, and approvals do not
 * migrate across it.
 */
export function reloadDecision(previous: JeyConfig | null, next: JeyConfig, generation: number): {
  readonly changed: boolean
  readonly generation: number
  readonly policyVersion: string
} {
  const policyVersion = `sha256:${createHash('sha256').update(JSON.stringify({
    mode: next.mode,
    provider: next.provider,
    egress: next.egress,
    limits: next.limits,
    features: next.features,
    calibration: next.calibration ?? null,
  }), 'utf8').digest('hex')}`
  const changed = previous === null || JSON.stringify(previous) !== JSON.stringify(next)
  return { changed, generation: changed ? generation + 1 : generation, policyVersion }
}
