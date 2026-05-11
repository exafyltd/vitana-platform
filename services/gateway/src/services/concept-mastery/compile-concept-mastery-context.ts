/**
 * VTID-02936 (B3) — compileConceptMasteryContext.
 *
 * Pure function over raw rows. Produces the distilled
 * ConceptMasteryContext the assistant decision layer reads from:
 *
 *   concepts_explained          — top-N by last_explained_at DESC, w/ repetition_hint
 *   concepts_mastered           — top-N by last_observed_at DESC
 *   dyk_cards_seen              — top-N by last_seen_at DESC
 *   counts                      — aggregate signals the cadence layer uses
 *   source_health               — read status
 *
 * Repetition hint policy (data-grounded, no LLM):
 *   - count == 0                       → 'first_time'  (shouldn't normally appear, defensive)
 *   - count >= 3                       → 'skip'        (over-explained — suppress)
 *   - concept has a mastery row        → 'skip'        (user has demonstrated mastery)
 *   - else (count 1 or 2, no mastery)  → 'one_liner'
 *
 * No IO. No mutation. No clock side-effects (now is injected).
 */

import type {
  ConceptExplainedRow,
  ConceptMasteryContext,
  ConceptMasteryRow,
  DykCardSeenRow,
} from './types';

export interface CompileConceptMasteryContextInputs {
  fetchResult: {
    ok: boolean;
    concepts_explained: ConceptExplainedRow[];
    concepts_mastered: ConceptMasteryRow[];
    dyk_cards_seen: DykCardSeenRow[];
    reason?: string;
  };
  /** Injected for testability. Production passes Date.now(). */
  nowMs?: number;
  /** Max explained concepts to surface. Default 10. */
  conceptsExplainedLimit?: number;
  /** Max mastered concepts to surface. Default 10. */
  conceptsMasteredLimit?: number;
  /** Max DYK cards to surface. Default 10. */
  dykCardsLimit?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const LAST_24H_MS = 24 * 60 * 60 * 1000;
const MASTERY_THRESHOLD_COUNT = 3;

export function compileConceptMasteryContext(
  input: CompileConceptMasteryContextInputs,
): ConceptMasteryContext {
  const now = input.nowMs ?? Date.now();
  const explainedLimit = input.conceptsExplainedLimit ?? 10;
  const masteredLimit = input.conceptsMasteredLimit ?? 10;
  const dykLimit = input.dykCardsLimit ?? 10;

  const fetchOk = input.fetchResult.ok;
  const explainedRows = fetchOk ? input.fetchResult.concepts_explained : [];
  const masteredRows = fetchOk ? input.fetchResult.concepts_mastered : [];
  const dykRows = fetchOk ? input.fetchResult.dyk_cards_seen : [];

  // Set of mastered concept keys — used to drive repetition_hint.
  const masteredSet = new Set<string>(masteredRows.map((r) => r.concept_key));

  // Surface the explained list, ordered by recency.
  const concepts_explained = [...explainedRows]
    .sort((a, b) => Date.parse(b.last_explained_at) - Date.parse(a.last_explained_at))
    .slice(0, explainedLimit)
    .map((r) => ({
      concept_key: r.concept_key,
      count: r.count,
      last_explained_at: r.last_explained_at,
      days_since_last_explained: daysSince(now, r.last_explained_at),
      repetition_hint: repetitionHint(r.count, masteredSet.has(r.concept_key)),
    }));

  const concepts_mastered = [...masteredRows]
    .sort((a, b) => Date.parse(b.last_observed_at) - Date.parse(a.last_observed_at))
    .slice(0, masteredLimit)
    .map((r) => ({
      concept_key: r.concept_key,
      confidence: r.confidence,
      last_observed_at: r.last_observed_at,
    }));

  const dyk_cards_seen = [...dykRows]
    .sort((a, b) => Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at))
    .slice(0, dykLimit)
    .map((r) => ({
      card_key: r.card_key,
      count: r.count,
      last_seen_at: r.last_seen_at,
      days_since_last_seen: daysSince(now, r.last_seen_at),
    }));

  // Counts.
  const concepts_explained_in_last_24h = explainedRows.filter((r) => {
    const t = Date.parse(r.last_explained_at);
    return Number.isFinite(t) && now - t <= LAST_24H_MS;
  }).length;

  return {
    concepts_explained,
    concepts_mastered,
    dyk_cards_seen,
    counts: {
      concepts_explained_total: explainedRows.length,
      concepts_mastered_total: masteredRows.length,
      dyk_cards_seen_total: dykRows.length,
      concepts_explained_in_last_24h,
    },
    source_health: {
      user_assistant_state: fetchOk
        ? { ok: true }
        : { ok: false, reason: input.fetchResult.reason ?? 'unknown_failure' },
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers — exported for tests
// ---------------------------------------------------------------------------

export function repetitionHint(
  count: number,
  hasMastery: boolean,
): 'first_time' | 'one_liner' | 'skip' {
  if (hasMastery) return 'skip';
  if (count <= 0) return 'first_time';
  if (count >= MASTERY_THRESHOLD_COUNT) return 'skip';
  return 'one_liner';
}

function daysSince(nowMs: number, isoTs: string): number | null {
  const thenMs = Date.parse(isoTs);
  if (!Number.isFinite(thenMs)) return null;
  const diff = nowMs - thenMs;
  if (diff < 0) return Math.ceil(diff / DAY_MS);
  return Math.floor(diff / DAY_MS);
}
