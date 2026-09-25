import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Context, Events } from '@deepseek-ai/cordis'
import type {
  DecisionProvider, DecisionRequest, ErrorCode, HostDecision, JsonValue, PolicyDecision, QuestionOutcome, SnapshotRef,
} from 'jey-contracts'
import {
  AuditJournal, DecisionCoordinator, EMPTY_PROGRESS, assessmentState, buildSnapshot, checkEgress,
  compileAssessment, evaluatePolicy, fitToBudget, loadConfig, mintAuditId, observeCall, sha256, shouldBlockDispatch,
  type AuditEvent, type HostCapabilities, type JeyConfig, type LineSink, type ProgressStore, type StateSection,
} from 'jey-core'
import { MockProvider } from './providers/mock.ts'
import { ExpectedProvider } from './identity.ts'
import { TypesafeProvider } from 'jey-provider-typesafe'
import { LocalProvider } from 'jey-provider-local'

/**
 * Jey as a DSH plugin: the only place in this repository that imports the host.
 *
 * Ordering follows the host contract rather than wishful thinking. `tools/pre-execute`
 * is a waterfall, so the host's own decision is whatever `next()` returns and our action
 * is combined onto it (spec 7.2 table 1). The synchronous `guard()` never touches the
 * network: it reads only facts that already exist, which is also what makes its denial
 * something a later waterfall listener cannot talk past.
 */

/** DSH's `PreToolDecision` and Jey's `HostDecision` are the same four shapes. */
function toPreTool(decision: HostDecision) {
  switch (decision.kind) {
    case 'allow': return { kind: 'allow' } as const
    case 'ask': return decision.reason === undefined ? { kind: 'ask' } as const : { kind: 'ask', reason: decision.reason } as const
    case 'deny': return { kind: 'deny', reason: decision.reason } as const
    case 'cancel': return { kind: 'cancel' } as const
  }
}

function fromPreTool(decision: { readonly kind: 'allow' | 'deny' | 'cancel' | 'ask'; readonly reason?: string }): HostDecision {
  if (decision.kind === 'deny') return { kind: 'deny', reason: decision.reason ?? 'denied by host' }
  if (decision.kind === 'ask') return decision.reason === undefined ? { kind: 'ask' } : { kind: 'ask', reason: decision.reason }
  if (decision.kind === 'cancel') return { kind: 'cancel' }
  return { kind: 'allow' }
}

/** Collect text blocks out of a host message without assuming its exact shape. */
function textOf(value: unknown, limit = 400): string {
  const parts: string[] = []
  const walk = (node: unknown): void => {
    if (parts.join(' ').length >= limit || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    const record = node as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
    Object.values(record).forEach(walk)
  }
  walk(value)
  return parts.join(' ').slice(0, limit)
}

export interface FileSinkOptions {
  readonly path: string
  readonly maxFileBytes: number
}

/**
 * Append-only diagnostics. Rotation renames rather than truncates so a concurrent
 * reader is not pulled out from under, and a failed write surfaces through the journal's
 * counters instead of being swallowed.
 */
export function fileLineSink(options: FileSinkOptions): LineSink {
  let known = 0
  const onDisk = (): number => {
    try {
      return statSync(options.path).size
    } catch {
      return 0
    }
  }
  return {
    writeLine(line: string): void {
      if (known === 0) known = onDisk()
      const cost = Buffer.byteLength(line, 'utf8') + 1
      if (known + cost > options.maxFileBytes) {
        try {
          renameSync(options.path, `${options.path}.${Date.now()}.old`)
        } catch {
          /* nothing to rotate yet */
        }
        known = 0
      }
      mkdirSync(dirname(options.path), { recursive: true })
      appendFileSync(options.path, `${line}\n`, 'utf8')
      known += cost
    },
  }
}

const stderrSink: LineSink = {
  writeLine(line) {
    process.stderr.write(`jey-audit ${line}\n`)
  },
}

/**
 * Where diagnostics go when nothing was injected. An explicit path wins over stderr
 * because a plugin that writes to a hostile terminal's stderr is not really auditing
 * anything. The path comes from the environment, never from a model-visible setting.
 */
function defaultSink(config: JeyConfig): LineSink {
  const path = process.env.JEY_AUDIT_PATH
  if (path === undefined || path === '') return stderrSink
  return fileLineSink({ path, maxFileBytes: config.audit.maxFileBytes })
}

export interface JeyMountDeps {
  readonly provider: DecisionProvider
  readonly audit?: LineSink
  readonly now?: () => number
}

export interface JeyRuntime {
  readonly config: JeyConfig
  readonly generation: number
  records: readonly AuditEvent[]
  progress: ProgressStore
  /** Set once an audit write fails while the configuration requires auditing. */
  auditBlocked: boolean
  dispose(): Promise<void>
  close(): void
}

/** One plugin instance is one generation, so a hot-swap invalidates everything in flight. */
let generationCounter = 0

/**
 * Build the decision machinery and attach it to a live DSH context. Exported separately
 * from {@link apply} so a host test can supply a provider and a captured audit sink;
 * `apply` itself cannot, because cordis only ever passes it the config block.
 */
export function mountJey(ctx: Context, raw: unknown, deps: JeyMountDeps): JeyRuntime {
  const now = deps.now ?? (() => Date.now())
  const capabilities = (): HostCapabilities => ({
    // The host resolves an `ask` through this seam opportunistically; a deployment that
    // composes no ApprovalService degrades to denial, so claiming an approval channel we
    // cannot see would be a lie about a protection.
    approvalChannel: ctx.get('approval') !== undefined,
    scopedRestrict: true,
    postExecuteWaterfall: true,
  })

  const config = loadConfig(raw, capabilities())
  const generation = ++generationCounter
  const policyVersion = `sha256:${sha256(JSON.stringify({ config, generation }))}`
  const journal = new AuditJournal(deps.audit ?? defaultSink(config), {
    maxRetainedEvents: config.audit.retainedEvents,
    maxLineBytes: config.audit.maxFileBytes,
    now,
  })
  const coordinator = new DecisionCoordinator(deps.provider, {
    limits: {
      maxConcurrent: config.limits.maxConcurrent,
      maxQueue: config.limits.maxQueue,
      deadlineMs: config.limits.deadlineMs,
      perTurnCalls: config.limits.perTurnCalls,
      perSessionCalls: config.limits.perSessionCalls,
      // Fairness, not a user knob: one session may not queue more than the host can run
      // at once, otherwise a single chatty agent starves every other one.
      maxQueuePerSession: Math.max(1, config.limits.maxConcurrent),
    },
    now,
    onDiagnostic: event => {
      journal.emit({ kind: 'diagnostic', auditId: mintAuditId(), requestId: event.key, sessionId: '', reason: event.kind, at: now() })
    },
  })

  const records: AuditEvent[] = []
  let sequence = 0
  let position = { turn: 0, step: 0 }
  let goalText: string | null = null
  let goalSeen = false
  // Deliberately global: any advertised-tool change anywhere raises the digest, so an
  // unrelated agent's catalog change can only ever invalidate a pending decision, never
  // wrongly confirm one. Per-scope digests need a host identity we cannot see at assemble
  // time; that is recorded as a known gap rather than papered over.
  let catalogDigest = `sha256:${sha256('[]')}`
  const conversation: { readonly role: string; readonly text: string }[] = []
  const recentResults: { readonly toolName: string; readonly status: string }[] = []
  const HISTORY_CAP = 40

  const runtime = {
    config,
    generation,
    records,
    progress: EMPTY_PROGRESS,
    dispose: async () => coordinator.close(),
    // `close` is a hoisted function declaration further down; it refers to listeners that
    // do not exist yet here, which is fine because it only ever runs on teardown.
    close,
    auditBlocked: false,
  }

  function snapshot(args: {
    readonly agentId: string
    readonly toolName: string
    readonly arguments: JsonValue
    readonly approvalChannel: boolean
  }): { readonly ref: SnapshotRef; readonly request: DecisionRequest; readonly fields: readonly string[]; readonly truncated: readonly string[]; readonly neededBytes: number | null } {
    // §5.2 order: hard policy and this call first, then recent results, then conversation.
    // Cutting happens at JSON boundaries and every removal is recorded on the snapshot.
    const sections: StateSection[] = [
      { id: 'policy', kind: 'policy', value: { mode: config.mode, constraints: [] as string[] } },
      { id: 'call', kind: 'current-call', value: assessmentState({ toolName: args.toolName, frozenArguments: args.arguments, goal: goalText, constraints: [] }) },
      { id: 'results', kind: 'recent-result', value: recentResults.slice(-5) },
      { id: 'chat', kind: 'conversation', value: conversation.slice(-12) },
    ]
    const fit = fitToBudget(sections, config.limits.maxStateBytes)
    const built = buildSnapshot({
      sessionId: args.agentId,
      agentId: args.agentId,
      turn: position.turn,
      step: position.step,
      generation,
      policyVersion,
      taskVersion: goalSeen ? 1 : 0,
      task: {
        initialGoal: goalText,
        currentSubgoal: goalText,
        constraints: [],
        latestRevisionEvent: null,
        // No visible user requirement is recorded as unknown, never as "the user set no
        // limits" (spec 5.1).
        requirementsUnavailable: !goalSeen,
      },
      catalog: [{ name: args.toolName, schemaDigest: catalogDigest }],
      call: { toolName: args.toolName, frozenArguments: args.arguments, executionToken: args.agentId, observationSequence: sequence },
      recentResults: recentResults.slice(-5),
      observationSequence: sequence,
      truncated: fit.ok ? fit.omissions.map(o => o.path) : [`insufficient:${fit.code}`],
    })
    const request: DecisionRequest = {
      schemaVersion: '1',
      requestId: `req_${randomUUID()}`,
      purpose: 'tool-assessment',
      snapshot: built.ref,
      state: fit.ok ? fit.state : {},
      questions: compileAssessment(),
      budget: { maxElapsedMs: config.limits.deadlineMs, maxInputBytes: config.limits.maxStateBytes },
    }
    return {
      ref: built.ref,
      request,
      fields: fit.ok ? Object.keys(fit.state) : [],
      truncated: built.facts.truncated,
      neededBytes: fit.ok ? null : fit.neededBytes,
    }
  }

  /**
   * Record what happened. `observation` is null on every path that never reached a
   * provider, which is exactly the case a fabricated "answer" would otherwise disguise.
   */
  function record(input: {
    readonly request: DecisionRequest
    readonly ref: SnapshotRef
    readonly reasonCodes: readonly string[]
    readonly action: AuditEvent['action']
    readonly hostDecision: HostDecision | null
    readonly observation: { providerKind: AuditEvent['providerKind']; model: string; templateDigest: string; synthetic: boolean; egress: boolean; statuses: AuditEvent['questionStatuses']; timing: AuditEvent['timing'] } | null
    readonly stale?: boolean
    readonly truncatedPaths: readonly string[]
  }): void {
    const event: AuditEvent = {
      kind: 'decision',
      auditId: mintAuditId(),
      requestId: input.request.requestId,
      sessionId: input.ref.sessionId,
      agentId: input.ref.agentId,
      providerKind: input.observation?.providerKind ?? 'mock',
      synthetic: input.observation?.synthetic ?? true,
      resolvedModel: input.observation?.model ?? 'not-called',
      templateDigest: input.observation?.templateDigest ?? 'sha256:none',
      snapshot: input.ref,
      timing: input.observation?.timing ?? { queueMs: 0, inferenceMs: 0, totalMs: 0 },
      questionStatuses: input.observation?.statuses ?? input.request.questions.map(q => ({ id: q.id, status: 'error' as const })),
      action: input.action,
      reasonCodes: [...input.reasonCodes],
      hostDecision: input.hostDecision?.kind ?? null,
      execution: null,
      failureCode: null,
      egressOccurred: input.observation?.egress ?? false,
      stale: input.stale ?? false,
      truncatedPaths: input.truncatedPaths,
      at: now(),
    }
    records.push(event)
    const written = journal.emit(event)
    if (shouldBlockDispatch(config.audit.onFailure, written)) {
      runtime.auditBlocked = true
    }
  }

  const hardRules = (toolName: string): string[] => {
    const violations: string[] = []
    if (config.features.toolAssessment && config.mode === 'enforce' && !config.features.toolAssessment) violations.push('assessment-disabled')
    const paused = Object.entries(runtime.progress).find(([key, state]) => state.paused && key.includes(toolName))
    if (paused !== undefined) violations.push(`path-paused:${paused[0].slice(0, 24)}`)
    return violations
  }

  const errorOutcomes = (request: DecisionRequest, code: ErrorCode): readonly QuestionOutcome[] =>
    request.questions.map(q => ({ id: q.id, status: 'error' as const, code, retryable: false }))

  const onAssemble: Events['system-prompt/assemble'] = async (assembly, _context, next) => {
    const result = await next()
    catalogDigest = `sha256:${sha256(JSON.stringify(result.tools))}`
    return result
  }

  const onPreStep: Events['agent/pre-step'] = async (payload, next) => {
    position = { turn: payload.turn, step: payload.step }
    sequence += 1
    return next()
  }

  const onInbox: Events['agent/inbox/inserted'] = payload => {
    const text = textOf(payload.message)
    if (text.length > 0) {
      goalText = text
      goalSeen = true
      conversation.push({ role: 'user', text })
      if (conversation.length > HISTORY_CAP) conversation.shift()
    }
  }

  const onPreExecute: Events['tools/pre-execute'] = async (exec, next) => {
    const host = fromPreTool(await next())
    if (config.mode === 'off' || exec.signal.aborted) return toPreTool(host)

    const agentId = exec.agent?.id ?? 'agentless'
    const approvalChannel = exec.agent !== undefined && ctx.get('approval') !== undefined
    const { ref, request, fields, truncated, neededBytes } = snapshot({
      agentId,
      toolName: exec.name,
      arguments: exec.arguments as JsonValue,
      approvalChannel,
    })
    const violations = hardRules(exec.name)

    if (neededBytes !== null) {
      // The call's own arguments did not fit. Trimming them and answering anyway would
      // be a verdict about text the provider never saw (spec 5.2).
      const policy = evaluatePolicy({ mode: config.mode, host, approvalChannel, outcomes: errorOutcomes(request, 'INSUFFICIENT_CONTEXT') })
      record({ request, ref, truncatedPaths: truncated, reasonCodes: [`insufficient-context:${neededBytes}`, ...policy.reasonCodes], action: policy.action, hostDecision: host, observation: null })
      return toPreTool(policy.combined)
    }

    if (violations.length > 0) {
      // Deterministic rules hold regardless of mode, including shadow. `shadow` means a
      // model's opinion is observational only; a recorded fact about what already
      // happened needs no model and is not an opinion, and the synchronous guard denies
      // it too, so the two layers stay consistent instead of contradicting each other.
      const decision: HostDecision = host.kind === 'deny' || host.kind === 'cancel'
        ? host
        : { kind: 'deny', reason: `jey: ${violations.join(', ')}` }
      const policy = evaluatePolicy({ mode: config.mode, host, hardRuleViolations: violations, approvalChannel })
      record({ request, ref, truncatedPaths: truncated, reasonCodes: policy.reasonCodes, action: 'deny', hostDecision: host, observation: null })
      return toPreTool(decision)
    }

    if (runtime.auditBlocked) {
      const reason = 'jey: audit required but unwritable'
      record({ request, ref, truncatedPaths: truncated, reasonCodes: ['audit-blocked'], action: 'deny', hostDecision: host, observation: null })
      return { kind: 'deny', reason }
    }

    // Egress governs bytes that leave the process. A mock provider answers from memory, so
    // running its answers past an origin allowlist would be guarding nothing — and would
    // make the offline engineering gates impossible to reach at all.
    const touchesNetwork = config.provider.kind === 'local' || config.provider.kind === 'typesafe'
    const egress = touchesNetwork
      ? checkEgress(
        {
          mode: config.egress.mode,
          localOrigins: config.egress.allowedOrigins ?? [],
          destinations: config.egress.destinations ?? [],
        },
        {
          providerKind: config.provider.kind,
          destinationId: config.egress.destinations?.find(d => d.endpoint === config.provider.typesafe?.endpointOrigin)?.id ?? null,
          endpoint: config.provider.local?.endpoint ?? config.provider.typesafe?.endpointOrigin ?? null,
          purpose: request.purpose,
          fields,
          credentialConfigured: config.provider.typesafe?.credentialRef !== undefined || config.provider.local?.tokenRef !== undefined,
          providerExplicitlySelected: true,
        },
      )
      : ({ allowed: true, destinationId: 'in-process' } as const)
    if (!egress.allowed) {
      const policy = evaluatePolicy({
        mode: config.mode, host, approvalChannel, outcomes: errorOutcomes(request, 'EGRESS_DENIED'),
      })
      record({ request, ref, truncatedPaths: truncated, reasonCodes: [...egress.reasons, ...policy.reasonCodes], action: policy.action, hostDecision: host, observation: null })
      return toPreTool(policy.combined)
    }

    const outcome = await coordinator.submit(request, { signal: exec.signal })
    if (outcome.kind !== 'response') {
      const code: ErrorCode = outcome.kind === 'failed'
        ? (outcome.code === 'PROVIDER_ERROR' ? 'INVALID_RESPONSE' : outcome.code)
        : outcome.kind === 'cancelled' ? 'CANCELLED' : 'TIMEOUT'
      const policy = evaluatePolicy({ mode: config.mode, host, approvalChannel, outcomes: errorOutcomes(request, code) })
      const why = outcome.kind === 'failed' ? `provider:${outcome.code}` : `coordinator:${outcome.kind}`
      record({ request, ref, truncatedPaths: truncated, reasonCodes: [why, ...policy.reasonCodes], action: policy.action, hostDecision: host, observation: null })
      return toPreTool(policy.combined)
    }

    const response = outcome.response
    const policy = evaluatePolicy({
      mode: config.mode,
      host,
      approvalChannel,
      hardRuleViolations: [],
      outcomes: response.outcomes,
      snapshotFresh: true,
      calibrationAvailable: config.calibration !== undefined,
      ...(config.calibration === undefined ? {} : {
        thresholds: {
          conflictAskAtOrAbove: config.calibration.conflictAskAtOrAbove,
          conflictDenyAtOrAbove: config.calibration.conflictDenyAtOrAbove,
          goalBelow: config.calibration.goalBelow,
          evidenceBelow: config.calibration.evidenceBelow,
        },
      }),
    })
    const observation = {
      providerKind: response.provider.kind,
      model: response.provider.resolvedModel,
      templateDigest: response.provider.templateDigest,
      synthetic: response.provider.synthetic,
      egress: response.egress.occurred,
      statuses: response.outcomes.map(o => ({ id: o.id, status: o.status })),
      timing: response.timing,
    }

    const applied: PolicyDecision = {
      action: policy.action,
      reasonCodes: policy.reasonCodes,
      requiredQuestionIds: request.questions.map(q => q.id),
      observationRequestId: request.requestId,
      appliesTo: ref,
    }
    // Synchronous, single-shot: the freshness re-check and the consumption of the
    // decision happen with no await between them (spec 10.1).
    const resolution = outcome.application.apply(ref, host, applied)
    if (resolution.kind === 'stale') {
      const fallback: HostDecision = approvalChannel
        ? { kind: 'ask', reason: 'jey: snapshot stale' }
        : { kind: 'deny', reason: 'jey: snapshot stale' }
      record({ request, ref, truncatedPaths: truncated, reasonCodes: ['stale-snapshot', ...policy.reasonCodes], action: policy.action, hostDecision: host, observation, stale: true })
      return toPreTool(host.kind === 'deny' || host.kind === 'cancel' ? host : fallback)
    }
    if (resolution.kind === 'already-applied') {
      record({ request, ref, truncatedPaths: truncated, reasonCodes: ['already-applied'], action: 'abstain', hostDecision: host, observation })
      return toPreTool(host)
    }
    record({ request, ref, truncatedPaths: truncated, reasonCodes: policy.reasonCodes, action: policy.action, hostDecision: host, observation })
    return toPreTool(resolution.decision)
  }

  // Network-free by construction: nothing here may await, so it can only speak about
  // facts the plugin already holds.
  const guardOff = ctx.tools.guard(execution => {
    const hit = Object.entries(runtime.progress).find(([key, state]) => state.paused && key.includes(execution.name))
    return hit === undefined ? undefined : `jey: repeated identical failure on "${execution.name}"`
  })

  const resultOff = ctx.on('tools/result', (exec, result) => {
    sequence += 1
    recentResults.push({ toolName: exec.name, status: result.isError ? 'failed' : 'succeeded' })
    if (recentResults.length > HISTORY_CAP) recentResults.shift()
    runtime.progress = observeCall(runtime.progress, {
      toolName: exec.name,
      normalizedArguments: exec.arguments as JsonValue,
      status: result.isError ? 'failure' : 'success',
      deterministicError: null,
      resourceVersions: {},
      rootCallId: exec.rootCallId ?? null,
      isPoll: false,
      observationSequence: sequence,
    }, {
      maxIdenticalFailures: config.limits.maxIdenticalFailures,
      pollBudget: config.limits.pollBudget,
    }).store
  })

  const disposers = [
    ctx.on('system-prompt/assemble', onAssemble),
    ctx.on('agent/pre-step', onPreStep),
    ctx.on('agent/inbox/inserted', onInbox),
    ctx.on('tools/pre-execute', onPreExecute),
  ]

  function close(): void {
    for (const dispose of disposers) dispose()
    guardOff()
    resultOff()
    void coordinator.close()
  }

  return runtime
}

/**
 * The cordis entry point. Everything it needs that a `cordis.yml` block cannot express is
 * derived from the validated config, so a deployment can never inject a provider the
 * config did not name.
 */
export function apply(ctx: Context, config: unknown): void {
  ctx.effect(() => {
    // Constructing the provider outside the validated config path would let a bad
    // config install and then abstain forever, so any refusal here throws at load.
    const runtime = mountJey(ctx, config, { provider: providerFor(config) })
    return () => runtime.close()
  })
}

/**
 * Resolve a credential *reference*. A bare key never appears in config, and no provider
 * reads an environment variable on its own initiative: `env:NAME` must be written out.
 */
export function resolveCredential(reference: string | undefined): string | undefined {
  if (reference === undefined) return undefined
  const separator = reference.indexOf(':')
  if (separator < 0) return undefined
  const scheme = reference.slice(0, separator)
  const rest = reference.slice(separator + 1)
  if (scheme === 'env') return process.env[rest]
  if (scheme === 'file') {
    try {
      return readFileSync(rest, 'utf8').trim()
    } catch {
      return undefined
    }
  }
  // `keystore:` and anything else are unwired; returning undefined makes the provider
  // refuse the request instead of sending it unauthenticated.
  return undefined
}

/** Built from the raw config so a rejected config never reaches a provider constructor. */
function providerFor(raw: unknown): DecisionProvider {
  const config = raw as Partial<JeyConfig>
  const provider = config.provider
  if (provider === undefined || provider.kind === 'unconfigured' || provider.kind === 'mock') return new MockProvider()
  if (provider.kind === 'local') {
    const local = provider.local
    if (local === undefined) throw new Error('jey: provider.kind=local without a local block')
    // External ownership only: Jey never launches, restarts, or downloads anything to
    // satisfy a decision. An unreachable service answers LOCAL_NOT_READY and the policy
    // layer escalates, rather than the plugin quietly failing open. And the checkpoint it
    // names has to be the one the operator pinned, checked before any state is sent.
    return new ExpectedProvider(
      new LocalProvider({ endpoint: local.endpoint, token: () => resolveCredential(local.tokenRef) }),
      local.expectedModel,
    )
  }
  if (provider.kind === 'typesafe') {
    const typesafe = provider.typesafe
    const destinationId = config.egress?.destinations?.find((d: { id: string; endpoint: string }) => d.endpoint === typesafe?.endpointOrigin)?.id ?? 'unaliased'
    return new TypesafeProvider({
      model: typesafe?.model ?? '',
      credential: () => resolveCredential(typesafe?.credentialRef),
      destinationId,
    })
  }
  throw new Error(`jey: no provider implementation for '${provider?.kind}'`)
}

export const name = 'jey'

/** Only `tools` is required; the approval seam is read opportunistically, as the host itself does. */
export const inject = ['tools']

export const jeyPlugin = { name, inject, apply }
