import type { DecisionProvider, DecisionRequest, DecisionResponse, ErrorCode, HostDecision, PolicyDecision, SnapshotRef } from 'jey-contracts'
import { isFresh } from './snapshot.ts'
import { combineHostAndJey } from './policy.ts'
import { EMPTY_BUDGET, keyOf, refundBudget, reserveBudget, type BudgetLedger } from './budget.ts'

/**
 * The request lifecycle of spec 4.4 plus the queueing rules of 10.2.
 *
 * Two properties are load-bearing here and both are structural rather than
 * conventional:
 *
 * - **apply once.** A policy decision is checked against the *current* snapshot and
 *   consumed inside one synchronous step. JS gives no await point in between, which
 *   is exactly what 10.1 demands ("版本检查与动作发布之间不能再有 await").
 * - **one terminal state per (session, requestId, generation).** A late answer from
 *   an abandoned run may add a diagnostic, but it cannot re-open a finished run or
 *   change an action the host already carried out.
 */

export type Phase =
  | 'created' | 'snapshotted' | 'admitted' | 'queued' | 'running' | 'observed'
  | 'validated' | 'policy_applied' | 'recorded'
  | 'cancelled' | 'timed_out' | 'failed' | 'stale'

const NEXT: Record<Phase, readonly Phase[]> = {
  created: ['snapshotted', 'cancelled', 'failed'],
  snapshotted: ['admitted', 'cancelled', 'failed', 'stale'],
  admitted: ['queued', 'running', 'cancelled', 'timed_out', 'failed'],
  queued: ['running', 'cancelled', 'timed_out', 'failed'],
  running: ['observed', 'cancelled', 'timed_out', 'failed'],
  observed: ['validated', 'cancelled', 'failed', 'stale'],
  validated: ['policy_applied', 'recorded', 'cancelled', 'failed', 'stale'],
  // Only a diagnostic may follow a recorded terminal state.
  policy_applied: ['recorded'],
  recorded: [],
  cancelled: ['recorded'],
  timed_out: ['recorded'],
  failed: ['recorded'],
  stale: ['recorded'],
}

/** Phases after which no policy may be written or applied any more. */
export const CLOSED_PHASES: readonly Phase[] = ['policy_applied', 'recorded', 'cancelled', 'timed_out', 'failed', 'stale']

export class IllegalTransition extends Error {
  constructor(from: Phase, to: Phase) {
    super(`illegal Jey lifecycle transition ${from} -> ${to}`)
    this.name = 'IllegalTransition'
  }
}

export function canTransition(from: Phase, to: Phase): boolean {
  return NEXT[from].includes(to)
}

export function isClosed(phase: Phase): boolean {
  return CLOSED_PHASES.includes(phase)
}

export class Run {
  private current: Phase = 'created'
  readonly key: string

  /** Declared rather than a constructor parameter property: Node's type stripping rejects those. */
  readonly request: DecisionRequest

  constructor(request: DecisionRequest) {
    this.request = request
    this.key = `${request.snapshot.sessionId}|${request.requestId}|${request.snapshot.generation}`
  }

  get phase(): Phase {
    return this.current
  }

  to(next: Phase): this {
    if (!canTransition(this.current, next)) throw new IllegalTransition(this.current, next)
    this.current = next
    return this
  }
}

export type ApplicationResult =
  | { readonly kind: 'applied'; readonly decision: HostDecision }
  | { readonly kind: 'stale' }
  | { readonly kind: 'already-applied' }

export interface GuardedApplication {
  readonly phase: Phase
  /** Synchronous by design: re-check, combine and consume happen in one step. */
  apply(current: SnapshotRef, host: HostDecision, policy: PolicyDecision): ApplicationResult
}

export type CoordinatorOutcome =
  | { readonly kind: 'response'; readonly response: DecisionResponse; readonly application: GuardedApplication }
  | { readonly kind: 'queue-full'; readonly retryable: true; readonly scope: 'global' | 'session' }
  | { readonly kind: 'budget-exceeded'; readonly scope: 'turn' | 'session'; readonly used: number; readonly limit: number }
  | { readonly kind: 'timed-out'; readonly stage: 'queue' | 'inference' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'failed'; readonly code: ErrorCode | 'PROVIDER_ERROR' }
  | { readonly kind: 'closed' }

export interface CoordinatorLimits {
  readonly maxConcurrent: number
  readonly maxQueue: number
  readonly deadlineMs: number
  readonly perTurnCalls: number
  readonly perSessionCalls: number
  /**
   * How many runs one session may have waiting at once. Fairness policy, not a user
   * knob: derived by the caller from `maxConcurrent` so a single chatty session cannot
   * occupy the whole queue and starve every other agent.
   */
  readonly maxQueuePerSession: number
}

export interface CoordinatorOptions {
  readonly limits: CoordinatorLimits
  /** Injectable so tests do not sleep. */
  readonly now?: () => number
  readonly onDiagnostic?: (event: { readonly key: string; readonly kind: string }) => void
}

interface Waiter {
  readonly run: Run
  readonly resolve: (outcome: CoordinatorOutcome) => void
  readonly signal: AbortSignal
  readonly startedAt: number
  readonly onAbort: () => void
}

function combineCodes(response: DecisionResponse): ErrorCode | null {
  const error = response.outcomes.find(o => o.status === 'error')
  return error !== undefined && error.status === 'error' ? error.code : null
}

export class DecisionCoordinator {
  #provider: DecisionProvider
  #limits: CoordinatorLimits
  #now: () => number
  #onDiagnostic: (e: { key: string; kind: string }) => void
  #inflight = 0
  /** One queue per session, drained round-robin: a chatty agent cannot starve the others. */
  #queues = new Map<string, Waiter[]>()
  #cursor = 0
  #budget: BudgetLedger = EMPTY_BUDGET
  #settled = new Set<string>()
  #localControls = new Set<AbortController>()
  #closed = false

  constructor(provider: DecisionProvider, options: CoordinatorOptions) {
    this.#provider = provider
    this.#limits = options.limits
    this.#now = options.now ?? Date.now
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined)
  }

  get stats(): {
    readonly inflight: number
    readonly queued: number
    readonly settled: number
    readonly budget: BudgetLedger
  } {
    return { inflight: this.#inflight, queued: this.#queued(), settled: this.#settled.size, budget: this.#budget }
  }

  #queued(): number {
    let total = 0
    for (const list of this.#queues.values()) total += list.length
    return total
  }

  /** Take the next waiter in session rotation, not from the head of one busy session. */
  #nextWaiter(): Waiter | undefined {
    const keys = [...this.#queues.keys()]
    if (keys.length === 0) return undefined
    for (let offset = 0; offset < keys.length; offset++) {
      const index = (this.#cursor + offset) % keys.length
      const key = keys[index] as string
      const list = this.#queues.get(key) as Waiter[]
      if (list.length === 0) {
        this.#queues.delete(key)
        continue
      }
      const waiter = list.shift() as Waiter
      if (list.length === 0) this.#queues.delete(key)
      this.#cursor = (index + 1) % keys.length
      return waiter
    }
    return undefined
  }

  /**
   * Admission is decided synchronously, before any await, so two concurrent callers
   * cannot both be promised the last slot (10.4).
   */
  submit(request: DecisionRequest, context: { readonly signal: AbortSignal }): Promise<CoordinatorOutcome> {
    if (this.#closed) return Promise.resolve({ kind: 'closed' })
    const run = new Run(request)
    run.to('snapshotted').to('admitted')

    if (this.#settled.has(run.key)) return Promise.resolve({ kind: 'duplicate' })

    const budgetKey = keyOf(request)
    const reservation = reserveBudget(this.#budget, budgetKey, {
      perTurnCalls: this.#limits.perTurnCalls,
      perSessionCalls: this.#limits.perSessionCalls,
    })
    if (!reservation.allowed) {
      run.to('failed').to('recorded')
      this.#settled.add(run.key)
      return Promise.resolve({ kind: 'budget-exceeded', scope: reservation.scope, used: reservation.used, limit: reservation.limit })
    }
    this.#budget = reservation.ledger

    if (this.#inflight >= this.#limits.maxConcurrent) {
      const sessionId = budgetKey.sessionId
      const refusal = (scope: 'global' | 'session'): Promise<CoordinatorOutcome> => {
        this.#budget = refundBudget(this.#budget, budgetKey)
        run.to('queued').to('failed').to('recorded')
        this.#settled.add(run.key)
        return Promise.resolve({ kind: 'queue-full', retryable: true, scope })
      }
      if (this.#queued() >= this.#limits.maxQueue) return refusal('global')
      if ((this.#queues.get(sessionId)?.length ?? 0) >= this.#limits.maxQueuePerSession) return refusal('session')

      return new Promise<CoordinatorOutcome>(resolve => {
        const waiter: Waiter = { run, resolve, signal: context.signal, startedAt: this.#now(), onAbort: () => this.#abortWaiter(waiter) }
        context.signal.addEventListener('abort', waiter.onAbort, { once: true })
        // A queued run holds a *queue* slot, not an execution slot; counting it as
        // inflight would make #pump unable to ever satisfy its own condition.
        run.to('queued')
        const list = this.#queues.get(sessionId) ?? []
        list.push(waiter)
        this.#queues.set(sessionId, list)
      })
    }

    this.#inflight += 1
    return this.#execute(run, context.signal, this.#now())
  }

  /** Only ever called for a waiter that has not started running yet. */
  #abortWaiter(waiter: Waiter | undefined): void {
    if (waiter === undefined) return
    const sessionId = waiter.run.request.snapshot.sessionId
    const list = this.#queues.get(sessionId)
    if (list !== undefined) {
      const index = list.indexOf(waiter)
      if (index >= 0) list.splice(index, 1)
      if (list.length === 0) this.#queues.delete(sessionId)
    }
    if (isClosed(waiter.run.phase)) return
    // Reservation returned: the run never started, so it must not have paid for budget.
    this.#budget = refundBudget(this.#budget, keyOf(waiter.run.request))
    waiter.run.to('cancelled').to('recorded')
    this.#settled.add(waiter.run.key)
    waiter.signal.removeEventListener('abort', waiter.onAbort)
    waiter.resolve({ kind: 'cancelled' })
    this.#pump()
  }

  #release(): void {
    this.#inflight = Math.max(0, this.#inflight - 1)
  }

  /** Start anything waiting, respecting the deadline that has already been spent. */
  #pump(): void {
    while (this.#inflight < this.#limits.maxConcurrent) {
      const waiter = this.#nextWaiter()
      if (waiter === undefined) return
      if (waiter.signal.aborted) {
        this.#abortWaiter(waiter)
        continue
      }
      const spentMs = this.#now() - waiter.startedAt
      if (spentMs >= this.#limits.deadlineMs) {
        this.#budget = refundBudget(this.#budget, keyOf(waiter.run.request))
        waiter.run.to('timed_out').to('recorded')
        this.#settled.add(waiter.run.key)
        waiter.signal.removeEventListener('abort', waiter.onAbort)
        waiter.resolve({ kind: 'timed-out', stage: 'queue' })
        continue
      }
      // From here #execute owns the run and its cancellation, so the queue-level
      // listener goes away and cancellation is handled in exactly one place.
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      this.#inflight += 1
      void this.#execute(waiter.run, waiter.signal, waiter.startedAt).then(outcome => {
        waiter.signal.removeEventListener('abort', waiter.onAbort)
        waiter.resolve(outcome)
      })
    }
  }

  async #execute(run: Run, signal: AbortSignal, startedAt: number): Promise<CoordinatorOutcome> {
    if (signal.aborted) {
      this.#release()
      this.#budget = refundBudget(this.#budget, keyOf(run.request))
      run.to('cancelled').to('recorded')
      this.#settled.add(run.key)
      this.#pump()
      return { kind: 'cancelled' }
    }

    // A queue wait that already ate the deadline must not then spend model budget.
    if (this.#now() - startedAt >= this.#limits.deadlineMs) {
      this.#release()
      this.#budget = refundBudget(this.#budget, keyOf(run.request))
      run.to('timed_out').to('recorded')
      this.#settled.add(run.key)
      this.#pump()
      return { kind: 'timed-out', stage: 'queue' }
    }

    run.to('running')
    // One combined signal: giving up locally also stops the provider's work, so a
    // discarded answer cannot keep burning a GPU slot forever (10.2).
    const local = new AbortController()
    this.#localControls.add(local)
    const onAbort = (): void => local.abort(new Error('jey-cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => local.abort(new Error('jey-deadline')), this.#limits.deadlineMs - (this.#now() - startedAt))

    // Settle exactly once, at the deadline or the answer, whichever comes first.
    // Waiting *for* the provider to notice its cancellation would let a hung call hold
    // the slot and never deliver an outcome at all.
    let finished = false
    const inflight = this.#provider.evaluate(run.request, { signal: local.signal })
    // `closed` counts as cancellation, not as a deadline miss.
    inflight.then(
      () => { if (finished) this.#onDiagnostic({ key: run.key, kind: signal.aborted || this.#closed ? 'cancelled-after-answer' : 'timeout-after-answer' }) },
      () => { if (finished) this.#onDiagnostic({ key: run.key, kind: signal.aborted || this.#closed ? 'cancelled-after-error' : 'timeout-after-error' }) },
    )
    const abortRace = new Promise<'aborted'>(resolve => {
      if (local.signal.aborted) resolve('aborted')
      else local.signal.addEventListener('abort', () => resolve('aborted'), { once: true })
    })

    try {
      const raced = await Promise.race([
        inflight.then(r => ({ kind: 'response' as const, response: r })),
        abortRace,
      ])
      if (raced === 'aborted') {
        finished = true
        // Shutdown and caller cancellation are cancellations, not deadline misses.
        const stopped = signal.aborted || this.#closed
        const outcome: CoordinatorOutcome = stopped ? { kind: 'cancelled' } : { kind: 'timed-out', stage: 'inference' }
        run.to(stopped ? 'cancelled' : 'timed_out').to('recorded')
        this.#settled.add(run.key)
        return outcome
      }
      finished = true
      const response = raced.response
      run.to('observed').to('validated')
      const code = combineCodes(response)
      if (response.status === 'failed') {
        run.to('failed').to('recorded')
        this.#settled.add(run.key)
        return { kind: 'failed', code: code ?? 'PROVIDER_ERROR' }
      }
      this.#settled.add(run.key)
      return { kind: 'response', response, application: this.#guard(run) }
    } catch {
      finished = true
      const stopped = signal.aborted || this.#closed
      if (stopped) run.to('cancelled')
      else if (local.signal.aborted) run.to('timed_out')
      else run.to('failed')
      run.to('recorded')
      this.#settled.add(run.key)
      return stopped ? { kind: 'cancelled' } : local.signal.aborted ? { kind: 'timed-out', stage: 'inference' } : { kind: 'failed', code: 'PROVIDER_ERROR' }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      this.#release()
      this.#pump()
    }
  }

  #guard(run: Run): GuardedApplication {
    let consumed = false
    return {
      get phase(): Phase {
        return run.phase
      },
      apply: (current: SnapshotRef, host: HostDecision, policy: PolicyDecision): ApplicationResult => {
        if (consumed || isClosed(run.phase) && run.phase !== 'validated') return { kind: 'already-applied' }
        // Freshness is judged against what was captured for this run, not against the
        // snapshot the provider claims to have answered for.
        if (!isFresh(run.request.snapshot, current)) {
          run.to('stale').to('recorded')
          return { kind: 'stale' }
        }
        consumed = true
        run.to('policy_applied').to('recorded')
        return { kind: 'applied', decision: combineHostAndJey(host, policy.action) }
      },
    }
  }

  /** Stop admitting, abort what is in flight, drain nothing new. */
  async close(): Promise<void> {
    this.#closed = true
    let waiter = this.#nextWaiter()
    while (waiter !== undefined) {
      this.#abortWaiter(waiter)
      waiter = this.#nextWaiter()
    }
    // Stop admitting, then abort what is in flight, then close the provider.
    for (const control of this.#localControls) control.abort(new Error('jey-closing'))
    this.#localControls.clear()
    await this.#provider.close()
  }
}
