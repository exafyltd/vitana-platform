/**
 * VTID-04454 (Plan v1, after WS-2.2 / WS-4.3) — the relevance score chooses
 * the opening.
 *
 * Until now `decideContinuation` picked the opening by fixed provider priority
 * and the weighted score (candidate-scoring.ts, VTID-04422) was only recorded
 * beside it. With `BRAIN_SCORED_OPENING=true` the scored top candidate is the
 * one Vitana opens with; the fixed winner is still computed and recorded, so
 * the Command Hub comparison keeps showing where the two differ.
 *
 * Three things keep the fixed ranking in charge:
 *
 *   - An explicit selection (a tapped guided topic or focus step) never
 *     reaches this module — the caller skips scoring for it.
 *   - A pinned provider (`SCORED_OPENING_PINNED_PROVIDERS`) that returned a
 *     candidate keeps the fixed decision: a first-time welcome is an
 *     onboarding obligation, not a relevance question.
 *   - When scoring does not finish inside its time bound, or fails, the fixed
 *     decision is served unchanged (`fixed_fallback`).
 *
 * Nothing here composes speech. The chosen candidate's line is the provider's
 * own lead, exactly as when the fixed ranker chose it.
 */

import type { AssistantContinuation, AssistantContinuationDecision } from '../assistant-continuation/types';
import type { ShadowRanking } from './candidate-scoring';

/** Exact `true` enables; unset or anything else keeps the fixed ranking. */
export function isScoredOpeningEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.BRAIN_SCORED_OPENING === 'true';
}

export const SCORED_OPENING_TIMEOUT_DEFAULT_MS = 400;
const SCORED_OPENING_TIMEOUT_MIN_MS = 100;
const SCORED_OPENING_TIMEOUT_MAX_MS = 1500;

/** `BRAIN_SCORED_OPENING_TIMEOUT_MS`, clamped to 100–1500 ms; garbage → 400. */
export function scoredOpeningTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.BRAIN_SCORED_OPENING_TIMEOUT_MS);
  if (!Number.isFinite(n) || n <= 0) return SCORED_OPENING_TIMEOUT_DEFAULT_MS;
  return Math.min(SCORED_OPENING_TIMEOUT_MAX_MS, Math.max(SCORED_OPENING_TIMEOUT_MIN_MS, Math.round(n)));
}

/** Providers whose candidate, when returned, keeps the fixed ranking. */
export const SCORED_OPENING_PINNED_PROVIDERS: ReadonlySet<string> = new Set([
  'first_time_welcome',
  'guided_topic_narration',
]);

export type OpeningRankingMode = 'scored' | 'fixed_pinned' | 'fixed_fallback';

export interface ScoredOpeningResult {
  decision: AssistantContinuationDecision;
  mode: OpeningRankingMode;
  fixed_winner: string | null;
  served_winner: string | null;
  /** Why the fixed decision was kept, when it was. */
  reason?: string;
}

function providerOf(decision: AssistantContinuationDecision, cand: AssistantContinuation | null): string | null {
  if (!cand) return null;
  const r = decision.sourceProviderResults.find((x) => x.candidate === cand || (x.candidate && x.candidate.id === cand.id));
  return r?.providerKey ?? null;
}

/**
 * Serve the scored winner in place of the fixed one. Pure: the input decision
 * is never mutated; a new decision object is returned only when the served
 * candidate changes.
 */
export function applyScoredOpening(
  decision: AssistantContinuationDecision,
  ranking: ShadowRanking | null,
  pinned: ReadonlySet<string> = SCORED_OPENING_PINNED_PROVIDERS,
): ScoredOpeningResult {
  const fixedWinner = providerOf(decision, decision.selectedContinuation);
  const keep = (mode: OpeningRankingMode, reason: string): ScoredOpeningResult => ({
    decision,
    mode,
    fixed_winner: fixedWinner,
    served_winner: fixedWinner,
    reason,
  });

  if (!ranking) return keep('fixed_fallback', 'ranking_unavailable');
  if (!decision.selectedContinuation) return keep('fixed_fallback', 'no_candidate');

  const pinnedReturned = decision.sourceProviderResults.find(
    (r) => r.status === 'returned' && r.candidate && pinned.has(r.providerKey),
  );
  if (pinnedReturned) return keep('fixed_pinned', `pinned:${pinnedReturned.providerKey}`);

  const scoredWinner = ranking.shadow_winner;
  if (!scoredWinner) return keep('fixed_fallback', 'no_scored_winner');
  if (scoredWinner === fixedWinner) {
    return { decision, mode: 'scored', fixed_winner: fixedWinner, served_winner: fixedWinner };
  }

  const chosen = decision.sourceProviderResults.find(
    (r) => r.providerKey === scoredWinner && r.status === 'returned' && r.candidate && r.candidate.kind !== 'none_with_reason',
  );
  if (!chosen || !chosen.candidate) return keep('fixed_fallback', 'scored_winner_not_returned');

  return {
    decision: { ...decision, selectedContinuation: chosen.candidate },
    mode: 'scored',
    fixed_winner: fixedWinner,
    served_winner: scoredWinner,
  };
}

/** Resolve `work` within `ms`, else null. Never rejects; the loser keeps running and is ignored. */
export function withinBound<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}
