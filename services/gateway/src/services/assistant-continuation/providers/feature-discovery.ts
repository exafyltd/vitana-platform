/**
 * VTID-02921 (B0e.2) — Feature Discovery continuation provider.
 *
 * Picks EXACTLY ONE unexplored capability per decision OR suppresses
 * with a concrete reason. Never lists. Never advances awareness state
 * inside selection — that is a separate event/update path (an explicit
 * FEATURE_DISCOVERY_OFFERED event in B0e.3+ wiring will trigger the
 * state advance to `introduced`).
 *
 * Scope guardrails (from the user's locked B0e.2 spec):
 *   - Provider kind: `feature_discovery`.
 *   - Picks EXACTLY ONE capability per decision. Returning multiple is
 *     a test failure.
 *   - Never hardcodes copy in `orb/live/instruction/*`. All user-facing
 *     text comes from the capability's display_name + description
 *     (which lives in `system_capabilities`).
 *   - Respects the 7-state ladder: dismissed / mastered / completed
 *     never resurfaced casually.
 *   - Surfaces: `orb_turn_end`, `text_turn_end`, `home`.
 *     **NOT `orb_wake`** — wake stays clean + fast. The provider does
 *     not even register itself for that surface unless explicitly
 *     opted in via `opts.includeOrbWake`.
 *   - Priority 30 (lower than wake_brief 80, reminder, match_journey).
 *
 * Match-related capability rule:
 *   - The 7 deferred match-concierge capabilities (pre_match_whois,
 *     should_i_show_interest, draft_opener, activity_plan_card,
 *     match_chat_assist, post_activity_reflection, next_rep_suggestion)
 *     PLUS the seeded `activity_match` are flagged as match-related.
 *   - Match-related capabilities ONLY appear when the current
 *     `envelopeJourneySurface` is a match surface (intent_board,
 *     intent_card, pre_match_whois, match_detail, match_chat,
 *     activity_plan, matches_hub).
 *   - Non-match surfaces NEVER get match-related candidates.
 *
 * Data inputs (read-only):
 *   - `system_capabilities` — global catalog of features (B0e.1).
 *   - `user_capability_awareness` — per-user state ladder (B0e.1).
 *
 * The provider is purely a SELECTION function. State advancement
 * (introduced → seen → tried → completed → mastered, or → dismissed)
 * happens through dedicated event/RPC paths that B0e.3+ wires. Doing
 * mutation inside selection would couple the ranker to a side-effect
 * surface that B0d.3's reliability timeline can't observe.
 */

import { randomUUID } from 'crypto';
import type {
  AssistantContinuation,
  ContinuationProvider,
  ContinuationDecisionContext,
  ContinuationSurface,
  ProviderResult,
} from '../types';
import { defaultProviderRegistry } from '../provider-registry';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AwarenessState =
  | 'unknown'
  | 'introduced'
  | 'seen'
  | 'tried'
  | 'completed'
  | 'dismissed'
  | 'mastered';

export interface CapabilityRow {
  capability_key: string;
  display_name: string;
  description: string;
  required_role: string | null;
  required_tenant_features: string[] | null;
  required_integrations: string[] | null;
  helpful_for_intents: string[] | null;
  enabled: boolean;
}

export interface AwarenessRow {
  capability_key: string;
  awareness_state: AwarenessState;
  first_introduced_at: string | null;
  last_introduced_at: string | null;
  first_used_at: string | null;
  last_used_at: string | null;
  use_count: number;
  dismiss_count: number;
  mastery_confidence: number | null;
  last_surface: string | null;
}

/**
 * Read-only data source for the feature-discovery ranker. Injectable
 * so tests can pass canned data and the production binding can hit
 * Supabase.
 */
export interface CapabilityFetcher {
  listCapabilities(): Promise<CapabilityRow[]>;
  listAwareness(args: { tenantId: string; userId: string }): Promise<AwarenessRow[]>;
}

// ---------------------------------------------------------------------------
// Surface + capability classifications
// ---------------------------------------------------------------------------

export const FEATURE_DISCOVERY_PROVIDER_KEY = 'feature_discovery' as const;
const DEFAULT_PRIORITY = 30;

/** Default surfaces (orb_wake intentionally excluded — wake stays fast). */
export const DEFAULT_FEATURE_DISCOVERY_SURFACES: ReadonlyArray<ContinuationSurface> = [
  'orb_turn_end',
  'text_turn_end',
  'home',
];

/** Match-related journey surfaces from the B0a envelope. */
export const MATCH_JOURNEY_SURFACES: ReadonlySet<string> = new Set([
  'intent_board',
  'intent_card',
  'pre_match_whois',
  'match_detail',
  'match_chat',
  'activity_plan',
  'matches_hub',
]);

/**
 * Capability keys flagged as match-related. Includes the 7 deferred
 * match-concierge capabilities (which will be seeded by a future slice)
 * plus the already-seeded `activity_match`. A capability in this set
 * is ONLY surfaced when the current envelope surface is in
 * MATCH_JOURNEY_SURFACES.
 */
export const MATCH_RELATED_CAPABILITY_KEYS: ReadonlySet<string> = new Set([
  // Deferred (B0e.1 does NOT seed these — they ship with the concierge).
  'pre_match_whois',
  'should_i_show_interest',
  'draft_opener',
  'activity_plan_card',
  'match_chat_assist',
  'post_activity_reflection',
  'next_rep_suggestion',
  // Seeded in B0e.1.
  'activity_match',
]);

/**
 * Awareness states that disqualify a capability from being surfaced
 * casually. Each is a hard-skip in the ranker.
 */
const TERMINAL_AWARENESS_STATES: ReadonlySet<AwarenessState> = new Set([
  'dismissed',
  'completed',
  'mastered',
]);

/** Threshold beyond which the user has clearly said "stop". */
const DISMISS_HARD_BACKOFF = 2;

/** Dampen recently-introduced capabilities for this many days. */
const RECENT_INTRODUCTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Ranker — pure function over (capability, awareness, ctx) → score | null
// ---------------------------------------------------------------------------

export interface RankerInputs {
  capability: CapabilityRow;
  awareness: AwarenessRow | null;
  surface: ContinuationSurface;
  envelopeJourneySurface?: string;
  nowMs: number;
}

export interface RankerResult {
  /** Higher = more relevant. `null` = ineligible. */
  score: number | null;
  /** Set when `score === null` — names which guard rejected the candidate. */
  rejectionReason?: string;
}

export interface FeatureDiscoveryRanker {
  score(inputs: RankerInputs): RankerResult;
}

export const defaultFeatureDiscoveryRanker: FeatureDiscoveryRanker = {
  score(inputs: RankerInputs): RankerResult {
    const { capability, awareness, envelopeJourneySurface, nowMs } = inputs;

    if (!capability.enabled) {
      return { score: null, rejectionReason: 'capability_disabled' };
    }

    // Match-related capability gate: only surface on match-journey surfaces.
    const isMatchRelated = MATCH_RELATED_CAPABILITY_KEYS.has(capability.capability_key);
    if (isMatchRelated) {
      if (!envelopeJourneySurface || !MATCH_JOURNEY_SURFACES.has(envelopeJourneySurface)) {
        return { score: null, rejectionReason: 'match_capability_on_non_match_surface' };
      }
    }

    const state: AwarenessState = awareness?.awareness_state ?? 'unknown';

    // Hard skip: dismissed / completed / mastered. The user already
    // either said no or has the capability under their belt. State
    // advancement happens through explicit events (B0e.3+), never as a
    // side effect of selection.
    if (TERMINAL_AWARENESS_STATES.has(state)) {
      return { score: null, rejectionReason: `awareness_state_terminal_${state}` };
    }

    // Hard backoff: twice-dismissed = never resurface here. Another
    // future slice can re-introduce after a long cool-down; B0e.2 does
    // not.
    if ((awareness?.dismiss_count ?? 0) >= DISMISS_HARD_BACKOFF) {
      return {
        score: null,
        rejectionReason: `dismiss_hard_backoff_${awareness?.dismiss_count ?? 0}`,
      };
    }

    // Recent-introduction dampener.
    const lastIntroducedMs = awareness?.last_introduced_at
      ? Date.parse(awareness.last_introduced_at)
      : null;
    if (
      lastIntroducedMs !== null &&
      Number.isFinite(lastIntroducedMs) &&
      nowMs - lastIntroducedMs < RECENT_INTRODUCTION_WINDOW_MS
    ) {
      return { score: null, rejectionReason: 'recently_introduced_within_7d' };
    }

    // Score by state — `unknown` is the highest-value introduction.
    let score: number;
    switch (state) {
      case 'unknown':    score = 100; break;
      case 'introduced': score = 50;  break;
      case 'seen':       score = 30;  break;
      case 'tried':      score = 10;  break;
      // dismissed / completed / mastered already returned null above.
      default:           score = 0;   break;
    }

    // Mild dismiss penalty (1 dismissal = -10).
    score -= 10 * (awareness?.dismiss_count ?? 0);

    return { score };
  },
};

// ---------------------------------------------------------------------------
// User-facing line rendering — backend-owned, NEVER from instruction/*
// ---------------------------------------------------------------------------

export interface FeatureDiscoveryRenderer {
  render(capability: CapabilityRow, ctx: ContinuationDecisionContext): string;
}

export const defaultFeatureDiscoveryRenderer: FeatureDiscoveryRenderer = {
  render(capability) {
    // Short hook only — the renderer never writes a multi-sentence
    // marketing blurb. The capability's display_name + a one-line
    // hook from the description is the entire line.
    const hook = capability.description.split('. ')[0].replace(/\.$/, '');
    return `One thing you may not have explored yet — ${capability.display_name}. ${hook}.`;
  },
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface FeatureDiscoveryProviderOptions {
  fetcher: CapabilityFetcher;
  /** Replace the default ranker (tests + future signal-driven slices). */
  ranker?: FeatureDiscoveryRanker;
  /** Replace the default renderer. */
  renderer?: FeatureDiscoveryRenderer;
  /** Injected for tests. */
  newId?: () => string;
  /** Injected for tests. */
  now?: () => number;
  /** Default 30. */
  priority?: number;
  /**
   * Opt-in to register on `orb_wake`. Default: false. Wake stays clean
   * and fast; feature-discovery only fires on turn-end / text-turn-end
   * / home surfaces unless an explicit experiment turns this on.
   */
  includeOrbWake?: boolean;
}

export function makeFeatureDiscoveryProvider(
  opts: FeatureDiscoveryProviderOptions,
): ContinuationProvider {
  const ranker = opts.ranker ?? defaultFeatureDiscoveryRanker;
  const renderer = opts.renderer ?? defaultFeatureDiscoveryRenderer;
  const newId = opts.newId ?? (() => randomUUID());
  const now = opts.now ?? (() => Date.now());
  const priority = opts.priority ?? DEFAULT_PRIORITY;
  const surfaces: ContinuationSurface[] = [...DEFAULT_FEATURE_DISCOVERY_SURFACES];
  if (opts.includeOrbWake) surfaces.push('orb_wake');

  return {
    key: FEATURE_DISCOVERY_PROVIDER_KEY,
    surfaces,
    async produce(ctx: ContinuationDecisionContext): Promise<ProviderResult> {
      const t0 = now();

      // Defensive skip — never run on orb_wake even if the registry
      // erroneously routed us here without includeOrbWake.
      if (ctx.surface === 'orb_wake' && !opts.includeOrbWake) {
        return {
          providerKey: FEATURE_DISCOVERY_PROVIDER_KEY,
          status: 'skipped',
          latencyMs: Math.max(0, now() - t0),
          reason: 'feature_discovery_disabled_on_orb_wake',
        };
      }

      // Need tenant + user to read user_capability_awareness.
      if (!ctx.tenantId || !ctx.userId) {
        return {
          providerKey: FEATURE_DISCOVERY_PROVIDER_KEY,
          status: 'skipped',
          latencyMs: Math.max(0, now() - t0),
          reason: 'feature_discovery_requires_identified_session',
        };
      }

      let capabilities: CapabilityRow[];
      let awareness: AwarenessRow[];
      try {
        [capabilities, awareness] = await Promise.all([
          opts.fetcher.listCapabilities(),
          opts.fetcher.listAwareness({ tenantId: ctx.tenantId, userId: ctx.userId }),
        ]);
      } catch (err) {
        return {
          providerKey: FEATURE_DISCOVERY_PROVIDER_KEY,
          status: 'errored',
          latencyMs: Math.max(0, now() - t0),
          reason: err instanceof Error ? err.message : String(err),
        };
      }

      const awarenessByKey = new Map<string, AwarenessRow>();
      for (const a of awareness) awarenessByKey.set(a.capability_key, a);

      // Score every candidate; track per-key rejection reasons for the
      // suppression payload so operators can see WHY no feature was
      // offered (key contract from the user's locked spec).
      const scored: Array<{ capability: CapabilityRow; score: number }> = [];
      const rejections: Record<string, string> = {};
      const nowMs = now();
      for (const cap of capabilities) {
        const result = ranker.score({
          capability: cap,
          awareness: awarenessByKey.get(cap.capability_key) ?? null,
          surface: ctx.surface,
          envelopeJourneySurface: ctx.envelopeJourneySurface,
          nowMs,
        });
        if (result.score === null) {
          rejections[cap.capability_key] = result.rejectionReason ?? 'unscored';
        } else {
          scored.push({ capability: cap, score: result.score });
        }
      }

      if (scored.length === 0) {
        return {
          providerKey: FEATURE_DISCOVERY_PROVIDER_KEY,
          status: 'suppressed',
          latencyMs: Math.max(0, now() - t0),
          reason: `no_eligible_capability (catalog_size=${capabilities.length}, all_rejected)`,
        };
      }

      // Pick ONE — highest score wins. Stable tie-break: catalog
      // order (Map preserves insertion order from the fetcher).
      scored.sort((a, b) => b.score - a.score);
      const winner = scored[0].capability;

      let line: string;
      try {
        line = renderer.render(winner, ctx);
      } catch (err) {
        return {
          providerKey: FEATURE_DISCOVERY_PROVIDER_KEY,
          status: 'errored',
          latencyMs: Math.max(0, now() - t0),
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      if (typeof line !== 'string' || line.trim().length === 0) {
        return {
          providerKey: FEATURE_DISCOVERY_PROVIDER_KEY,
          status: 'errored',
          latencyMs: Math.max(0, now() - t0),
          reason: 'renderer_produced_empty_line',
        };
      }

      const candidate: AssistantContinuation = {
        id: `feature-discovery-${newId()}`,
        surface: ctx.surface,
        kind: 'feature_discovery',
        priority,
        userFacingLine: line,
        cta: { type: 'explain' },
        evidence: [
          {
            kind: 'capability_key',
            detail: winner.capability_key,
          },
          {
            kind: 'awareness_state',
            detail:
              awarenessByKey.get(winner.capability_key)?.awareness_state ?? 'unknown',
          },
        ],
        dedupeKey: `feature-discovery-${winner.capability_key}`,
        privacyMode: 'safe_to_speak',
      };

      return {
        providerKey: FEATURE_DISCOVERY_PROVIDER_KEY,
        status: 'returned',
        latencyMs: Math.max(0, now() - t0),
        candidate,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Default registration — production calls `ensureFeatureDiscoveryRegistered`
// (idempotent). Tests use the factory directly with a fake fetcher.
// ---------------------------------------------------------------------------

let _registered = false;
export function ensureFeatureDiscoveryRegistered(
  fetcher: CapabilityFetcher,
  opts: Omit<FeatureDiscoveryProviderOptions, 'fetcher'> = {},
): void {
  if (_registered) return;
  if (defaultProviderRegistry.get(FEATURE_DISCOVERY_PROVIDER_KEY)) {
    _registered = true;
    return;
  }
  defaultProviderRegistry.register(
    makeFeatureDiscoveryProvider({ fetcher, ...opts }),
  );
  _registered = true;
}
