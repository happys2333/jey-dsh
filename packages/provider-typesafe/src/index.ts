import type {
  Answer, DecisionProvider, DecisionRequest, DecisionResponse, ErrorCode, JsonValue,
  ProviderCapabilities, ProviderIdentity, Question, QuestionOutcome,
} from 'jey-contracts'

/**
 * Official Jev / TypeSafe provider.
 *
 * Wire shapes are taken verbatim from the vendor's API documentation on 2026-09-23
 * (`docs.typesafe.ai/api`): request `{state, model, questions}` where `questions` is a
 * map keyed by caller-chosen ids and each entry carries `type`, `instructions` and a
 * primitive-specific `criteria`; response `{model, answers, usage}` where `answers`
 * mirrors those keys.
 *
 * Everything crossing this boundary is re-validated rather than cast. A provider that
 * returns a plausible-looking number for a question we never asked, or a choice
 * distribution over options we never offered, must fail here instead of becoming a
 * policy decision downstream.
 */

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

export interface TypesafeOptions {
  readonly model: string
  /** Resolved once per call so rotation works; the token itself never enters a log. */
  readonly credential: () => string | undefined
  readonly destinationId?: string
  readonly requestTimeoutMs?: number
  /** Injectable so the contract tests can run with no network at all. */
  readonly fetchImpl?: typeof globalThis.fetch
}

export class ProviderError extends Error {
  readonly code: ErrorCode
  readonly retryable: boolean
  readonly status: number | null
  constructor(code: ErrorCode, retryable: boolean, message: string, status: number | null = null) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.retryable = retryable
    this.status = status
  }
}

const typeOf = (question: Question): 'noul' | 'choice' | 'score' => {
  if (question.kind === 'boolean') return 'noul'
  return question.kind
}

/** Whitelisted projection: `snapshot`, `purpose` and `budget` are internal and stay home. */
export function toWireQuestions(request: DecisionRequest): Record<string, JsonValue> {
  const questions: Record<string, JsonValue> = {}
  for (const question of request.questions) {
    const type = typeOf(question)
    const entry: Record<string, JsonValue> = { type, instructions: question.instructions }
    if (question.kind === 'choice') {
      const criteria: Record<string, JsonValue> = {}
      for (const option of question.options) criteria[option.id] = option.description
      entry.criteria = criteria
    } else if (question.kind === 'score') {
      entry.criteria = [...question.levels]
    }
    if (questions[question.id] !== undefined) {
      throw new ProviderError('INVALID_INPUT', false, `duplicate question id '${question.id}' cannot be sent to a map-keyed API`)
    }
    questions[question.id] = entry
  }
  return questions
}

/** The complete outbound body, exposed so a test can assert exactly what leaves the host. */
export function toWireRequest(request: DecisionRequest, model: string): { state: JsonValue; model: string; questions: Record<string, JsonValue> } {
  return { state: request.state, model, questions: toWireQuestions(request) }
}

const clampUnit = (value: unknown, where: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ProviderError('INVALID_RESPONSE', false, `${where} must be a finite number in [0,1], got ${JSON.stringify(value)}`)
  }
  return value
}

const SUM_TOLERANCE = 0.02

function probabilities(value: unknown, expectedKeys: readonly string[], where: string): Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderError('INVALID_RESPONSE', false, `${where}.probabilities must be an object`)
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const want = [...expectedKeys].sort()
  if (keys.length !== want.length || keys.some((k, i) => k !== want[i])) {
    throw new ProviderError('INVALID_RESPONSE', false,
      `${where}.probabilities keys ${JSON.stringify(keys)} do not match the requested options ${JSON.stringify(want)}`)
  }
  const out: Record<string, number> = {}
  let total = 0
  for (const key of keys) {
    out[key] = clampUnit(record[key], `${where}.probabilities.${key}`)
    total += out[key] as number
  }
  if (Math.abs(total - 1) > SUM_TOLERANCE) {
    throw new ProviderError('INVALID_RESPONSE', false, `${where}.probabilities sum to ${total}, not ~1`)
  }
  return out
}

/** Per-question validation against what we actually asked, per spec 6.1. */
export function parseAnswer(id: string, asked: Question, raw: unknown): Answer {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProviderError('INVALID_RESPONSE', false, `answer '${id}' is not an object`)
  }
  const answer = raw as Record<string, unknown>
  const type = answer.type
  if (type !== typeOf(asked)) {
    throw new ProviderError('INVALID_RESPONSE', false, `answer '${id}' came back as type ${JSON.stringify(type)}, asked for ${typeOf(asked)}`)
  }
  const meta = { origin: 'provider-distribution' as const, calibration: 'uncalibrated' as const, calibrationId: null }

  if (asked.kind === 'boolean') {
    if ('confidence' in answer) {
      // The vendor documents that Noul carries no confidence. One appearing means the
      // shape moved; accepting it silently would hide that.
      throw new ProviderError('INVALID_RESPONSE', false, `answer '${id}' is noul but carries a confidence field`)
    }
    return { kind: 'boolean', pYes: clampUnit(answer.noul, `answer '${id}'.noul`), probability: meta }
  }

  const providerConfidence = 'confidence' in answer
    ? { providerConfidence: clampUnit(answer.confidence, `answer '${id}'.confidence`) }
    : {}

  if (asked.kind === 'choice') {
    const distribution = probabilities(answer.probabilities, asked.options.map(o => o.id), `answer '${id}'`)
    if (typeof answer.choice !== 'string' || !(answer.choice in distribution)) {
      throw new ProviderError('INVALID_RESPONSE', false, `answer '${id}'.choice is not one of the offered options`)
    }
    return { kind: 'choice', selected: answer.choice, probabilities: distribution, probability: { ...meta, ...providerConfidence } }
  }

  const indices = asked.levels.map((_, i) => String(i))
  const distribution = probabilities(answer.probabilities, indices, `answer '${id}'`)
  const legend = answer.legend
  if (legend === null || typeof legend !== 'object' || Array.isArray(legend)) {
    throw new ProviderError('INVALID_RESPONSE', false, `answer '${id}'.legend must map indices to level labels`)
  }
  const legendRecord = legend as Record<string, unknown>
  for (const [index, level] of asked.levels.entries()) {
    if (legendRecord[String(index)] !== level) {
      throw new ProviderError('INVALID_RESPONSE', false,
        `answer '${id}'.legend[${index}] is ${JSON.stringify(legendRecord[String(index)])}, asked for ${JSON.stringify(level)}`)
    }
  }
  let expected = 0
  for (const [index, key] of indices.entries()) expected += index * (distribution[key] as number)
  if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || Math.abs(answer.score - expected) > 0.05) {
    throw new ProviderError('INVALID_RESPONSE', false,
      `answer '${id}'.score ${JSON.stringify(answer.score)} disagrees with Σ(i×p_i)=${expected.toFixed(4)}`)
  }
  return { kind: 'score', expectedIndex: expected, levels: [...asked.levels], probabilities: distribution, probability: { ...meta, ...providerConfidence } }
}

export function parseResponse(request: DecisionRequest, raw: unknown, requestedModel: string): DecisionResponse {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProviderError('INVALID_RESPONSE', false, 'response body is not an object')
  }
  const body = raw as Record<string, unknown>
  if (typeof body.model !== 'string' || body.model.length === 0) {
    throw new ProviderError('INVALID_RESPONSE', false, 'response is missing the resolved model identifier')
  }
  const answers = body.answers
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new ProviderError('INVALID_RESPONSE', false, 'response is missing the `answers` map')
  }
  const answerRecord = answers as Record<string, unknown>
  const askedIds = request.questions.map(q => q.id).sort()
  const gotIds = Object.keys(answerRecord).sort()
  if (askedIds.length !== gotIds.length || askedIds.some((id, i) => id !== gotIds[i])) {
    throw new ProviderError('INVALID_RESPONSE', false,
      `answers came back for ${JSON.stringify(gotIds)} but ${JSON.stringify(askedIds)} were asked; no question may be dropped or invented`)
  }

  // One unusable answer must not discard the others: spec 4.3 allows a partial batch,
  // and a caller that only lost its optional question should keep the answers it has.
  const outcomes: QuestionOutcome[] = request.questions.map(q => {
    try {
      return { id: q.id, status: 'answered' as const, answer: parseAnswer(q.id, q, answerRecord[q.id]) }
    } catch (e) {
      if (e instanceof ProviderError) {
        return { id: q.id, status: 'error' as const, code: e.code, retryable: e.retryable }
      }
      throw e
    }
  })
  const answered = outcomes.filter(o => o.status === 'answered').length
  const usage = body.usage
  const usageRecord = usage !== null && typeof usage === 'object' && !Array.isArray(usage) ? usage as Record<string, unknown> : {}
  const token = (key: string): number | null =>
    typeof usageRecord[key] === 'number' && Number.isFinite(usageRecord[key] as number) ? usageRecord[key] as number : null

  return {
    schemaVersion: '1',
    requestId: request.requestId,
    snapshot: request.snapshot,
    status: answered === outcomes.length ? 'ok' : answered > 0 ? 'partial' : 'failed',
    provider: {
      kind: 'typesafe',
      providerVersion: 'systemone-v1',
      requestedModel,
      resolvedModel: body.model,
      modelRevision: null,
      weightsDigest: null,
      tokenizerRevision: null,
      templateDigest: 'sha256:provider-side-unreported',
      quantization: null,
      synthetic: false,
    },
    outcomes,
    timing: { queueMs: 0, inferenceMs: 0, totalMs: 0 },
    // The vendor exposes no cost field. `output_tokens` existing is not the same claim
    // as "output costed zero", and an unpriced input is not zero.
    usage: { inputTokens: token('input_tokens'), outputTokens: token('output_tokens'), costUsd: null, costBasis: 'unknown' },
    egress: { occurred: true, destinationId: null },
  }
}

const STATUS_CODES: Record<number, [ErrorCode, boolean]> = {
  400: ['INVALID_INPUT', false],
  401: ['AUTH', false],
  // Documented as 401, but the live endpoint answers 403 for a missing key. Matching the
  // docs alone would classify an unauthenticated call as an unexpected transport error.
  403: ['AUTH', false],
  413: ['INVALID_INPUT', false],
  422: ['INVALID_INPUT', false],
  429: ['RATE_LIMIT', true],
  503: ['OVERLOADED', true],
  504: ['TIMEOUT', false],
  529: ['OVERLOADED', true],
}

/**
 * v1 does not retry. The alternative — retrying here while a caller also retries — is
 * how request counts silently multiply, and repeated calls still cost money and tokens
 * even where output is free. A rate-limited decision therefore surfaces as a failed
 * check, which the policy layer escalates rather than hides.
 */
export class TypesafeProvider implements DecisionProvider {
  #options: TypesafeOptions
  #destinationId: string
  calls = 0

  constructor(options: TypesafeOptions) {
    this.#options = options
    this.#destinationId = options.destinationId ?? 'jev'
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      provider: this.#identity('unknown'),
      questionKinds: ['boolean', 'choice', 'score'],
      // Vendor-documented ceilings, recorded as facts rather than invented constants:
      // 64k tokens per request, and noul/choice/score only.
      maxInputBytes: 32_768,
      maxQuestions: 64,
      cancellation: 'cooperative',
    }
  }

  #identity(resolved: string): ProviderIdentity {
    return {
      kind: 'typesafe', providerVersion: 'systemone-v1', requestedModel: this.#options.model,
      resolvedModel: resolved, modelRevision: null, weightsDigest: null, tokenizerRevision: null,
      templateDigest: 'sha256:provider-side-unreported', quantization: null, synthetic: false,
    }
  }

  async evaluate(request: DecisionRequest, context: { readonly signal: AbortSignal }): Promise<DecisionResponse> {
    const credential = this.#options.credential()
    if (credential === undefined || credential === '') {
      throw new ProviderError('AUTH', false, 'no credential resolved; refusing to send the state without one')
    }
    this.calls += 1
    const fetchImpl = this.#options.fetchImpl ?? globalThis.fetch
    const controller = new AbortController()
    const onAbort = (): void => controller.abort(context.signal.reason)
    if (context.signal.aborted) onAbort()
    else context.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('jev-deadline')), this.#options.requestTimeoutMs ?? 10_000)

    let response: Response
    try {
      response = await fetchImpl(JEV_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
        body: JSON.stringify(toWireRequest(request, this.#options.model)),
        redirect: 'manual',
        signal: controller.signal,
      })
    } catch (e) {
      if (context.signal.aborted) throw new ProviderError('CANCELLED', false, 'caller cancelled before the provider answered')
      throw new ProviderError('OVERLOADED', true, `transport failure: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      clearTimeout(timer)
      context.signal.removeEventListener('abort', onAbort)
    }

    if (response.status >= 300 && response.status < 400) {
      // Following a redirect would let one allowlisted origin hand our state to another.
      throw new ProviderError('EGRESS_DENIED', false, `redirect ${response.status} refused; endpoints are allowlisted, not discovered`)
    }
    if (!response.ok) {
      const [code, retryable] = STATUS_CODES[response.status] ?? ['INVALID_RESPONSE', false]
      throw new ProviderError(code, retryable, `provider responded ${response.status}`, response.status)
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new ProviderError('INVALID_RESPONSE', false, 'provider responded with a non-JSON body')
    }
    const parsed = parseResponse(request, body, this.#options.model)
    return {
      ...parsed,
      provider: { ...parsed.provider },
      egress: { occurred: true, destinationId: this.#destinationId },
    }
  }

  async close(): Promise<void> {}
}
