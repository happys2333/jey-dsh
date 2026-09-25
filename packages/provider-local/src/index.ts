import type {
  DecisionProvider, DecisionRequest, DecisionResponse, ErrorCode, ProviderCapabilities,
} from 'jey-contracts'
import { parseDecisionResponse } from 'jey-core'

/**
 * Client for Jey's own local scoring service (`python/local_decider`).
 *
 * The protocol is ours, defined in `docs/handoff/docs/06_PROTOCOL_AND_CONFIG_CN.md`
 * section 1. SemIf does not expose this API and we do not claim it does: wrapping a
 * pinned upstream scorer in a resident service is new work in this project.
 *
 * Two properties are deliberate. The client sends only the *remaining* deadline,
 * measured from a monotonic clock started before queueing, so a service can never be
 * handed a fresh budget by someone else's queue. And loopback is verified here as well
 * as in config: a private IP is not "local", and the address cannot be moved by
 * anything a model controls.
 */

export const LOCAL_PROTOCOL_VERSION = '1'

export class LocalError extends Error {
  readonly code: ErrorCode
  readonly retryable: boolean
  readonly status: number | null
  constructor(code: ErrorCode, retryable: boolean, message: string, status: number | null = null) {
    super(message)
    this.name = 'LocalError'
    this.code = code
    this.retryable = retryable
    this.status = status
  }
}

export interface LocalOptions {
  readonly endpoint: string
  readonly token: () => string | undefined
  readonly maxRequestBytes?: number
  readonly requestTimeoutMs?: number
  readonly fetchImpl?: typeof globalThis.fetch
  /** Injectable monotonic clock, so deadline arithmetic is testable without sleeping. */
  readonly now?: () => number
}

const STATUS_CODES: Record<number, [ErrorCode, boolean]> = {
  400: ['INVALID_INPUT', false],
  401: ['AUTH', false],
  403: ['AUTH', false],
  413: ['INVALID_INPUT', false],
  422: ['UNSUPPORTED_CAPABILITY', false],
  429: ['QUEUE_FULL', true],
  502: ['INVALID_RESPONSE', false],
  503: ['LOCAL_NOT_READY', true],
  504: ['TIMEOUT', false],
}

/** Loopback literal only. `127.evil.com`, `localhost`, and any private IP all fail. */
export function isLoopbackEndpoint(endpoint: string): boolean {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.replace(/^\[|\]$/g, '')
  return host === '::1' || /^127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(host)
}

export class LocalProvider implements DecisionProvider {
  #options: LocalOptions
  #endpoint: string
  #capabilities: ProviderCapabilities | null = null
  #clock: () => number
  calls = 0
  /** Requests the client gave up on. Not a claim that the server stopped computing. */
  discarded = 0

  constructor(options: LocalOptions) {
    if (!isLoopbackEndpoint(options.endpoint)) {
      throw new LocalError('EGRESS_DENIED', false,
        `local service endpoint must be a loopback literal, got ${JSON.stringify(options.endpoint)}`)
    }
    this.#options = options
    this.#endpoint = options.endpoint.replace(/\/$/, '')
    // Date.now() can step backwards with the wall clock; a deadline must not.
    this.#clock = options.now ?? (() => performance.timeOrigin + performance.now())
  }

  get sawCapabilities(): boolean {
    return this.#capabilities !== null
  }

  async capabilities(options: { readonly refresh?: boolean } = {}): Promise<ProviderCapabilities> {
    if (this.#capabilities !== null && options.refresh !== true) return this.#capabilities
    const body = await this.#request('GET', '/v1/capabilities', undefined, { timeoutMs: 5_000 })
    const parsed = body as Record<string, unknown>
    const provider = parsed.provider
    if (provider === null || typeof provider !== 'object' || Array.isArray(provider)) {
      throw new LocalError('INVALID_RESPONSE', false, 'capabilities omitted the loaded provider identity')
    }
    const identity = provider as Record<string, unknown>
    if (identity.kind !== 'local') {
      throw new LocalError('INVALID_RESPONSE', false, `capabilities reported kind ${JSON.stringify(identity.kind)}, expected "local"`)
    }
    // A service that cannot name its model revision is not allowed to hand back a
    // plausible-looking identity we could cache against the wrong weights.
    for (const field of ['modelRevision', 'tokenizerRevision', 'weightsDigest', 'templateDigest'] as const) {
      if (typeof identity[field] !== 'string' || (identity[field] as string).length === 0) {
        throw new LocalError('INVALID_RESPONSE', false, `capabilities omitted ${field}; refusing to assume a model identity`)
      }
    }
    const positiveInt = (value: unknown, field: string): number => {
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        throw new LocalError('INVALID_RESPONSE', false, `capabilities.${field} must be a positive integer`)
      }
      return value
    }
    const kinds = parsed.questionKinds
    if (!Array.isArray(kinds) || kinds.length === 0
      || !kinds.every(k => k === 'boolean' || k === 'choice' || k === 'score')) {
      throw new LocalError('INVALID_RESPONSE', false, 'capabilities.questionKinds is missing or names an unknown question kind')
    }
    if (parsed.cancellation !== 'cooperative' && parsed.cancellation !== 'discard-only') {
      // Claiming cooperative cancellation without the ability would let a caller believe a
      // killed request actually stopped the computation.
      throw new LocalError('INVALID_RESPONSE', false, 'capabilities must declare cancellation as cooperative or discard-only')
    }
    const capabilities: ProviderCapabilities = {
      provider: parsed.provider as ProviderCapabilities['provider'],
      questionKinds: kinds,
      maxInputBytes: positiveInt(parsed.maxInputBytes, 'maxInputBytes'),
      maxQuestions: positiveInt(parsed.maxQuestions, 'maxQuestions'),
      cancellation: parsed.cancellation,
    }
    this.#capabilities = capabilities
    return capabilities
  }

  async evaluate(request: DecisionRequest, context: { readonly signal: AbortSignal }): Promise<DecisionResponse> {
    const startedAt = this.#clock()
    // The caller's budget arrives already reduced by queueing: only the coordinator knows
    // how long a request waited, so only it can say what is left. This client may tighten
    // that figure but never hand the service a wider one than it was given.
    if (request.budget.maxElapsedMs <= 0) {
      throw new LocalError('TIMEOUT', false, 'no deadline remained for this request when it reached the client')
    }
    this.calls += 1
    const body = await this.#request('POST', '/v1/decide', request, {
      timeoutMs: request.budget.maxElapsedMs,
      signal: context.signal,
      maxRequestBytes: this.#options.maxRequestBytes ?? request.budget.maxInputBytes,
    })
    let parsed: DecisionResponse
    try {
      parsed = parseDecisionResponse(body)
    } catch (e) {
      // A malformed answer is a transport-level failure with a code the policy layer
      // already understands; letting a foreign error type escape would bypass that.
      throw new LocalError('INVALID_RESPONSE', false, e instanceof Error ? e.message : 'service returned an unparseable response')
    }
    if (parsed.requestId !== request.requestId) {
      throw new LocalError('INVALID_RESPONSE', false, `service answered for ${parsed.requestId} instead of ${request.requestId}`)
    }
    if (parsed.snapshot.sessionId !== request.snapshot.sessionId || parsed.snapshot.generation !== request.snapshot.generation) {
      throw new LocalError('INVALID_RESPONSE', false, 'service answered with a snapshot identity that is not the one we sent')
    }
    // Latency is measured here, not trusted from the payload: the service cannot see
    // client-side queueing, and a 0 from it is a missing measurement, not a fast answer.
    return { ...parsed, timing: { ...parsed.timing, totalMs: Math.max(parsed.timing.totalMs, Math.round(this.#clock() - startedAt)) } }
  }

  async #request(
    method: 'GET' | 'POST',
    path: string,
    payload: unknown,
    options: { readonly timeoutMs: number; readonly signal?: AbortSignal; readonly maxRequestBytes?: number },
  ): Promise<unknown> {
    const token = this.#options.token()
    if (path !== '/health/live' && (token === undefined || token === '')) {
      throw new LocalError('AUTH', false, `no local service token resolved for ${path}; refusing an unauthenticated request`)
    }
    const fetchImpl = this.#options.fetchImpl ?? globalThis.fetch
    const controller = new AbortController()
    const onAbort = (): void => controller.abort(options.signal?.reason)
    if (options.signal?.aborted === true) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('local-deadline')), Math.max(1, options.timeoutMs))

    let serialized: string | undefined
    if (payload !== undefined) {
      serialized = JSON.stringify(payload)
      const bytes = Buffer.byteLength(serialized, 'utf8')
      if (options.maxRequestBytes !== undefined && bytes > options.maxRequestBytes) {
        clearTimeout(timer)
        throw new LocalError('INVALID_INPUT', false, `request body is ${bytes} bytes, over the ${options.maxRequestBytes} byte bound`)
      }
    }

    let response: Response
    try {
      response = await fetchImpl(`${this.#endpoint}${path}`, {
        method,
        headers: {
          ...(serialized === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        ...(serialized === undefined ? {} : { body: serialized }),
        redirect: 'manual',
        signal: controller.signal,
      })
    } catch (e) {
      if (options.signal?.aborted === true) {
        this.discarded += 1
        throw new LocalError('CANCELLED', false, 'caller cancelled; whether the service stopped computing is unknown')
      }
      if (controller.signal.aborted) {
        this.discarded += 1
        throw new LocalError('TIMEOUT', false, 'local service did not answer within the remaining deadline')
      }
      throw new LocalError('LOCAL_NOT_READY', true, `cannot reach the local service: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }

    if (response.status >= 300 && response.status < 400) {
      throw new LocalError('EGRESS_DENIED', false, `redirect ${response.status} refused; the local origin is configured, not discovered`)
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      if (response.ok) throw new LocalError('INVALID_RESPONSE', false, 'local service answered 2xx with a non-JSON body')
      body = null
    }

    if (!response.ok) {
      const fallback = STATUS_CODES[response.status] ?? ['INVALID_RESPONSE', false]
      const code = fallback[0]
      const detail = body !== null && typeof body === 'object' && !Array.isArray(body)
        ? (body as { error?: { code?: unknown; retryable?: unknown } }).error
        : undefined
      throw new LocalError(
        typeof detail?.code === 'string' ? (detail.code as ErrorCode) : code,
        typeof detail?.retryable === 'boolean' ? detail.retryable : fallback[1],
        `local service responded ${response.status}`,
        response.status,
      )
    }
    return body
  }

  /** Liveness only; documented to load nothing and leak nothing, so it needs no token. */
  async live(): Promise<boolean> {
    try {
      const body = await this.#requestUnauthenticated('/health/live')
      return (body as { live?: unknown }).live === true
    } catch {
      return false
    }
  }

  async #requestUnauthenticated(path: string): Promise<unknown> {
    const fetchImpl = this.#options.fetchImpl ?? globalThis.fetch
    const response = await fetchImpl(`${this.#endpoint}${path}`, { method: 'GET', redirect: 'manual' })
    if (!response.ok) throw new LocalError('LOCAL_NOT_READY', true, `${path} responded ${response.status}`, response.status)
    return response.json()
  }

  /**
   * Readiness is its own question: it says the model, tokenizer, template and backend
   * were all checked. It must never be satisfied by liveness, and it must never be
   * polled in a way that triggers a download.
   */
  async ready(): Promise<{ readonly ready: boolean; readonly code: string | null }> {
    try {
      const body = await this.#request('GET', '/health/ready', undefined, { timeoutMs: 2_000 }) as { ready?: unknown; code?: unknown }
      return body.ready === true ? { ready: true, code: null } : { ready: false, code: typeof body.code === 'string' ? body.code : 'LOCAL_NOT_READY' }
    } catch (e) {
      if (e instanceof LocalError && e.status === 503) return { ready: false, code: 'LOCAL_NOT_READY' }
      throw e
    }
  }

  async close(): Promise<void> {
    this.#capabilities = null
  }
}
