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
 * Shared fields for every continuation kind. The discriminated union
 * below pairs this with the kind-specific suppressReason rule.
 */
interface ContinuationBase {
  /** Stable id; same across re-renders of the same logical continuation. */
  id: string;
  /** Where the continuation is rendered. */
  surface: ContinuationSurface;
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
}

/**
 * Every non-suppression continuation kind. Listed explicitly so the
 * discriminated-union branches stay exhaustive: a new kind added to the
 * ContinuationKind union must also be added here or it won't compile
 * against `AssistantContinuation`.
 */
export type NonSuppressionContinuationKind = Exclude<
  ContinuationKind,
  'none_with_reason'
>;

/**
 * The continuation unit. Discriminated union — `kind === 'none_with_reason'`
 * REQUIRES `suppressReason: string`; any other kind FORBIDS the field
 * (`?: never` makes TS reject the assignment at compile time).
 *
 * The runtime validator `validateContinuationCandidate()` enforces the
 * same invariant for provider outputs that bypass the type system via
 * `as any`. The orchestrator calls it on every returned candidate so
 * malformed providers downgrade to `status: 'errored'` instead of
 * silently passing through.
 */
export type AssistantContinuation =
  | (ContinuationBase & {
      kind: 'none_with_reason';
      suppressReason: string;
    })
  | (ContinuationBase & {
      kind: NonSuppressionContinuationKind;
      suppressReason?: never;
    });

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
 *
 * The compile-time check (`kind === 'none_with_reason'`) is sufficient
 * once the discriminated union is in place — TS knows the
 * `suppressReason: string` branch is selected. The runtime guard adds
 * defense against `as any`-bypassed inputs: a malformed candidate that
 * names `kind: 'none_with_reason'` but omits `suppressReason` returns
 * `false` here, so downstream renderers can't trust a missing value.
 */
export function isNoneWithReason(
  c: AssistantContinuation,
): c is Extract<AssistantContinuation, { kind: 'none_with_reason' }> {
  return (
    c.kind === 'none_with_reason' &&
    typeof (c as { suppressReason?: unknown }).suppressReason === 'string' &&
    ((c as { suppressReason: string }).suppressReason.trim().length > 0)
  );
}

// ---------------------------------------------------------------------------
// Runtime validator — defense for provider outputs that bypass the type
// system. Called by `decide-continuation.ts` on every returned candidate.
// Invariant failures become `status: 'errored'` results so malformed
// candidates never reach renderers.
// ---------------------------------------------------------------------------

/**
 * Set of all kinds known to the contract — used by the validator to
 * reject typo'd / unknown kinds before they reach the orchestrator's
 * ranker. Kept as a runtime constant so JS callers (e.g. ai-chat edge
 * function) can validate too.
 */
export const KNOWN_CONTINUATION_KINDS: ReadonlySet<ContinuationKind> = new Set<
  ContinuationKind
>([
  'wake_brief',
  'next_step',
  'did_you_know',
  'feature_discovery',
  'opportunity',
  'reminder',
  'check_in',
  'offer_to_continue',
  'journey_guidance',
  'match_journey_next_move',
  'none_with_reason',
]);

/**
 * Surfaces the orchestrator services. The validator rejects unknown
 * surface values so a typo'd `journeySurface` from a third-party
 * caller can't slip into the ranker.
 */
export const KNOWN_CONTINUATION_SURFACES: ReadonlySet<ContinuationSurface> = new Set<
  ContinuationSurface
>(['orb_wake', 'orb_turn_end', 'text_turn_end', 'home']);

/**
 * Privacy gates the renderer can honor. Unknown values are rejected so
 * a malformed value can't downgrade or upgrade the gate by accident.
 */
export const KNOWN_PRIVACY_MODES: ReadonlySet<ContinuationPrivacyMode> = new Set<
  ContinuationPrivacyMode
>(['safe_to_speak', 'use_silently', 'suppress_sensitive']);

/**
 * CTA types recognized by `render-voice-continuation.ts` /
 * `render-text-continuation.ts` (shipped in B0d.2+). Each type may
 * require additional fields (route for navigate, toolName for run_tool)
 * — the validator enforces those too.
 */
const KNOWN_CTA_TYPES: ReadonlySet<ContinuationCta['type']> = new Set<
  ContinuationCta['type']
>(['ask_permission', 'navigate', 'offer_demo', 'run_tool', 'explain', 'noop']);

export type CandidateValidation =
  | { ok: true }
  | { ok: false; reason: string };

function isNonEmptyTrimmedString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Validate a provider-returned candidate against the full
 * `AssistantContinuation` shape AND the kind-specific invariants:
 *
 *   - candidate is a non-null object
 *   - `kind`        ∈ KNOWN_CONTINUATION_KINDS
 *   - `id`          non-empty string
 *   - `surface`     ∈ KNOWN_CONTINUATION_SURFACES
 *   - `priority`    finite number
 *   - `userFacingLine` string (empty allowed for `none_with_reason`)
 *   - `dedupeKey`   non-empty string
 *   - `privacyMode` ∈ KNOWN_PRIVACY_MODES
 *   - `cta`         object with `type` ∈ KNOWN_CTA_TYPES,
 *                   `navigate` requires `route`, `run_tool` requires `toolName`
 *   - `evidence`    array; each entry has non-empty `kind` + `detail`
 *   - `expiresAt`   if present, must be string
 *   - `suppressReason` ↔ `kind === 'none_with_reason'`:
 *       * present (non-empty trimmed string) when kind is `none_with_reason`
 *       * absent when kind is anything else
 *
 * The discriminated union enforces the kind/suppressReason invariant at
 * compile time for typed callers; this validator is the defense for
 * providers that bypass the type system (`as any`, JS-side callers like
 * the ai-chat edge function in B0d.4, etc.).
 *
 * Reasons are prefixed with `invariant_violation:` so they're easy to
 * grep out of the Continuation Inspector + OASIS payloads.
 */
export function validateContinuationCandidate(
  candidate: unknown,
): CandidateValidation {
  if (candidate === null || typeof candidate !== 'object') {
    return {
      ok: false,
      reason: 'invariant_violation: candidate_not_an_object',
    };
  }
  const c = candidate as Record<string, unknown>;

  // ---- kind ----
  if (
    typeof c.kind !== 'string' ||
    !KNOWN_CONTINUATION_KINDS.has(c.kind as ContinuationKind)
  ) {
    return {
      ok: false,
      reason: `invariant_violation: unknown_continuation_kind (${String(c.kind)})`,
    };
  }

  // ---- id ----
  if (!isNonEmptyTrimmedString(c.id)) {
    return {
      ok: false,
      reason: 'invariant_violation: missing_or_invalid_field: id',
    };
  }

  // ---- surface ----
  if (
    typeof c.surface !== 'string' ||
    !KNOWN_CONTINUATION_SURFACES.has(c.surface as ContinuationSurface)
  ) {
    return {
      ok: false,
      reason: `invariant_violation: unknown_continuation_surface (${String(c.surface)})`,
    };
  }

  // ---- priority ----
  if (typeof c.priority !== 'number' || !Number.isFinite(c.priority)) {
    return {
      ok: false,
      reason: 'invariant_violation: missing_or_invalid_field: priority',
    };
  }

  // ---- userFacingLine (empty allowed for none_with_reason) ----
  if (typeof c.userFacingLine !== 'string') {
    return {
      ok: false,
      reason: 'invariant_violation: missing_or_invalid_field: userFacingLine',
    };
  }

  // ---- dedupeKey ----
  if (!isNonEmptyTrimmedString(c.dedupeKey)) {
    return {
      ok: false,
      reason: 'invariant_violation: missing_or_invalid_field: dedupeKey',
    };
  }

  // ---- privacyMode ----
  if (
    typeof c.privacyMode !== 'string' ||
    !KNOWN_PRIVACY_MODES.has(c.privacyMode as ContinuationPrivacyMode)
  ) {
    return {
      ok: false,
      reason: `invariant_violation: unknown_privacy_mode (${String(c.privacyMode)})`,
    };
  }

  // ---- cta ----
  if (c.cta === null || typeof c.cta !== 'object') {
    return {
      ok: false,
      reason: 'invariant_violation: missing_or_invalid_field: cta',
    };
  }
  const cta = c.cta as Record<string, unknown>;
  if (
    typeof cta.type !== 'string' ||
    !KNOWN_CTA_TYPES.has(cta.type as ContinuationCta['type'])
  ) {
    return {
      ok: false,
      reason: `invariant_violation: unknown_cta_type (${String(cta.type)})`,
    };
  }
  if (cta.type === 'navigate' && !isNonEmptyTrimmedString(cta.route)) {
    return {
      ok: false,
      reason: 'invariant_violation: cta_navigate_requires_route',
    };
  }
  if (cta.type === 'run_tool' && !isNonEmptyTrimmedString(cta.toolName)) {
    return {
      ok: false,
      reason: 'invariant_violation: cta_run_tool_requires_toolName',
    };
  }

  // ---- evidence ----
  if (!Array.isArray(c.evidence)) {
    return {
      ok: false,
      reason: 'invariant_violation: evidence_must_be_array',
    };
  }
  for (let i = 0; i < c.evidence.length; i++) {
    const e = c.evidence[i];
    if (e === null || typeof e !== 'object') {
      return {
        ok: false,
        reason: `invariant_violation: evidence_entry_invalid (index ${i})`,
      };
    }
    const ee = e as Record<string, unknown>;
    if (!isNonEmptyTrimmedString(ee.kind) || !isNonEmptyTrimmedString(ee.detail)) {
      return {
        ok: false,
        reason: `invariant_violation: evidence_entry_invalid (index ${i})`,
      };
    }
  }

  // ---- expiresAt (optional) ----
  if (c.expiresAt !== undefined && typeof c.expiresAt !== 'string') {
    return {
      ok: false,
      reason: 'invariant_violation: missing_or_invalid_field: expiresAt',
    };
  }

  // ---- suppressReason ↔ kind invariant ----
  const isNoneKind = c.kind === 'none_with_reason';
  const hasReason =
    typeof c.suppressReason === 'string' && c.suppressReason.trim().length > 0;
  if (isNoneKind && !hasReason) {
    return {
      ok: false,
      reason: 'invariant_violation: none_with_reason_requires_suppressReason',
    };
  }
  if (!isNoneKind && c.suppressReason !== undefined) {
    return {
      ok: false,
      reason: 'invariant_violation: non_none_kind_must_not_carry_suppressReason',
    };
  }

  return { ok: true };
}
