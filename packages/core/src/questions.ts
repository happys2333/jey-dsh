import type { JsonValue, Question } from 'jey-contracts'

/**
 * Question compilation, spec sections 3.2, 7.1 and 8.1.
 *
 * Templates are fixed strings keyed by a version, and everything the host or a
 * user supplied goes in as *state data*. That split is the whole point: if task
 * text could be concatenated into an instruction, a user sentence would be able to
 * rewrite the semantic gate the gate exists to enforce.
 *
 * Each question carries exactly one meaning, because a compound question produces an
 * answer that cannot be attributed to either half.
 */

export const TEMPLATE_VERSION = 'jey-assessment-1'
export const RELEVANCE_TEMPLATE_VERSION = 'jey-relevance-1'

/** Question ids are part of the contract: policy reads them by name, not by order. */
export const ASSESSMENT_QUESTION_IDS = {
  advancesGoal: 'advances-goal',
  evidenceSufficient: 'evidence-sufficient',
  conflictsWithConstraint: 'conflicts-with-constraint',
} as const

const EVIDENCE_CLAUSE = 'Answer only from the evidence given in state. If the evidence does not settle it, abstain.'

const TEMPLATES: Readonly<Record<string, { kind: 'boolean'; instructions: string }>> = {
  [ASSESSMENT_QUESTION_IDS.advancesGoal]: {
    kind: 'boolean',
    instructions: `Does the described tool call move the stated user goal forward? ${EVIDENCE_CLAUSE}`,
  },
  [ASSESSMENT_QUESTION_IDS.evidenceSufficient]: {
    kind: 'boolean',
    instructions: `Is the given evidence sufficient to judge the described tool call? ${EVIDENCE_CLAUSE}`,
  },
  [ASSESSMENT_QUESTION_IDS.conflictsWithConstraint]: {
    kind: 'boolean',
    instructions: `Does the described tool call conflict with any constraint listed in state.constraints? ${EVIDENCE_CLAUSE}`,
  },
}

export interface AssessmentFacts {
  readonly toolName: string
  readonly frozenArguments: JsonValue
  readonly goal: string | null
  readonly constraints: readonly string[]
}

/**
 * The three execution-gate questions. Instructions depend on nothing but the
 * template version, so two calls of the same shape produce byte-identical questions
 * and any answer difference is attributable to `assessmentState` alone.
 */
export function compileAssessment(): readonly Question[] {
  return Object.entries(TEMPLATES).map(([id, template]) => ({
    kind: template.kind,
    id,
    instructions: template.instructions,
  }))
}

/** Where the facts actually go: as data, never as instruction text. */
export function assessmentState(facts: AssessmentFacts): Record<string, JsonValue> {
  return {
    goal: facts.goal,
    constraints: [...facts.constraints],
    call: { tool: facts.toolName, arguments: facts.frozenArguments },
  }
}

export interface RelevanceCandidate {
  readonly name: string
  readonly description: string
}

/**
 * Tool relevance is multi-label: "which of these are relevant" is not one
 * mutually-exclusive choice, so each candidate gets its own independent yes/no and
 * the caller ranks by the resulting probabilities.
 */
export function compileRelevance(candidates: readonly RelevanceCandidate[]): readonly Question[] {
  return candidates.map(c => ({
    kind: 'boolean' as const,
    id: `relevance:${c.name}`,
    instructions: `Would "${c.name}" plausibly help accomplish the goal in state? ${EVIDENCE_CLAUSE}`,
  }))
}

export class UnsupportedCapability extends Error {
  readonly code = 'UNSUPPORTED_CAPABILITY' as const
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedCapability'
  }
}

/**
 * Reject locally before shipping a request a provider cannot answer, rather than
 * letting the provider fail mid-call.
 */
export function assertSupported(
  questions: readonly Question[],
  capabilities: { questionKinds: readonly Question['kind'][]; maxQuestions: number; maxInputBytes: number },
  stateBytes: number,
): void {
  if (questions.length === 0) throw new UnsupportedCapability('no questions compiled')
  if (questions.length > capabilities.maxQuestions) {
    throw new UnsupportedCapability(`${questions.length} questions exceeds provider limit ${capabilities.maxQuestions}`)
  }
  for (const q of questions) {
    if (!capabilities.questionKinds.includes(q.kind)) {
      throw new UnsupportedCapability(`provider does not support question kind '${q.kind}'`)
    }
  }
  if (stateBytes > capabilities.maxInputBytes) {
    throw new UnsupportedCapability(`state of ${stateBytes} bytes exceeds limit ${capabilities.maxInputBytes}`)
  }
}
