/**
 * Memory-hit relevance selection — Phase B wiring (ORB Memory Resilience).
 *
 * The pure relevance math lives in `memory-ranker.ts` (importance + recency +
 * optional embedding similarity). This sibling adapts the context-pack-builder's
 * `MemoryHit[]` to that pure ranker, applies the SAME size budget the naive path
 * uses, and produces a shadow comparison so naive-vs-ranked can be evaluated on
 * prod traffic before the feature flag is flipped.
 *
 * Pure + dependency-free (no Supabase, no fetch, no env reads, no clock except the
 * injected `now`). Gating on the OFF-by-default flag happens in the caller; this
 * module only computes selections so it can be exhaustively unit-tested.
 *
 * Design constraints honored here:
 *   - The output is a re-ordered + truncated subset of the SAME `MemoryHit`
 *     objects passed in (identity-preserving — no field rewrites).
 *   - `MemoryHit.importance` is on a 0..100 scale (e.g. 30, or
 *     round(confidence*100)); the pure ranker expects 0..1, so we normalize.
 *   - `MemoryHit` carries no embedding column today, so similarity degrades to
 *     0 and ranking reduces to importance+recency. The seam is left open: if an
 *     embedding ever lands on the hit, pass it through `embeddingOf`.
 */

import type { MemoryHit } from '../types/conversation';
import {
  rankMemory,
  compareSelections,
  type MemoryCandidate,
  type ShadowComparison,
} from './memory-ranker';

/** Map a MemoryHit (importance 0..100) to a pure-ranker candidate (importance 0..1). */
export function hitToCandidate(
  hit: MemoryHit,
  embeddingOf?: (hit: MemoryHit) => number[] | undefined,
): MemoryCandidate {
  const rawImportance = typeof hit.importance === 'number' ? hit.importance : 0;
  // MemoryHit importance is ALWAYS on a 0..100 scale (routes/memory.ts validates
  // 1..100; the mapper defaults to 30). Normalize the WHOLE range by /100 so a
  // stored importance of 1 maps to 0.01 — NOT 1.0. Special-casing ">1 looks
  // already normalized" was wrong: it let the lowest-importance memories (1)
  // score as MAXIMALLY important and push genuinely important hits out.
  const importance = Math.max(0, Math.min(1, rawImportance / 100));
  return {
    id: hit.id,
    content: hit.content ?? '',
    importance,
    occurred_at: hit.occurred_at,
    embedding: embeddingOf?.(hit),
  };
}

export interface RankHitsInputs {
  hits: MemoryHit[];
  /** Size budget — same cap the naive path enforces (MAX_MEMORY_HITS). */
  topK: number;
  now: Date;
  /** Optional intent/query embedding for the similarity term. */
  intentEmbedding?: number[];
  /** Optional accessor for a per-hit embedding (none today). */
  embeddingOf?: (hit: MemoryHit) => number[] | undefined;
}

/**
 * Relevance-rank `MemoryHit[]` and return the top-`topK` as the SAME hit objects
 * in ranked order. Pure; stable for tied scores (preserves input order).
 */
export function rankMemoryHits(inputs: RankHitsInputs): MemoryHit[] {
  const { hits, topK, now, intentEmbedding, embeddingOf } = inputs;
  if (topK <= 0 || hits.length === 0) return [];
  // Build candidates keyed by index so we can map the ranked candidates back to
  // the original MemoryHit objects without mutating or re-deriving them. The
  // index prefix also keeps hits that share an id distinct during ranking.
  const candidates = hits.map((h, i) => ({
    ...hitToCandidate(h, embeddingOf),
    id: `${i}::${h.id}`,
  }));
  const ranked = rankMemory({ candidates, intentEmbedding, now, topK });
  return ranked.map((c) => hits[Number((c.id as string).split('::')[0])]);
}

export interface ShadowResult {
  ranked: MemoryHit[];
  comparison: ShadowComparison;
}

/**
 * Compute the ranked selection under the SAME budget and diff it against the
 * naive selection for the shadow harness.
 *
 * `naiveOrdered` should be the hits in the order the naive path would keep them
 * (already relevance-sorted + sliced by the caller) so the comparison reflects
 * exactly what ships when the flag is off.
 */
export function shadowCompareHits(
  naiveOrdered: MemoryHit[],
  inputs: RankHitsInputs,
): ShadowResult {
  const ranked = rankMemoryHits(inputs);
  const toCmp = (hs: MemoryHit[]): MemoryCandidate[] =>
    hs.map((h) => ({
      id: h.id,
      content: h.content ?? '',
      importance: h.importance,
      occurred_at: h.occurred_at,
    }));
  const comparison = compareSelections(toCmp(naiveOrdered), toCmp(ranked));
  return { ranked, comparison };
}
