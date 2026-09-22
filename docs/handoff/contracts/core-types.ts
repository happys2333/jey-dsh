/** Proposed ADL v1 contracts, not DSH APIs. No runtime implementation here. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Purpose = 'tool-assessment' | 'tool-relevance' | 'evidence-check' | 'explicit-query';
export type Mode = 'off' | 'shadow' | 'enforce';
export type ProviderKind = 'mock' | 'local' | 'typesafe';
export type DecisionAction = 'abstain' | 'ask' | 'deny' | 'cancel';

/** Identifiers are minted by trusted code, not used as authorization tokens. */
export interface SnapshotRef {
  readonly sessionId: string;
  readonly agentId: string;
  readonly turn: number;
  readonly step: number;
  readonly generation: number;
  readonly taskVersion: number;
  readonly policyVersion: string;
  readonly catalogDigest: string;
  readonly callDigest: string | null;
  readonly observationSequence: number;
}

/** ADL intentionally starts with string instructions: a subset of provider APIs. */
export type Question =
  | { readonly kind: 'boolean'; readonly id: string; readonly instructions: string }
  | { readonly kind: 'choice'; readonly id: string; readonly instructions: string;
      readonly options: readonly { readonly id: string; readonly description: string }[] }
  | { readonly kind: 'score'; readonly id: string; readonly instructions: string;
      readonly levels: readonly string[] };

export interface DecisionRequest {
  readonly schemaVersion: '1';
  readonly requestId: string;
  readonly purpose: Purpose;
  readonly snapshot: SnapshotRef;
  readonly state: JsonValue;
  readonly questions: readonly Question[];
  readonly budget: { readonly maxElapsedMs: number; readonly maxInputBytes: number };
}

export type Distribution = Readonly<Record<string, number>>;
export interface ProbabilityMetadata {
  readonly origin: 'native-logits' | 'provider-distribution' | 'synthetic';
  readonly calibration: 'uncalibrated' | 'provider-reported' | 'held-out';
  readonly calibrationId: string | null;
  readonly providerConfidence?: number;
}

/** Original probabilities remain available; never overwrite them during calibration. */
export type Answer =
  | { readonly kind: 'boolean'; readonly pYes: number; readonly calibratedPYes?: number;
      readonly probability: ProbabilityMetadata }
  | { readonly kind: 'choice'; readonly selected: string; readonly probabilities: Distribution;
      readonly calibratedProbabilities?: Distribution; readonly probability: ProbabilityMetadata }
  | { readonly kind: 'score'; readonly expectedIndex: number; readonly levels: readonly string[];
      readonly probabilities: Distribution; readonly calibratedProbabilities?: Distribution;
      readonly probability: ProbabilityMetadata };

export type ErrorCode = 'INVALID_INPUT' | 'UNSUPPORTED_CAPABILITY' | 'AUTH' | 'RATE_LIMIT'
  | 'OVERLOADED' | 'TIMEOUT' | 'CANCELLED' | 'QUEUE_FULL' | 'BUDGET_EXCEEDED'
  | 'INVALID_RESPONSE' | 'INSUFFICIENT_CONTEXT' | 'STALE_SNAPSHOT' | 'LOCAL_NOT_READY' | 'EGRESS_DENIED';

export type QuestionOutcome =
  | { readonly id: string; readonly status: 'answered'; readonly answer: Answer }
  | { readonly id: string; readonly status: 'abstained';
      readonly reason: 'insufficient-evidence' | 'unsupported' | 'uncertain' }
  | { readonly id: string; readonly status: 'error'; readonly code: ErrorCode;
      readonly retryable: boolean };

export interface ProviderIdentity {
  readonly kind: ProviderKind;
  readonly providerVersion: string;
  readonly requestedModel: string;
  readonly resolvedModel: string;
  readonly modelRevision: string | null;
  readonly weightsDigest: string | null;
  readonly tokenizerRevision: string | null;
  readonly templateDigest: string;
  readonly quantization: string | null;
  readonly synthetic: boolean;
}

export interface DecisionResponse {
  readonly schemaVersion: '1';
  readonly requestId: string;
  readonly snapshot: SnapshotRef;
  readonly status: 'ok' | 'partial' | 'failed';
  readonly provider: ProviderIdentity;
  readonly outcomes: readonly QuestionOutcome[];
  readonly timing: { readonly queueMs: number; readonly inferenceMs: number; readonly totalMs: number };
  readonly usage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly costUsd: number | null;
    readonly costBasis: 'reported' | 'estimated' | 'unknown';
  };
  readonly egress: { readonly occurred: boolean; readonly destinationId: string | null };
}

/** Wire responses are observations. Only in-process trusted policy returns this. */
export interface PolicyDecision {
  readonly action: DecisionAction;
  readonly reasonCodes: readonly string[];
  readonly requiredQuestionIds: readonly string[];
  readonly observationRequestId: string | null;
  readonly appliesTo: SnapshotRef;
}

/** Each adapter maps its host's decisions to this domain before combining. */
export type HostDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'ask'; readonly reason?: string }
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'cancel' };

export interface ProviderCapabilities {
  readonly provider: ProviderIdentity;
  readonly questionKinds: readonly Question['kind'][];
  readonly maxInputBytes: number;
  readonly maxQuestions: number;
  readonly cancellation: 'cooperative' | 'discard-only';
}

export interface DecisionProvider {
  capabilities(): Promise<ProviderCapabilities>;
  evaluate(request: DecisionRequest, context: { readonly signal: AbortSignal }): Promise<DecisionResponse>;
  close(): Promise<void>;
}
