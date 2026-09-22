import type { JsonValue, ProviderKind, Purpose } from 'jey-contracts'

/**
 * Egress policy, spec section 5.3. Installed locally, running in shadow, or
 * pointing at 127.0.0.1 are all *not* evidence of offline inference, so this module
 * is the only thing that decides whether a provider may be reached at all.
 */

export type EgressMode = 'deny' | 'local-only' | 'allowlist'

export interface Destination {
  readonly id: string
  readonly endpoint: string
  readonly purposes: readonly Purpose[]
  readonly fields: readonly string[]
}

export interface EgressConfig {
  readonly mode: EgressMode
  /** Exact origins a local scoring service may be reached on; loopback is not implied. */
  readonly localOrigins: readonly string[]
  readonly destinations?: readonly Destination[]
}

export interface EgressAttempt {
  readonly providerKind: ProviderKind
  readonly destinationId: string | null
  readonly endpoint: string | null
  readonly purpose: Purpose
  /** Top-level keys of the state that would actually leave the process. */
  readonly fields: readonly string[]
  readonly credentialConfigured: boolean
  readonly providerExplicitlySelected: boolean
}

export type EgressVerdict =
  | { readonly allowed: true; readonly destinationId: string }
  | { readonly allowed: false; readonly code: 'EGRESS_DENIED'; readonly reasons: readonly string[] }

const LOCAL_PROVIDERS: readonly ProviderKind[] = ['local']

function originOf(endpoint: string): string | null {
  try {
    return new URL(endpoint).origin
  } catch {
    return null
  }
}

/** Shadow mode obeys the same egress rules as enforce (§5.3). */
export function checkEgress(config: EgressConfig, attempt: EgressAttempt): EgressVerdict {
  const denied = (...reasons: string[]): EgressVerdict => ({ allowed: false, code: 'EGRESS_DENIED', reasons })

  if (config.mode === 'deny') return denied('egress-mode-deny')

  if (attempt.providerKind === 'mock') {
    return denied('mock-is-not-a-destination')
  }

  if (config.mode === 'local-only') {
    if (!LOCAL_PROVIDERS.includes(attempt.providerKind)) return denied('local-only-rejects-cloud-provider')
    return checkLocal(config, attempt)
  }

  // allowlist: cloud needs all five conditions at once, per §5.3.
  if (attempt.providerKind === 'local') return checkLocal(config, attempt)

  if (!attempt.providerExplicitlySelected) return denied('provider-not-explicitly-selected')
  if (!attempt.credentialConfigured) return denied('credential-not-configured')
  if (attempt.destinationId === null || attempt.endpoint === null) return denied('destination-not-named')

  const dest = (config.destinations ?? []).find(d => d.id === attempt.destinationId)
  if (dest === undefined) return denied(`destination-not-allowlisted:${attempt.destinationId}`)
  if (dest.endpoint !== attempt.endpoint) return denied('destination-endpoint-mismatch')
  if (!dest.purposes.includes(attempt.purpose)) return denied(`purpose-not-allowed:${attempt.purpose}`)

  const offending = attempt.fields.filter(f => !dest.fields.includes(f))
  if (offending.length > 0) return denied(`fields-not-allowed:${offending.join(',')}`)

  return { allowed: true, destinationId: dest.id }
}

function checkLocal(config: EgressConfig, attempt: EgressAttempt): EgressVerdict {
  if (attempt.endpoint === null) return { allowed: false, code: 'EGRESS_DENIED', reasons: ['local-endpoint-not-configured'] }
  const origin = originOf(attempt.endpoint)
  if (origin === null) return { allowed: false, code: 'EGRESS_DENIED', reasons: ['local-endpoint-not-a-url'] }
  if (!config.localOrigins.includes(origin)) {
    return { allowed: false, code: 'EGRESS_DENIED', reasons: [`local-origin-not-allowlisted:${origin}`] }
  }
  return { allowed: true, destinationId: `local:${origin}` }
}

/**
 * Keys a model must never be able to influence. §5.3: model parameters may not
 * name an endpoint, header, credential, model path or plugin configuration.
 */
export const CALLER_CONTROLLED_TRANSPORT_KEYS: readonly string[] = [
  'endpoint', 'baseUrl', 'base_url', 'url', 'uri', 'headers', 'apiKey', 'api_key',
  'token', 'authorization', 'credential', 'credentials', 'modelPath', 'model_path',
  'tokenizerPath', 'configPath', 'config_path', 'providerConfig',
]

/** Scan the state payload that would travel to a provider; report offending paths. */
export function findCallerControlledTransport(state: JsonValue, path = ''): string[] {
  if (Array.isArray(state)) {
    return state.flatMap((item, i) => findCallerControlledTransport(item, `${path}[${i}]`))
  }
  if (state === null || typeof state !== 'object') return []
  const hits: string[] = []
  for (const [key, value] of Object.entries(state)) {
    const here = path === '' ? key : `${path}.${key}`
    if (CALLER_CONTROLLED_TRANSPORT_KEYS.includes(key)) hits.push(here)
    hits.push(...findCallerControlledTransport(value as JsonValue, here))
  }
  return hits
}
