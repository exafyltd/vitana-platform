/**
 * VTID-02913 (B0d.1) — AssistantContinuation contract types.
 *
 * The Central Continuation Contract. Every assistant turn ends with EITHER
 * a continuation unit OR an explicit `none_with_reason` continuation that
 * records WHY nothing was offered. The decision is server-side, not a
 * prompt instruction — that's the whole point of this module.
 *
 * Scope (B0d.1):
 *   - Pure types + the `AssistantContinuationDecision` carrier.
 *   - No providers wired yet.
 *   - No instrumentation into orb-live.ts or ai-chat.
 *
 * Subsequent slices:
 *   - B0d.2 ships the first real provider (voice-wake-brief.ts) that
 *     replaces vitana-v1's passive instantGreeting line.
 *   - B0d.3 surfaces the per-decision `sourceProviderResults` + the new
 *     16-event ORB wake reliability timeline in the Command Hub.
 *   - B0d.4 wires the vitana-v1 frontend to consume continuations and
 *     emit the wake-side timeline events.
 *
 * The contract carrier (`AssistantContinuationDecision`) ALREADY carries
 * timing + provider evidence in B0d.1 so B0d.3 only populates + surfaces
 * — never reshapes the contract.
 */

// ---------------------------------------------------------------------------
// AssistantContinuation — the unit that the LLM-facing layer renders into
// the prompt / SSE payload / spoken line.
// ---------------------------------------------------------------------------

/**
 * Surface where a continuation is rendered. Different surfaces have
 * different pacing rules + presentation styles:
 *   - `orb_wake`       — first spoken words after ORB activation.
 *   - `orb_turn_end`   — appended to every assistant voice response.
 *   - `text_turn_end`  — emitted as `proactive_followup` SSE event in ai-chat.
 *   - `home`           — DYK / morning-brief card on the home screen.
 */
export type ContinuationSurface =
  | 'orb_wake'
  | 'orb_turn_end'
  | 'text_turn_end'
  | 'home';

/**
 * Kind of continuation. `none_with_reason` is **first-class** — not a
 * fallback hack. A decision with `kind: 'none_with_reason'` flows
 * through the same return path as any other kind so the Continuation
 * Inspector can render WHY nothing fired.
 */
export type ContinuationKind =
  | 'wake_brief'
  | 'next_step'
  | 'did_you_know'
  | 'feature_discovery'
  | 'opportunity'
  | 'reminder'
  | 'check_in'
  | 'offer_to_continue'
  | 'journey_guidance'
  | 'match_journey_next_move'
  | 'none_with_reason';

/**
 * CTA shape — the action the orb will take if the user accepts the
 * continuation. Type-discriminated so renderers can switch on `type`
 * without runtime narrowing tricks.
 */
export type ContinuationCta =
  | { type: 'ask_permission'; payload?: Record<string, unknown> }
  | { type: 'navigate'; route: string; payload?: Record<string, unknown> }
  | { type: 'offer_demo'; payload?: Record<string, unknown> }
  | { type: 'run_tool'; toolName: string; payload?: Record<string, unknown> }
  | { type: 'explain'; payload?: Record<string, unknown> }
  | { type: 'noop' }; // for `none_with_reason`

/**
 * Privacy gate — controls whether the renderer is allowed to speak the
 * continuation aloud or must keep it silent. `safe_to_speak` is the
 * default; the others suppress audio.
 */
export type ContinuationPrivacyMode =
  | 'safe_to_speak'
  | 'use_silently'
  | 'suppress_sensitive';

/**
 * A piece of evidence that justifies a continuation. Renders into the
 * Continuation Inspector + into OASIS so operators can audit decisions.
 */
export interface ContinuationEvidence {
  /** What kind of evidence — e.g. `reminder_due`, `concept_unexplained`. */
  kind: string;
  /** Short human-readable description. */
  detail: string;
  /** Numeric weight used by the ranker. Optional. */
  weight?: number;
}

/**
 * The continuation unit itself. Returned by a provider and rendered into
 * the user-facing surface by `render-voice-continuation.ts` /
 * `render-text-continuation.ts` (those renderers ship in B0d.2+).
 */
export interface AssistantContinuation {
  /** Stable id; same across re-renders of the same logical continuation. */
  id: string;
  /** Where the continuation is rendered. */
  surface: ContinuationSurface;
  /** What kind. `none_with_reason` is a real kind, not a sentinel. */
  kind: ContinuationKind;
  /** Higher number = more important. Ranker uses this × situational fit. */
  priority: number;
  /** Already-rendered line in the user's language. Empty for `none_with_reason`. */
  userFacingLine: string;
  /** The CTA the orb will perform if the user accepts. */
  cta: ContinuationCta;
  /** Why this continuation was picked. Empty for `none_with_reason`. */
  evidence: ContinuationEvidence[];
  /** Stable key used to suppress repetition across turns. */
  dedupeKey: string;
  /** Optional ISO 8601 freshness window. */
  expiresAt?: string;
  /** Privacy gate. */
  privacyMode: ContinuationPrivacyMode;
  /**
   * REQUIRED when `kind === 'none_with_reason'`. Forbidden otherwise — a
   * real continuation does not carry a suppress reason.
   *
   * The type system can't enforce this conditional on the kind alone
   * without discriminated unions, so the runtime guard in
   * `makeNoneWithReason()` does the work.
   */
  suppressReason?: string;
}

// ---------------------------------------------------------------------------
// Provider — anything that can produce a candidate continuation OR
// suppress itself with a reason. B0d.1 ships the type only; concrete
// providers land in B0d.2+ (voice-wake-brief, feature-discovery, etc.).
// ---------------------------------------------------------------------------

export interface ContinuationDecisionContext {
  /** UUID of the live session if any. */
  sessionId?: string;
  /** UUID of the authenticated user if any. */
  userId?: string;
  /** UUID of the tenant if any. */
  tenantId?: string;
  /** Which surface is asking for a continuation. */
  surface: ContinuationSurface;
  /** `journeySurface` from ClientContextEnvelope, if known. */
  envelopeJourneySurface?: string;
  /** Free-form passthrough for future providers (kept loose by design). */
  extra?: Record<string, unknown>;
}

/**
 * Single provider's output. ALWAYS produces a row in
 * `AssistantContinuationDecision.sourceProviderResults` — even when the
 * provider suppressed itself or errored. This is what makes provider
 * results observable on no-fire paths (review check #3).
 */
export interface ProviderResult {
  providerKey: string;
  status: 'returned' | 'skipped' | 'suppressed' | 'errored';
  latencyMs: number;
  /** Required when status !== 'returned'. */
  reason?: string;
  /** Present only when status === 'returned'. */
  candidate?: AssistantContinuation;
}

/**
 * A continuation provider. Synchronous return is permitted but providers
 * may also be async (they often hit DB or call other services).
 */
export interface ContinuationProvider {
  /** Stable, lower-snake key. Used in telemetry + sourceProviderResults. */
  readonly key: string;
  /** Surfaces this provider services. Empty array = all surfaces. */
  readonly surfaces: ReadonlyArray<ContinuationSurface>;
  /**
   * Produce a candidate OR suppress with a reason. The provider should
   * NOT throw — return `status: 'errored'` + a reason instead. The
   * decide-continuation orchestrator will tolerate throws but unhandled
   * errors degrade observability.
   */
  produce(
    ctx: ContinuationDecisionContext,
  ): Promise<ProviderResult> | ProviderResult;
}

// ---------------------------------------------------------------------------
// AssistantContinuationDecision — the carrier returned by
// `decide-continuation`. All 7 fields are present in B0d.1; B0d.3 only
// populates + surfaces the timing + evidence fields.
// ---------------------------------------------------------------------------

export interface DecisionTelemetryContext {
  sessionId?: string;
  userId?: string;
  tenantId?: string;
  surface: ContinuationSurface;
  envelopeJourneySurface?: string;
}

/**
 * The output of `decide-continuation(...)`. Carries:
 *   1. `decisionId`            — uuid, one per decide call.
 *   2. `selectedContinuation`  — the picked unit, OR null on no-fire paths.
 *   3. `suppressionReason?`    — set when `selectedContinuation` is null
 *                                OR when its kind is `none_with_reason`.
 *   4. `decisionStartedAt`     — ISO 8601, decide-continuation entry.
 *   5. `decisionFinishedAt`    — ISO 8601, decide-continuation return.
 *   6. `sourceProviderResults` — one row per provider invoked.
 *   7. `telemetryContext`      — minimum context to correlate with OASIS
 *                                + the B0d.3 wake reliability timeline.
 */
export interface AssistantContinuationDecision {
  decisionId: string;
  selectedContinuation: AssistantContinuation | null;
  suppressionReason?: string;
  decisionStartedAt: string;
  decisionFinishedAt: string;
  sourceProviderResults: ProviderResult[];
  telemetryContext: DecisionTelemetryContext;
}

// ---------------------------------------------------------------------------
// Constructors — keep `none_with_reason` first-class and easy to produce
// correctly. Providers and tests use these to avoid hand-rolling
// inconsistent shapes.
// ---------------------------------------------------------------------------

/**
 * Build a `none_with_reason` continuation. This is the ONE place where
 * the unusual fields (empty userFacingLine, noop CTA, empty evidence)
 * are constructed so all suppressions look identical to downstream
 * consumers.
 */
export function makeNoneWithReason(args: {
  surface: ContinuationSurface;
  reason: string;
  dedupeKey: string;
  id?: string;
}): AssistantContinuation {
  if (!args.reason || args.reason.trim().length === 0) {
    throw new Error(
      'makeNoneWithReason: reason is required (cannot be empty string)',
    );
  }
  return {
    id: args.id ?? `none-${args.dedupeKey}`,
    surface: args.surface,
    kind: 'none_with_reason',
    priority: 0,
    userFacingLine: '',
    cta: { type: 'noop' },
    evidence: [],
    dedupeKey: args.dedupeKey,
    privacyMode: 'safe_to_speak',
    suppressReason: args.reason,
  };
}

/**
 * Type guard: is this continuation a suppression?
 */
export function isNoneWithReason(
  c: AssistantContinuation,
): c is AssistantContinuation & { suppressReason: string } {
  return c.kind === 'none_with_reason';
}
