/**
 * VTID-03056 (B0d-real slice Xa) — Contextual Next Action Provider types.
 *
 * The wake-brief v0 (B0d-mini, VTID-03052/03053/03054) shipped ONE
 * hardcoded pillar-momentum line. B0d-real composes the user's full
 * context — Life Compass, Vitana Index, diary, journey stage, Autopilot
 * recommendations, calendar, reminders, matches/intents/activity plans,
 * pending threads/promises, continuity — and picks ONE next-best action.
 *
 * Architecture: ONE composite provider with a pluggable per-source
 * registry. The framework's existing decideContinuation ranks providers;
 * inside THIS provider, the composer ranks SOURCES. Cross-source
 * comparisons happen here so we can break ties deterministically and
 * surface candidate-vs-winner evidence to the Command Hub.
 *
 * Each source file under `sources/` exposes a `NextActionSource` and
 * receives a `NextActionSourceContext` derived from the framework's
 * `ContinuationDecisionContext`. Sources NEVER throw — failures surface
 * as a `failed` candidate in the inspector trail.
 *
 * This slice ships the types + an empty composer + tests; concrete
 * sources land in follow-up slices Xb-Xe.
 */

import type { AssistantContinuationDecision, ContinuationCta } from '../../types';

// ---------------------------------------------------------------------------
// Source identity
// ---------------------------------------------------------------------------

/**
 * Stable identifier for each source. Used in OASIS payloads, the Command
 * Hub Candidate Inspector, and the per-source flag gates. Keep this enum
 * as the single source of truth — adding a source means adding here AND
 * registering the source file with the composer.
 *
 * The list mirrors the 11 input categories from the B0d-real scope:
 *   - autopilot_recommendation
 *   - reminder_due
 *   - calendar_upcoming
 *   - life_compass_alignment
 *   - vitana_index_pillar
 *   - diary_missing_relevant
 *   - journey_stage_nudge
 *   - match_activity_plan
 *   - continuity_pending_thread
 *   - continuity_promise_owed
 *
 * "Pillar momentum" is now ONE source (vitana_index_pillar), not the
 * whole system — that's the central scope correction from B0d-mini.
 */
export type NextActionSourceKey =
  | 'autopilot_recommendation'
  | 'reminder_due'
  | 'calendar_upcoming'
  | 'life_compass_alignment'
  | 'vitana_index_pillar'
  | 'diary_missing_relevant'
  | 'journey_stage_nudge'
  | 'match_activity_plan'
  | 'continuity_pending_thread'
  | 'continuity_promise_owed';

/**
 * The closed set of source keys for runtime iteration / validation.
 */
export const NEXT_ACTION_SOURCE_KEYS: readonly NextActionSourceKey[] = [
  'autopilot_recommendation',
  'reminder_due',
  'calendar_upcoming',
  'life_compass_alignment',
  'vitana_index_pillar',
  'diary_missing_relevant',
  'journey_stage_nudge',
  'match_activity_plan',
  'continuity_pending_thread',
  'continuity_promise_owed',
] as const;

// ---------------------------------------------------------------------------
// Candidate
// ---------------------------------------------------------------------------

/**
 * Confidence bands the LLM can compare across sources. Sources MUST map
 * their internal scores to this enum — the composer compares enum
 * positions, never raw provider scores.
 */
export type NextActionConfidence = 'low' | 'medium' | 'high';

/**
 * Reason that justifies a candidate. Multiple reasons may attach per
 * candidate (e.g. autopilot rec linked to weak pillar). Each reason
 * shows up in the Command Hub Candidate Inspector verbatim, so the
 * detail string should be short + operator-readable, NEVER medical
 * interpretation, NEVER PII beyond what's already on screen.
 */
export interface NextActionReason {
  /** Stable enum tag — e.g. 'reminder_due_within_30min'. */
  kind: string;
  /** One-line human readable. */
  detail: string;
}

/**
 * A scored candidate from a single source. The composer collects these
 * from every enabled source, ranks by priority (descending), breaks ties
 * deterministically (source key alphabetical), and renders the winner
 * as an AssistantContinuation.
 *
 * Priority is INTEGER on a 0..100 scale. Source-specific scorers map
 * their internal heuristics to this range — the composer compares
 * priorities directly, so the scale MUST be stable.
 *
 * Recommended priority bands:
 *   90+  — urgent (reminder firing within 10min, safety/medical flag)
 *   70-89  — strong (autopilot accepted yesterday + due today, mutual match)
 *   50-69  — medium (Life Compass nudge, weak pillar)
 *   30-49  — light (DYK, feature discovery — these belong in B0e, not here)
 *    0-29 — only when nothing else has a candidate
 */
export interface ScoredCandidate {
  source: NextActionSourceKey;
  /** Numeric priority on a 0..100 scale (see banding above). */
  priority: number;
  confidence: NextActionConfidence;
  /** The line Vitana will speak. Source produces it; composer renders. */
  userFacingLine: string;
  /** Per-language variants. The composer picks by ctx.lang. */
  perLang?: Record<string, string>;
  reasons: NextActionReason[];
  /** Stable key for dedupe across turns. Source MUST make this collision-
   *  proof — e.g. `reminder_due:<reminder_id>` not `reminder_due:current`. */
  dedupeKey: string;
  /**
   * Optional CTA that the composer will attach to the rendered
   * AssistantContinuation. When omitted the composer attaches a default
   * `explain` CTA. Discriminated union matches the framework's
   * ContinuationCta exactly so renderers don't need a translation layer.
   */
  cta?: ContinuationCta;
}

// ---------------------------------------------------------------------------
// Source interface
// ---------------------------------------------------------------------------

/**
 * Context a source receives. Identity + the framework decision context
 * (already-compiled spine signals) + a Supabase client for direct
 * source-specific reads. Sources MUST NOT recompile the spine — read
 * from decisionContext only.
 */
export interface NextActionSourceContext {
  userId: string;
  tenantId: string;
  lang: string;
  /** ISO 8601 server-side now — sources use this for freshness math. */
  nowIso: string;
  /** Read-only view of the compiled AssistantDecisionContext. Sources
   *  reading continuity/journey/pillar should consume this, NOT re-query. */
  decisionContext: unknown;
  /** Supabase service-role client for direct source-specific reads
   *  (reminders, autopilot_recommendations, calendar_events, etc.). */
  supabase: import('@supabase/supabase-js').SupabaseClient;
}

/**
 * Source contract. Each source file under `sources/` exports one of
 * these. The composer iterates the enabled set, calls `produce()` in
 * parallel, and collects the results.
 *
 * Sources MUST NOT throw. Any internal failure → return null with a
 * structured `failedReason` on the trace.
 */
export interface NextActionSource {
  readonly key: NextActionSourceKey;
  /** Whether this source can serve the given surface. The composer
   *  filters before invocation. */
  serves(surface: 'orb_wake' | 'orb_turn_end'): boolean;
  /** Produce zero or one candidate. Sources MAY produce multiple internal
   *  candidates; they MUST collapse to one before returning. The composer
   *  ranks ACROSS sources. */
  produce(ctx: NextActionSourceContext): Promise<NextActionSourceResult>;
}

/**
 * What a source returns. `candidate` is set when the source has
 * something to offer; `skippedReason` carries why when it doesn't.
 * Both populated together is invalid (composer will treat as `errored`).
 */
export interface NextActionSourceResult {
  source: NextActionSourceKey;
  candidate: ScoredCandidate | null;
  /** Required when candidate === null. Closed enum, NOT free text. */
  skippedReason?: NextActionSkipReason;
  /** Latency from the composer's perspective (ms). Populated by the composer. */
  latencyMs?: number;
}

/**
 * Why a source declined. Closed enum; new reasons land via a code change
 * (and a matching Inspector visualization, deliberately).
 */
export type NextActionSkipReason =
  | 'no_data'
  | 'no_eligible_record'
  | 'dedup_window'
  | 'low_confidence'
  | 'feature_disabled'
  | 'source_unavailable'
  | 'errored';

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

/**
 * The result of composing across all enabled sources. Mirrors the
 * framework's AssistantContinuationDecision shape but with NextAction-
 * specific evidence — the composer's own caller (the
 * `next-action.ts` provider) wraps `chosen` into an AssistantContinuation
 * for the framework to consume.
 */
export interface NextActionComposeResult {
  /** The winning candidate, or null when none qualifies. */
  chosen: ScoredCandidate | null;
  /** Every source's result, in registration order. The Command Hub
   *  Candidate Inspector renders this verbatim. */
  candidates: NextActionSourceResult[];
  /** When chosen === null, why the composer picked nothing. */
  suppressReason?: NextActionSuppressReason;
  /** ISO timestamps for latency math. */
  composeStartedAt: string;
  composeFinishedAt: string;
}

/**
 * Composer-level suppression reasons. These are DIFFERENT from per-source
 * skip reasons — these say "all sources combined produced nothing", not
 * "this one source declined".
 */
export type NextActionSuppressReason =
  | 'no_sources_registered'
  | 'all_sources_skipped'
  | 'all_sources_errored'
  | 'tied_below_threshold'
  | 'privacy_shared_device';

/**
 * The composer's public API. Stays small on purpose so callers (the
 * `next-action.ts` provider, tests, and the Command Hub preview route)
 * have one well-known entry point.
 */
export interface NextActionComposer {
  /** Register a source. Idempotent on key; second registration replaces. */
  register(source: NextActionSource): void;
  /** Drop all sources. Used by tests; production wiring registers once. */
  reset(): void;
  /** Listed source keys, in registration order. Stable for tie-breaking. */
  registeredKeys(): readonly NextActionSourceKey[];
  /** Produce one candidate across all enabled sources. */
  compose(
    surface: 'orb_wake' | 'orb_turn_end',
    ctx: NextActionSourceContext,
  ): Promise<NextActionComposeResult>;
}

// ---------------------------------------------------------------------------
// Re-export the framework decision type so consumers don't need two imports.
// ---------------------------------------------------------------------------
export type { AssistantContinuationDecision };
