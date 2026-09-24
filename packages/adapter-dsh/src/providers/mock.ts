import type { DecisionProvider, DecisionRequest, DecisionResponse, ProviderCapabilities, QuestionOutcome } from 'jey-contracts'

/**
 * A synthetic provider, for the engineering gates only.
 *
 * It answers from a fixed table so a host test can prove the whole loop — snapshot,
 * request, observation, policy, host mapping, audit — without a model. It is never a
 * substitute for `local-qualified` or `cloud-qualified`: every response carries
 * `synthetic: true`, and the config layer refuses `enforce` together with `mock`
 * (spec 6.5), so it cannot quietly become a production decision-maker.
 */
export class MockProvider implements DecisionProvider {
  readonly seen: DecisionRequest[] = []
  calls = 0

  readonly answers: Record<string, number>
  readonly behaviour: 'answer' | 'fail' | 'abstain'

  // Explicit fields, not constructor parameter properties: Node's type stripping rejects those.
  constructor(answers: Record<string, number> = {}, behaviour: 'answer' | 'fail' | 'abstain' = 'answer') {
    this.answers = answers
    this.behaviour = behaviour
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      provider: this.identity(),
      questionKinds: ['boolean', 'choice', 'score'],
      maxInputBytes: 32_768,
      maxQuestions: 16,
      cancellation: 'cooperative',
    }
  }

  private identity() {
    return {
      kind: 'mock' as const,
      providerVersion: '0.0.0',
      requestedModel: 'mock-static',
      resolvedModel: 'mock-static',
      modelRevision: null,
      weightsDigest: null,
      tokenizerRevision: null,
      templateDigest: 'sha256:mock-template',
      quantization: null,
      synthetic: true,
    }
  }

  async evaluate(request: DecisionRequest, context: { readonly signal: AbortSignal }): Promise<DecisionResponse> {
    this.calls += 1
    this.seen.push(request)
    const started = Date.now()
    const base = {
      schemaVersion: '1' as const,
      requestId: request.requestId,
      snapshot: request.snapshot,
      provider: this.identity(),
      timing: { queueMs: 0, inferenceMs: 0, totalMs: Date.now() - started },
      usage: { inputTokens: null, outputTokens: null, costUsd: null, costBasis: 'unknown' as const },
      egress: { occurred: false, destinationId: null },
    }

    if (context.signal.aborted) {
      return {
        ...base, status: 'failed',
        outcomes: request.questions.map(q => ({ id: q.id, status: 'error' as const, code: 'CANCELLED' as const, retryable: false })),
      }
    }
    if (this.behaviour === 'fail') {
      return {
        ...base, status: 'failed',
        outcomes: request.questions.map(q => ({ id: q.id, status: 'error' as const, code: 'OVERLOADED' as const, retryable: true })),
      }
    }
    const outcomes: QuestionOutcome[] = request.questions.map(q => {
      if (this.behaviour === 'abstain') return { id: q.id, status: 'abstained' as const, reason: 'unsupported' as const }
      const pYes = this.answers[q.id] ?? 0.5
      return {
        id: q.id, status: 'answered' as const,
        answer: {
          kind: 'boolean' as const, pYes,
          probability: { origin: 'synthetic' as const, calibration: 'uncalibrated' as const, calibrationId: null },
        },
      }
    })
    return { ...base, status: 'ok', outcomes }
  }

  async close(): Promise<void> {}
}
