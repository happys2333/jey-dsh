import type { Answer, DecisionRequest, DecisionResponse, ErrorCode, JsonValue, ProviderKind, Purpose, Question, QuestionOutcome, SnapshotRef } from 'jey-contracts'

/**
 * Boundary validation. Spec section 6.1 forbids `response.json() as Answer`, so
 * every value crossing a process boundary — a provider payload, an MCP tool
 * argument, a config file — has to pass through here first.
 */

export class ValidationError extends Error {
  readonly code: ErrorCode
  readonly paths: readonly string[]

  constructor(code: ErrorCode, paths: readonly string[], message: string) {
    super(message)
    this.name = 'ValidationError'
    this.code = code
    this.paths = paths
  }
}

type Check = (value: unknown, path: string, out: string[]) => boolean

/**
 * Checks report themselves: a failing predicate records the path it was called
 * with, so a caller can collect every problem in one pass instead of the first.
 */
const check = (pred: (value: unknown) => boolean): Check =>
  (value, path, out) => {
    const ok = pred(value)
    if (!ok) out.push(path)
    return ok
  }

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = check(v => typeof v === 'string')
const num = check(v => typeof v === 'number' && Number.isFinite(v))
const int = check(v => typeof v === 'number' && Number.isInteger(v) && v >= 0)
const bool = check(v => typeof v === 'boolean')
const nonEmptyStr = check(v => typeof v === 'string' && v.length > 0)

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'

const PURPOSES: readonly Purpose[] = ['tool-assessment', 'tool-relevance', 'evidence-check', 'explicit-query']
const KINDS: readonly ProviderKind[] = ['mock', 'local', 'typesafe']

function fail(code: ErrorCode, paths: readonly string[], what: string): never {
  throw new ValidationError(code, paths, `invalid ${what}: ${paths.join(', ') || 'unknown'}`)
}

function parseSnapshotRef(value: unknown, path: string): SnapshotRef {
  const out: string[] = []
  if (!isObj(value)) fail('INVALID_INPUT', [path], 'snapshot')
  for (const [k, c] of [['sessionId', str], ['agentId', str], ['turn', int], ['step', int],
    ['generation', int], ['taskVersion', int], ['policyVersion', str], ['catalogDigest', nonEmptyStr],
    ['observationSequence', int]] as const) {
    c((value as Record<string, unknown>)[k], `${path}.${k}`, out)
  }
  const cd = (value as Record<string, unknown>).callDigest
  if (cd !== null && typeof cd !== 'string') out.push(`${path}.callDigest`)
  if (out.length > 0) fail('INVALID_INPUT', out, 'snapshot')
  return value as unknown as SnapshotRef
}

function parseQuestion(value: unknown, path: string): Question {
  const out: string[] = []
  if (!isObj(value)) fail('INVALID_INPUT', [path], 'question')
  const q = value as Record<string, unknown>
  str(q.id, `${path}.id`, out)
  str(q.instructions, `${path}.instructions`, out)
  if (q.kind === 'boolean') {
    /* covered above */
  } else if (q.kind === 'choice') {
    if (!Array.isArray(q.options) || q.options.length < 2) out.push(`${path}.options`)
    else q.options.forEach((o, i) => {
      if (!isObj(o) || typeof o.id !== 'string' || typeof o.description !== 'string') out.push(`${path}.options[${i}]`)
    })
  } else if (q.kind === 'score') {
    if (!Array.isArray(q.levels) || q.levels.length < 2 || !q.levels.every(l => typeof l === 'string')) {
      out.push(`${path}.levels`)
    }
  } else {
    out.push(`${path}.kind`)
  }
  if (out.length > 0) fail('INVALID_INPUT', out, 'question')
  return q as unknown as Question
}

export function parseDecisionRequest(value: unknown): DecisionRequest {
  const out: string[] = []
  if (!isObj(value)) fail('INVALID_INPUT', ['$'], 'request')
  const r = value as Record<string, unknown>
  if (r.schemaVersion !== '1') out.push('schemaVersion')
  nonEmptyStr(r.requestId, 'requestId', out)
  if (!PURPOSES.includes(r.purpose as Purpose)) out.push('purpose')
  if (!Array.isArray(r.questions) || r.questions.length === 0) out.push('questions')
  if (!isObj(r.budget)) out.push('budget')
  else {
    num((r.budget as Record<string, unknown>).maxElapsedMs, 'budget.maxElapsedMs', out)
    num((r.budget as Record<string, unknown>).maxInputBytes, 'budget.maxInputBytes', out)
  }
  const snapshotPaths: string[] = []
  let snapshot: SnapshotRef | undefined
  try {
    snapshot = parseSnapshotRef(r.snapshot, 'snapshot')
  } catch (e) {
    if (e instanceof ValidationError) snapshotPaths.push(...e.paths)
    else throw e
  }
  if (snapshotPaths.length > 0) out.push(...snapshotPaths)
  if (out.length > 0) fail('INVALID_INPUT', out, 'request')

  const questions = (r.questions as unknown[]).map((q, i) => parseQuestion(q, `questions[${i}]`))
  const ids = new Set<string>(questions.map(q => q.id))
  if (ids.size !== questions.length) fail('INVALID_INPUT', ['questions'], 'duplicate question id')
  if (!isJsonValue(r.state)) fail('INVALID_INPUT', ['state'], 'request state')

  const budget = r.budget as { maxElapsedMs: number; maxInputBytes: number }
  if (budget.maxElapsedMs <= 0 || budget.maxInputBytes <= 0) {
    fail('INVALID_INPUT', ['budget'], 'non-positive budget')
  }
  return {
    schemaVersion: '1',
    requestId: r.requestId as string,
    purpose: r.purpose as Purpose,
    snapshot: snapshot as SnapshotRef,
    state: r.state as JsonValue,
    questions,
    budget,
  }
}

function isJsonValue(v: unknown): v is JsonValue {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return true
  if (typeof v === 'number') return Number.isFinite(v)
  if (Array.isArray(v)) return v.every(isJsonValue)
  if (isObj(v)) return Object.values(v).every(isJsonValue)
  return false
}

const ERROR_CODES: readonly ErrorCode[] = ['INVALID_INPUT', 'UNSUPPORTED_CAPABILITY', 'AUTH', 'RATE_LIMIT',
  'OVERLOADED', 'TIMEOUT', 'CANCELLED', 'QUEUE_FULL', 'BUDGET_EXCEEDED', 'INVALID_RESPONSE',
  'INSUFFICIENT_CONTEXT', 'STALE_SNAPSHOT', 'LOCAL_NOT_READY', 'EGRESS_DENIED']

/** Lets a coordinator carry a provider's own classification instead of flattening it. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value)
}

function parseAnswer(value: unknown, path: string): Answer {
  const out: string[] = []
  if (!isObj(value)) fail('INVALID_RESPONSE', [path], 'answer')
  const a = value as Record<string, unknown>
  const prob = a.probability
  if (!isObj(prob)) out.push(`${path}.probability`)
  else {
    if (!['native-logits', 'provider-distribution', 'synthetic'].includes(prob.origin as string)) out.push(`${path}.probability.origin`)
    if (!['uncalibrated', 'provider-reported', 'held-out'].includes(prob.calibration as string)) out.push(`${path}.probability.calibration`)
    if (prob.calibrationId !== null && typeof prob.calibrationId !== 'string') out.push(`${path}.probability.calibrationId`)
  }
  const probOk = (p: unknown): p is Record<string, number> =>
    isObj(p) && Object.values(p).every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)

  if (a.kind === 'boolean') {
    if (!isNum(a.pYes) || a.pYes < 0 || a.pYes > 1) out.push(`${path}.pYes`)
  } else if (a.kind === 'choice') {
    if (!probOk(a.probabilities)) out.push(`${path}.probabilities`)
    else if (typeof a.selected !== 'string' || !(a.selected in (a.probabilities as Record<string, number>))) {
      out.push(`${path}.selected`)
    }
    if ('calibratedProbabilities' in a && !probOk(a.calibratedProbabilities)) out.push(`${path}.calibratedProbabilities`)
  } else if (a.kind === 'score') {
    if (!isInt(a.expectedIndex)) out.push(`${path}.expectedIndex`)
    if (!Array.isArray(a.levels) || !a.levels.every(l => typeof l === 'string')) out.push(`${path}.levels`)
    if (!probOk(a.probabilities)) out.push(`${path}.probabilities`)
    else if (typeof a.expectedIndex === 'number' && a.expectedIndex >= Object.keys(a.probabilities).length) {
      out.push(`${path}.expectedIndex`)
    }
  } else {
    out.push(`${path}.kind`)
  }
  if (out.length > 0) fail('INVALID_RESPONSE', out, 'answer')
  return a as unknown as Answer
}

function parseOutcome(value: unknown, path: string): QuestionOutcome {
  const out: string[] = []
  if (!isObj(value)) fail('INVALID_RESPONSE', [path], 'outcome')
  const o = value as Record<string, unknown>
  str(o.id, `${path}.id`, out)
  if (o.status === 'answered') {
    if (out.length > 0) fail('INVALID_RESPONSE', out, 'outcome')
    return { id: o.id as string, status: 'answered', answer: parseAnswer(o.answer, `${path}.answer`) }
  }
  if (o.status === 'abstained') {
    if (!['insufficient-evidence', 'unsupported', 'uncertain'].includes(o.reason as string)) out.push(`${path}.reason`)
  } else if (o.status === 'error') {
    if (!ERROR_CODES.includes(o.code as ErrorCode)) out.push(`${path}.code`)
    if (!isBool(o.retryable)) out.push(`${path}.retryable`)
  } else {
    out.push(`${path}.status`)
  }
  if (out.length > 0) fail('INVALID_RESPONSE', out, 'outcome')
  return o as unknown as QuestionOutcome
}

/** A provider's claim about what it observed. Nothing here is a policy decision. */
export function parseDecisionResponse(value: unknown): DecisionResponse {
  const out: string[] = []
  if (!isObj(value)) fail('INVALID_RESPONSE', ['$'], 'response')
  const r = value as Record<string, unknown>
  if (r.schemaVersion !== '1') out.push('schemaVersion')
  str(r.requestId, 'requestId', out)
  if (!['ok', 'partial', 'failed'].includes(r.status as string)) out.push('status')
  if (!Array.isArray(r.outcomes)) out.push('outcomes')
  if (!isObj(r.timing)) out.push('timing')
  if (!isObj(r.usage)) out.push('usage')
  if (!isObj(r.egress)) out.push('egress')
  if (r.egress !== undefined && isObj(r.egress) && typeof (r.egress as Record<string, unknown>).occurred !== 'boolean') {
    out.push('egress.occurred')
  }
  const id = r.provider
  if (!isObj(id) || !KINDS.includes(id.kind as ProviderKind)) out.push('provider.kind')
  else if (typeof id.synthetic !== 'boolean') out.push('provider.synthetic')
  if (out.length > 0) fail('INVALID_RESPONSE', out, 'response')

  const snapshotPaths: string[] = []
  let snapshot: SnapshotRef | undefined
  try {
    snapshot = parseSnapshotRef(r.snapshot, 'snapshot')
  } catch (e) {
    if (e instanceof ValidationError) snapshotPaths.push(...e.paths)
    else throw e
  }
  if (snapshotPaths.length > 0) fail('INVALID_RESPONSE', snapshotPaths, 'response snapshot')

  const outcomes = (r.outcomes as unknown[]).map((o, i) => parseOutcome(o, `outcomes[${i}]`))
  return {
    ...(r as unknown as Omit<DecisionResponse, 'snapshot' | 'outcomes'>),
    snapshot: snapshot as SnapshotRef,
    outcomes,
  }
}
