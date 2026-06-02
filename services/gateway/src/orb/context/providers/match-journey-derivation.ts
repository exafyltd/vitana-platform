/**
 * BOOTSTRAP-MATCHMAKING-INDEX — pure match-journey derivation.
 *
 * De-stubs the match-journey context provider by deriving a real
 * `MatchJourneyContext` from the user's latest matchmaking state and
 * their Vitana Index tier. This module is intentionally PURE — no IO,
 * no clock side-effects (now is injected), no Supabase. The thin
 * fetcher (`match-journey-fetcher.ts`) feeds distilled rows in; this
 * function maps them to the distilled snapshot the compiler consumes.
 *
 * Hard guardrails (preserved from the seam):
 *   - NO raw match rows / chat text / profile payloads escape — only
 *     the distilled `MatchJourneyContext` fields are produced here.
 *   - NO OASIS topic literals (the grep guard at
 *     scripts/ci/match-journey-topics-guard.mjs enforces this).
 *
 * Stage mapping (intent_matches.state → journeyStage):
 *   - no match rows at all           → 'browsing'
 *   - latest state = 'suggested'     → 'pre_interest'
 *   - latest state = 'accepted'      → 'mutual_match'
 *   - latest state = 'dismissed'     → 'browsing' (back to the pool)
 *
 * Vitana Index tier anchors the *confidence* of the recommended next
 * move and surfaces a low-momentum warning so matchmaking can lean on
 * the user's real journey/Index state rather than a hardcoded 'none'.
 */

import type { MatchJourneyContext } from './match-journey-context-provider';
import type { VitanaIndexTier } from '../../../services/journey-stage/types';
import { tierFromScore } from '../../../services/journey-stage/compile-journey-stage-context';

/** Canonical match lifecycle states (intent_matches.match_state enum). */
export type MatchLifecycleState = 'suggested' | 'accepted' | 'dismissed';

/**
 * Distilled latest-match observation. The fetcher reduces the raw
 * intent_matches row to exactly these fields — nothing raw crosses in.
 */
export interface LatestMatchObservation {
  matchId: string | null;
  intentId: string | null;
  /** Normalised lifecycle state, or null when the row had an unknown state. */
  state: MatchLifecycleState | null;
  /** ISO timestamp of the most recent state change / row update. */
  stateChangedAt: string | null;
}

export interface DeriveMatchJourneyInput {
  /**
   * The most-recent match row for the user, or null when the user has
   * no matches yet (→ 'browsing').
   */
  latestMatch: LatestMatchObservation | null;
  /** Latest Vitana Index total score, or null when no history exists. */
  indexScoreTotal: number | null;
  /** Injected for testability. Production passes Date.now(). */
  nowMs?: number;
}

const SILENCE_WARN_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

/**
 * Map a raw state string to the canonical lifecycle enum. Unknown
 * strings collapse to null so the derivation degrades to 'browsing'
 * rather than emitting an invalid stage.
 */
export function normaliseMatchState(raw: unknown): MatchLifecycleState | null {
  if (raw === 'suggested' || raw === 'accepted' || raw === 'dismissed') return raw;
  return null;
}

/**
 * Pure derivation: latest match state + Vitana Index tier → distilled
 * `MatchJourneyContext`. Never returns 'none' — that sentinel is
 * reserved for the flag-OFF stub path in the provider.
 */
export function deriveMatchJourneyContext(
  input: DeriveMatchJourneyInput,
): MatchJourneyContext {
  const now = input.nowMs ?? Date.now();
  const tier = tierFromScore(input.indexScoreTotal);

  const latest = input.latestMatch;
  const state = latest?.state ?? null;

  // ----- Stage from match lifecycle -----
  let journeyStage: MatchJourneyContext['journeyStage'];
  if (!latest || state === null || state === 'dismissed') {
    journeyStage = 'browsing';
  } else if (state === 'suggested') {
    journeyStage = 'pre_interest';
  } else {
    // state === 'accepted'
    journeyStage = 'mutual_match';
  }

  const ctx: MatchJourneyContext = { journeyStage };

  // ----- Identifiers (distilled, never raw rows) -----
  if (latest?.matchId) ctx.matchId = latest.matchId;
  if (latest?.intentId) ctx.intentId = latest.intentId;

  // ----- Event recency + silence -----
  const lastMs = parseIsoMs(latest?.stateChangedAt ?? null);
  if (latest?.stateChangedAt && lastMs !== null) {
    ctx.lastMatchEventAt = latest.stateChangedAt;
    const silence = Math.max(0, now - lastMs);
    ctx.silenceDuration = silence;
  }

  // ----- Pending decision + recommended next move (stage-driven) -----
  switch (journeyStage) {
    case 'pre_interest':
      ctx.pendingUserDecision = 'show_interest';
      ctx.recommendedNextMove = 'ask_should_i_show_interest';
      break;
    case 'mutual_match':
      ctx.pendingUserDecision = 'send_opener';
      ctx.recommendedNextMove = 'stage_opener';
      break;
    case 'browsing':
    default:
      // No pending decision while browsing the pool.
      break;
  }

  // ----- Vitana-Index anchored warnings -----
  const warnings: string[] = [];
  if (isLowMomentumTier(tier)) {
    // The matchmaker can use this to soften pressure / favour
    // confidence-building suggestions for users early in their journey.
    warnings.push(`vitana_index_tier:${tier}`);
  }
  if (
    journeyStage === 'mutual_match' &&
    ctx.silenceDuration !== undefined &&
    ctx.silenceDuration >= SILENCE_WARN_MS
  ) {
    warnings.push('match_silence');
    ctx.recommendedNextMove = 'nudge_reply';
  }
  if (warnings.length > 0) ctx.warnings = warnings;

  return ctx;
}

/** Foundation/building tiers (and unknown) signal a user still warming up. */
function isLowMomentumTier(tier: VitanaIndexTier): boolean {
  return tier === 'foundation' || tier === 'building' || tier === 'unknown';
}

function parseIsoMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}
