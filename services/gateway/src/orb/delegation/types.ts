/**
 * BOOTSTRAP-ORB-DELEGATION-SCAFFOLD: Types for AI-to-AI delegation layer.
 *
 * Vitana's orb is the conversational layer. When the user has connected their
 * own AI accounts (ChatGPT, Claude, Gemini public API, or future providers)
 * via the existing connector UI (VTID-02403 Phase 1 shipped credential
 * storage + verification), Vitana can silently route parts of a turn to one
 * of those AIs and speak the answer in Vitana's voice.
 *
 * Everything here is transport-agnostic (SSE + WebSocket both benefit).
 */

// -----------------------------------------------------------------------------
// Provider identity
// -----------------------------------------------------------------------------

/**
 * Internal provider IDs. We align with the existing `ai_assistant_credentials`
 * connector_id values where they exist:
 *   - 'chatgpt'  → OpenAI Chat Completions API
 *   - 'claude'   → Anthropic Messages API
 *   - 'google-ai' → Google AI Studio (the public generativelanguage.googleapis.com,
 *                   NOT the internal Vertex Live API that powers the orb itself)
 */
export type DelegationProviderId = 'chatgpt' | 'claude' | 'google-ai';

/**
 * Task classes — used by the delegation router to pick the best provider for
 * a given user intent when multiple are connected. Seeded with sensible
 * defaults per provider in providers/*; users can override via connector UI.
 */
export type DelegationStrength =
  | 'code'
  | 'reasoning'
  | 'creative'
  | 'factual'
  | 'summarization'
  | 'long_context'
  | 'vision'
  | 'multilingual';

// -----------------------------------------------------------------------------
// Session context passed to a delegation call
// -----------------------------------------------------------------------------

/**
 * Privacy levels for what Vitana sends to the external AI.
 *
 *   'public'        — question only; no Vitana context
 *   'contextual'    — question + last N turns of current session
 *   'memory-aware'  — question + relevant memory items (requires user opt-in
 *                     per provider)
 *
 * Default is 'public'. Per-provider setting lives on the connector record;
 * global kill switch lives on the user's profile.
 */
export type DelegationPrivacyLevel = 'public' | 'contextual' | 'memory-aware';

export interface DelegationContext {
  readonly userId: string;
  readonly tenantId: string;
  readonly sessionId: string;
  /** The question/utterance to forward. Should be self-contained. */
  readonly question: string;
  readonly taskClass?: DelegationStrength;
  /** If the user named a specific provider ("ask ChatGPT …"). */
  readonly providerHint?: DelegationProviderId;
  /** Runtime privacy level (overridden by connection setting if present). */
  readonly privacyLevel: DelegationPrivacyLevel;
  /** Two-letter language code for response normalization. */
  readonly lang: string;
  /** Optional recent turns — honoured only when privacyLevel ≥ 'contextual'. */
  readonly recentTurns?: Array<{ role: 'user' | 'assistant'; text: string }>;
  /** Optional memory snippets — honoured only when privacyLevel = 'memory-aware'. */
  readonly memorySnippets?: Array<{ text: string; source: string }>;
  /** For latency accounting. */
  readonly startedAt: number;
}

// -----------------------------------------------------------------------------
// Result shape
// -----------------------------------------------------------------------------

export interface DelegationUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

export interface DelegationResult {
  readonly text: string;
  readonly providerId: DelegationProviderId;
  readonly model: string;
  readonly usage: DelegationUsage;
  /** Latency from DelegationContext.startedAt to response complete. */
  readonly latencyMs: number;
  /** Optional structured data if the provider returned tool-like output. */
  readonly metadata?: Record<string, unknown>;
}

export type DelegationFailureReason =
  | 'no_credentials'
  | 'no_providers_connected'
  | 'budget_cap_exceeded'
  | 'provider_unauthorized'
  | 'provider_rate_limited'
  | 'provider_error'
  | 'provider_timeout'
  | 'network_error'
  | 'privacy_kill_switch'
  | 'scaffold_not_wired'; // emitted until Phase 7 providers land

export interface DelegationFailure {
  readonly reason: DelegationFailureReason;
  readonly message: string;
  readonly providerId?: DelegationProviderId;
  readonly httpStatus?: number;
}

export type DelegationOutcome =
  | { ok: true; result: DelegationResult }
  | { ok: false; failure: DelegationFailure };

// -----------------------------------------------------------------------------
// Provider adapter contract — one per AI provider
// -----------------------------------------------------------------------------

export interface ProviderCostRate {
  /** USD per 1M input tokens. */
  readonly input: number;
  /** USD per 1M output tokens. */
  readonly output: number;
}

export interface ProviderManifest {
  readonly providerId: DelegationProviderId;
  readonly displayName: string;
  readonly defaultModel: string;
  readonly availableModels: readonly string[];
  readonly strengths: readonly DelegationStrength[];
  readonly supportsStreaming: boolean;
  /** Per-model pricing for usage cost estimation. */
  readonly costRates: Record<string, ProviderCostRate>;
}

export interface ProviderAdapter {
  readonly manifest: ProviderManifest;

  /**
   * Execute a single turn against the provider. Must return within 15 s or
   * throw (delegation/execute wraps this in a timeout to guarantee the orb
   * voice session never stalls waiting on an external provider).
   */
  call(ctx: DelegationContext, apiKey: string, model: string): Promise<DelegationResult>;

  /**
   * Live credential verification. Called once on credential save (the
   * existing /verify route delegates here once Phase 7 wires it). Returns
   * `ok: false` for 401/403; `ok: true` + any provider-supplied user info
   * for 2xx.
   */
  verify(apiKey: string): Promise<{ ok: boolean; httpStatus: number; message?: string }>;
}

// -----------------------------------------------------------------------------
// Router decision
// -----------------------------------------------------------------------------

export interface DelegationDecision {
  readonly providerId: DelegationProviderId;
  readonly model: string;
  /** Why this provider was chosen — logged to OASIS for tuning. */
  readonly reason:
    | 'user_hint'
    | 'task_class_match'
    | 'only_connected'
    | 'fallback_default';
  readonly score?: number;
}
