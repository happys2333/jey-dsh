import { createHmac, randomUUID } from 'node:crypto'
import type {
  DecisionAction, DecisionResponse, ExecutionOutcome, HostDecision, JsonValue,
  ProviderKind, SnapshotRef,
} from 'jey-contracts'
import { utf8Bytes } from './canonical.ts'

/**
 * Audit records, spec sections 5.4 and 11.
 *
 * The privacy guarantee here is structural, not redactive: `AuditEvent` simply has
 * no field that could carry raw arguments or the full context, so forgetting to
 * scrub something is not available as a failure mode. Redaction is still useful as a
 * second measure, but it must never be the only one.
 *
 * The journal is single-writer, bounded, and append-only. It makes no tamper-proof
 * claim: a local file plus a hash chain detects some edits and stops none.
 */

/** §11's fixed record. Three separate objects on purpose — see `DecisionRecord`. */
export interface AuditEvent {
  readonly kind: 'decision'
  readonly auditId: string
  readonly requestId: string
  readonly sessionId: string
  readonly agentId: string
  readonly providerKind: ProviderKind
  readonly synthetic: boolean
  readonly resolvedModel: string
  readonly templateDigest: string
  readonly snapshot: SnapshotRef
  readonly timing: { readonly queueMs: number; readonly inferenceMs: number; readonly totalMs: number }
  /** Status per question only. An answer is an observation and stays out of the public log. */
  readonly questionStatuses: readonly { readonly id: string; readonly status: 'answered' | 'abstained' | 'error' }[]
  readonly action: DecisionAction | null
  readonly reasonCodes: readonly string[]
  readonly hostDecision: HostDecision['kind'] | null
  readonly execution: ExecutionOutcome['status'] | null
  readonly failureCode: string | null
  readonly egressOccurred: boolean
  readonly stale: boolean
  /** Which parts of the decision state were cut to fit the byte budget (spec 4.2). */
  readonly truncatedPaths: readonly string[]
  readonly at: number
}

/** A run that had nothing to apply: a late answer, an ignored duplicate, a drop. */
export interface AuditDiagnostic {
  readonly kind: 'diagnostic'
  readonly auditId: string
  readonly requestId: string
  readonly sessionId: string
  readonly reason: string
  readonly at: number
}

export type Auditable = AuditEvent | AuditDiagnostic

const AUDIT_ID_PREFIX = 'aud_'

/**
 * Ids are minted, never accepted from callers: an id derived from request content
 * would turn the log into an index over low-entropy user text.
 */
export function mintAuditId(): string {
  return `${AUDIT_ID_PREFIX}${randomUUID()}`
}

export class AuditSchemaError extends Error {
  readonly problems: readonly string[]
  constructor(problems: readonly string[], message: string) {
    super(message)
    this.name = 'AuditSchemaError'
    this.problems = problems
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const DECISION_KEYS = [
  'kind', 'auditId', 'requestId', 'sessionId', 'agentId', 'providerKind', 'synthetic', 'resolvedModel',
  'templateDigest', 'snapshot', 'timing', 'questionStatuses', 'action', 'reasonCodes', 'hostDecision',
  'execution', 'failureCode', 'egressOccurred', 'stale', 'truncatedPaths', 'at',
] as const

const DIAGNOSTIC_KEYS = ['kind', 'auditId', 'requestId', 'sessionId', 'reason', 'at'] as const

/** Exactly the declared keys, no extras, no omissions. */
function fieldCheck(event: Auditable): string[] {
  const record = event as unknown as Record<string, unknown>
  const required: readonly string[] = event.kind === 'decision' ? DECISION_KEYS : DIAGNOSTIC_KEYS
  const problems: string[] = []
  for (const key of required) if (!(key in record)) problems.push(`missing:${key}`)
  for (const key of Object.keys(record)) if (!required.includes(key)) problems.push(`unknown:${key}`)
  if (typeof record.auditId !== 'string' || !record.auditId.startsWith(AUDIT_ID_PREFIX)) problems.push('bad:auditId')
  if (typeof record.at !== 'number' || !Number.isFinite(record.at)) problems.push('bad:at')
  if (record.kind === 'decision') {
    if (typeof record.synthetic !== 'boolean') problems.push('bad:synthetic')
    if (!Array.isArray(record.questionStatuses)) problems.push('bad:questionStatuses')
    if (typeof record.egressOccurred !== 'boolean') problems.push('bad:egressOccurred')
  }
  return problems
}

/**
 * Serialise one event. Refuses anything that is not exactly the declared shape, so a
 * future field cannot start riding along unnoticed.
 */
export function serializeAuditEvent(event: Auditable): string {
  const problems = fieldCheck(event)
  if (problems.length > 0) throw new AuditSchemaError(problems, `invalid audit record: ${problems.join(', ')}`)
  return JSON.stringify(event)
}

/**
 * Re-read a line from disk. Unknown keys are rejected rather than dropped: a field
 * an older writer added is exactly the kind of thing a reader should notice.
 */
export function parseAuditLine(line: string): Auditable {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    throw new AuditSchemaError(['malformed-json'], 'audit line is not JSON')
  }
  if (!isRecord(raw) || raw.kind !== 'decision' && raw.kind !== 'diagnostic') {
    throw new AuditSchemaError(['bad:kind'], 'audit line is not a known event kind')
  }
  if (raw.kind === 'decision') {
    const extra = Object.keys(raw).filter(k => !(DECISION_KEYS as readonly string[]).includes(k))
    if (extra.length > 0) throw new AuditSchemaError(extra.map(k => `unknown:${k}`), 'audit line carries undeclared fields')
    if (typeof raw.auditId !== 'string' || !raw.auditId.startsWith(AUDIT_ID_PREFIX)) throw new AuditSchemaError(['bad:auditId'], 'audit line id was not minted here')
    for (const key of ['requestId', 'sessionId', 'agentId', 'resolvedModel', 'templateDigest']) {
      if (typeof raw[key] !== 'string') throw new AuditSchemaError([`bad:${key}`], `audit line ${key} is not a string`)
    }
    if (typeof raw.synthetic !== 'boolean' || typeof raw.egressOccurred !== 'boolean' || typeof raw.stale !== 'boolean') {
      throw new AuditSchemaError(['bad:booleans'], 'audit line flags must be booleans')
    }
    if (!Array.isArray(raw.questionStatuses) || !Array.isArray(raw.reasonCodes)) {
      throw new AuditSchemaError(['bad:arrays'], 'audit line collections must be arrays')
    }
  }
  return raw as unknown as Auditable
}

/**
 * A reference for something that might be low-entropy (a file path, a tool name, a
 * short user phrase). A bare SHA-256 of such a value is trivially reversed by
 * guessing, so a key is required; without one, only genuinely high-entropy input is
 * accepted. The key is never written into the log.
 */
/**
 * A published reference to something the log reader must not be able to reverse.
 *
 * This used to decide by string length, which is wrong: a 64-character hex digest of
 * `{path: "a.txt"}` is a long, high-entropy *string* that still commits to a value one
 * guess away. Entropy of the underlying content is something only the caller knows, so
 * the function refuses to guess: anything that may reach a public log is keyed, and a
 * caller who genuinely has an opaque value (a minted id, a content hash of a large
 * blob) has no need to publish a digest of it at all.
 */
export function referenceDigest(value: string, key: string | null): string {
  if (key === null || key.length === 0) {
    throw new AuditSchemaError(['unkeyed-reference'],
      'a published reference must be keyed; an unkeyed digest is guessable whenever its input is low-entropy, which this function cannot detect')
  }
  return `hmac:${createHmac('sha256', key).update(value, 'utf8').digest('hex')}`
}

export interface LineSink {
  /** Append one complete line. Throwing means the record did not land. */
  writeLine(line: string): void
  /** Optional: the journal asks the sink to start a new store when bounded. */
  rotate?(reason: string): void
}

export interface EmitResult {
  readonly written: boolean
  readonly reason: 'ok' | 'oversized' | 'sink-failed'
  readonly problem: string | null
}

export interface JournalOptions {
  readonly maxRetainedEvents: number
  readonly maxLineBytes: number
  readonly now?: () => number
}

export interface JournalCounters {
  readonly written: number
  readonly droppedOversized: number
  readonly sinkFailures: number
  readonly rotations: number
  readonly rejected: number
}

/**
 * Append-only, single-writer, bounded. When `maxRetainedEvents` is reached it asks the
 * sink to rotate instead of silently growing forever, and it never rewrites what an
 * earlier line already confirmed.
 */
export class AuditJournal {
  #sink: LineSink
  #options: JournalOptions
  #now: () => number
  #retained = 0
  #counters = { written: 0, droppedOversized: 0, sinkFailures: 0, rotations: 0, rejected: 0 }

  constructor(sink: LineSink, options: JournalOptions) {
    this.#sink = sink
    this.#options = options
    this.#now = options.now ?? (() => Date.now())
  }

  get counters(): JournalCounters {
    return { ...this.#counters }
  }

  emit(event: Auditable): EmitResult {
    const stamp = { ...event, at: (event as AuditEvent).at ?? this.#now() }
    let line: string
    try {
      line = serializeAuditEvent(stamp as Auditable)
    } catch (e) {
      this.#counters.rejected += 1
      return { written: false, reason: 'oversized', problem: e instanceof Error ? e.message : 'invalid' }
    }
    if (utf8Bytes(line) > this.#options.maxLineBytes) {
      this.#counters.droppedOversized += 1
      return { written: false, reason: 'oversized', problem: `${utf8Bytes(line)} > ${this.#options.maxLineBytes}` }
    }
    try {
      this.#sink.writeLine(line)
    } catch (e) {
      this.#counters.sinkFailures += 1
      return { written: false, reason: 'sink-failed', problem: e instanceof Error ? e.message : 'sink threw' }
    }
    this.#counters.written += 1
    this.#retained += 1
    if (this.#retained >= this.#options.maxRetainedEvents) {
      this.#retained = 0
      this.#counters.rotations += 1
      this.#sink.rotate?.('retained-events-limit')
    }
    return { written: true, reason: 'ok', problem: null }
  }
}

/** §7.2: an observation that could not be written must not by itself stop execution. */
export function shouldBlockDispatch(
  onFailure: 'keep-execution' | 'fail-closed-before-dispatch',
  result: EmitResult,
): boolean {
  return !result.written && onFailure === 'fail-closed-before-dispatch'
}

export interface ScanResult {
  readonly confirmed: Auditable[]
  /** Lines kept out of the record set, with the reason. Never deleted or rewritten. */
  readonly isolated: readonly { readonly line: string; readonly reason: string }[]
  readonly lines: number
}

/**
 * Read back a journal after a crash. A torn final line is expected — the process can
 * die mid-append — so it is isolated rather than repaired, and the confirmed prefix is
 * returned untouched.
 */
export function scanJournal(text: string): ScanResult {
  const physical = text.split('\n')
  const trailingIncomplete = text.length > 0 && !text.endsWith('\n')
  const candidate = trailingIncomplete ? physical.slice(0, -1) : physical
  const confirmed: Auditable[] = []
  const isolated: { line: string; reason: string }[] = []

  for (const line of candidate) {
    if (line === '') continue
    try {
      confirmed.push(parseAuditLine(line))
    } catch (e) {
      isolated.push({ line, reason: e instanceof Error ? e.message : 'unparseable' })
    }
  }
  if (trailingIncomplete) {
    const last = physical[physical.length - 1] ?? ''
    if (last !== '') isolated.push({ line: last, reason: 'incomplete-final-line' })
  }
  return { confirmed, isolated, lines: physical.length }
}

/** Duplicate auditIds mean two writers shared one file; the earlier line stays as it is. */
export function findDuplicateIds(events: readonly Auditable[]): readonly string[] {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const e of events) {
    if (seen.has(e.auditId)) dupes.add(e.auditId)
    seen.add(e.auditId)
  }
  return [...dupes]
}

export interface DecisionRecord {
  readonly response: DecisionResponse
  readonly action: DecisionAction | null
  readonly reasonCodes: readonly string[]
  readonly hostDecision: HostDecision | null
  readonly execution: ExecutionOutcome | null
  readonly stale: boolean
  /** Which parts of the decision state were cut to fit the byte budget. */
  readonly truncatedPaths?: readonly string[]
  /** Key for publishing argument digests; null keeps them out of the log entirely. */
  readonly auditKey?: string | null
  readonly at?: number
}

/**
 * A digest of frozen arguments is guessable when the arguments are short — `{path:
 * "a.txt"}` is one guess away — so it only belongs in a public log under a key that a
 * reader without the key cannot try (§5.4). Without a key, it is dropped rather than
 * weakened into something that looks safe.
 */
export function publicSnapshot(ref: SnapshotRef, key: string | null): SnapshotRef {
  if (ref.callDigest === null) return ref
  return { ...ref, callDigest: key === null ? null : referenceDigest(ref.callDigest, key) }
}

/**
 * Compose one decision record from the three objects of §4.1. They stay separate
 * arguments so that "the model answered", "policy said deny" and "the host refused"
 * cannot be conflated by construction, and so a missing stage is a visible null
 * rather than a plausible-looking summary.
 */
export function recordDecision(input: DecisionRecord): AuditEvent {
  const { response, action, reasonCodes, hostDecision, execution, stale } = input
  return {
    kind: 'decision',
    auditId: mintAuditId(),
    requestId: response.requestId,
    sessionId: response.snapshot.sessionId,
    agentId: response.snapshot.agentId,
    providerKind: response.provider.kind,
    synthetic: response.provider.synthetic,
    resolvedModel: response.provider.resolvedModel,
    templateDigest: response.provider.templateDigest,
    snapshot: publicSnapshot(response.snapshot, input.auditKey ?? null),
    timing: response.timing,
    questionStatuses: response.outcomes.map(o => ({ id: o.id, status: o.status })),
    action,
    reasonCodes,
    hostDecision: hostDecision?.kind ?? null,
    execution: execution?.status ?? null,
    failureCode: execution?.failureCode ?? null,
    egressOccurred: response.egress.occurred,
    stale,
    truncatedPaths: input.truncatedPaths ?? [],
    at: input.at ?? Date.now(),
  }
}

