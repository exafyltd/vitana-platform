/**
 * Memory relevance ranker — Phase B (ORB Memory Resilience).
 *
 * Phase A caps the bootstrap by truncating from the bottom — arbitrary with respect to
 * usefulness. Phase B replaces "first N memory rows" with a relevance-ranked top-K so
 * the content that SURVIVES the cap is the most useful.
 *
 * Pure + dependency-free: no Supabase, no fetch, no clock except the injected `now`.
 * This makes it exhaustively unit-testable and safe to call on the hot path. Gated in
 * the caller behind the existing `BOOTSTRAP_CONTEXT_RANKED_RETRIEVAL` feature flag; a
 * `VOICE_RANKING_SHADOW` mode logs naive-vs-ranked via `compareSelections` before the
 * flag is flipped in prod.
 *
 * Score = 0.4·importance + 0.4·recency + 0.2·similarity
 *   - importance : existing 0..1 column (clamped)
 *   - recency    : exp(-ageDays / 30) — 1.0 today, ~0.37 at 30 days, →0 older
 *   - similarity : cosine(intentEmbedding, candidate.embedding) mapped to 0..1, or 0
 *                  when either embedding is absent (ranking degrades to importance+recency)
 */

export interface MemoryCandidate {
  id: string;
  content: string;
  importance: number; // 0..1
  occurred_at: string; // ISO timestamp
  embedding?: number[]; // optional pgvector
}

export interface RankInputs<T extends MemoryCandidate = MemoryCandidate> {
  candidates: T[];
  intentEmbedding?: number[];
  now: Date;
  topK: number; // hard cap on output count
}

export const RECENCY_HALFLIFE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** exp(-ageDays / 30). Future timestamps clamp to 1.0; unparseable → 0. */
export function recencyDecay(occurredAt: string, now: Date): number {
  const t = Date.parse(occurredAt);
  if (!Number.isFinite(t)) return 0;
  const ageDays = (now.getTime() - t) / MS_PER_DAY;
  if (ageDays <= 0) return 1;
  return Math.exp(-ageDays / RECENCY_HALFLIFE_DAYS);
}

/** Cosine similarity mapped to [0,1]; 0 when shapes mismatch or either vector empty/zero. */
export function cosineSimilarity(a?: number[], b?: number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  const cos = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return clamp01((cos + 1) / 2); // map [-1,1] → [0,1]
}

export interface ScoredCandidate<T extends MemoryCandidate> {
  candidate: T;
  score: number;
}

/** Score every candidate (no truncation). Input order preserved for equal scores. */
export function scoreMemory<T extends MemoryCandidate>(
  { candidates, intentEmbedding, now }: Omit<RankInputs<T>, 'topK'>,
): ScoredCandidate<T>[] {
  return candidates.map((c) => {
    const importance = clamp01(c.importance ?? 0);
    const recency = recencyDecay(c.occurred_at, now);
    const similarity =
      intentEmbedding && c.embedding ? cosineSimilarity(intentEmbedding, c.embedding) : 0;
    const score = 0.4 * importance + 0.4 * recency + 0.2 * similarity;
    return { candidate: c, score };
  });
}

/**
 * Rank candidates by relevance and return the top-K. Pure; stable for equal scores
 * (preserves original relative order). `topK <= 0` returns an empty array.
 */
export function rankMemory<T extends MemoryCandidate>(inputs: RankInputs<T>): T[] {
  const { topK } = inputs;
  if (topK <= 0) return [];
  const scored = scoreMemory(inputs);
  return scored
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (b.s.score - a.s.score) || (a.i - b.i)) // stable on ties
    .slice(0, topK)
    .map((x) => x.s.candidate);
}

/**
 * Shadow comparison between the current naive selection and the ranked selection.
 * Used by the `VOICE_RANKING_SHADOW` harness to log both without changing behavior.
 */
export interface ShadowComparison {
  naive_selection_ids: string[];
  ranked_selection_ids: string[];
  naive_chars: number;
  ranked_chars: number;
  overlap_pct: number; // % of ranked ids also present in naive
}

export function compareSelections(
  naive: MemoryCandidate[],
  ranked: MemoryCandidate[],
): ShadowComparison {
  const naiveIds = naive.map((c) => c.id);
  const rankedIds = ranked.map((c) => c.id);
  const naiveSet = new Set(naiveIds);
  const overlap = rankedIds.filter((id) => naiveSet.has(id)).length;
  const chars = (cs: MemoryCandidate[]) => cs.reduce((sum, c) => sum + (c.content?.length ?? 0), 0);
  return {
    naive_selection_ids: naiveIds,
    ranked_selection_ids: rankedIds,
    naive_chars: chars(naive),
    ranked_chars: chars(ranked),
    overlap_pct: rankedIds.length === 0 ? 0 : Math.round((1000 * overlap) / rankedIds.length) / 10,
  };
}
