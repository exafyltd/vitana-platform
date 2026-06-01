/**
 * Phase B wiring tests — memory-hit-ranking.ts (ORB Memory Resilience).
 *
 * The pure relevance math is covered by memory-ranker.test.ts. These tests
 * cover the MemoryHit ↔ ranker adapter that context-pack-builder uses:
 *   - importance normalization (0..100 → 0..1)
 *   - identity-preserving subset (same hit objects, re-ordered)
 *   - budget (topK) respected
 *   - shadow comparison shape (old order vs new order)
 */

import {
  hitToCandidate,
  rankMemoryHits,
  shadowCompareHits,
} from '../../src/services/memory-hit-ranking';
import type { MemoryHit } from '../../src/types/conversation';
import { isFeatureLive } from '../../src/services/feature-flags';

const NOW = new Date('2026-05-30T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

function hit(over: Partial<MemoryHit> & { id: string }): MemoryHit {
  return {
    category_key: 'conversation',
    content: 'x'.repeat(40),
    importance: 50, // 0..100 scale
    occurred_at: daysAgo(1),
    relevance_score: 0.5,
    source: 'memory_items',
    ...over,
  };
}

describe('Phase B feature flags default OFF (byte-for-byte no-op when unset)', () => {
  const RANKED = 'FEATURE_BOOTSTRAP_CONTEXT_RANKED_RETRIEVAL_ENV';
  const SHADOW = 'FEATURE_VOICE_RANKING_SHADOW_ENV';
  const saved = { ranked: process.env[RANKED], shadow: process.env[SHADOW] };
  afterEach(() => {
    if (saved.ranked === undefined) delete process.env[RANKED];
    else process.env[RANKED] = saved.ranked;
    if (saved.shadow === undefined) delete process.env[SHADOW];
    else process.env[SHADOW] = saved.shadow;
  });

  it('both Phase B flags resolve OFF when env vars are unset', () => {
    delete process.env[RANKED];
    delete process.env[SHADOW];
    expect(isFeatureLive('BOOTSTRAP_CONTEXT_RANKED_RETRIEVAL')).toBe(false);
    expect(isFeatureLive('VOICE_RANKING_SHADOW')).toBe(false);
  });

  it('ranked flag activates on staging+prod, stays off for unrecognized values', () => {
    process.env[RANKED] = 'garbage-value';
    expect(isFeatureLive('BOOTSTRAP_CONTEXT_RANKED_RETRIEVAL')).toBe(false);
    process.env[RANKED] = 'staging+prod';
    expect(isFeatureLive('BOOTSTRAP_CONTEXT_RANKED_RETRIEVAL')).toBe(true);
  });
});

describe('hitToCandidate', () => {
  it('normalizes 0..100 importance to 0..1', () => {
    expect(hitToCandidate(hit({ id: 'a', importance: 30 })).importance).toBeCloseTo(0.3, 5);
    expect(hitToCandidate(hit({ id: 'b', importance: 100 })).importance).toBeCloseTo(1, 5);
  });
  it('leaves already-normalized 0..1 importance untouched', () => {
    expect(hitToCandidate(hit({ id: 'c', importance: 0.4 })).importance).toBeCloseTo(0.4, 5);
  });
  it('carries id, content and occurred_at through; embedding from accessor', () => {
    const h = hit({ id: 'd', content: 'hello', occurred_at: daysAgo(3) });
    const c = hitToCandidate(h, () => [1, 2, 3]);
    expect(c).toMatchObject({ id: 'd', content: 'hello', occurred_at: daysAgo(3) });
    expect(c.embedding).toEqual([1, 2, 3]);
  });
});

describe('rankMemoryHits', () => {
  it('returns the SAME hit objects, re-ordered (identity preserved)', () => {
    const a = hit({ id: 'a', importance: 10, occurred_at: daysAgo(2) });
    const b = hit({ id: 'b', importance: 90, occurred_at: daysAgo(2) });
    const out = rankMemoryHits({ hits: [a, b], topK: 2, now: NOW });
    expect(out[0]).toBe(b); // higher importance ranks first (same reference)
    expect(out[1]).toBe(a);
  });

  it('respects the topK budget', () => {
    const hits = Array.from({ length: 30 }, (_, i) => hit({ id: String(i) }));
    expect(rankMemoryHits({ hits, topK: 25, now: NOW })).toHaveLength(25);
  });

  it('ranks recent over stale at equal importance', () => {
    const recent = hit({ id: 'recent', importance: 50, occurred_at: daysAgo(1) });
    const stale = hit({ id: 'stale', importance: 50, occurred_at: daysAgo(300) });
    const out = rankMemoryHits({ hits: [stale, recent], topK: 1, now: NOW });
    expect(out[0].id).toBe('recent');
  });

  it('keeps the most useful subset under a tight cap (heavy-user drop)', () => {
    const hits = [
      hit({ id: 'old-trivial', importance: 5, occurred_at: daysAgo(200) }),
      hit({ id: 'recent-important', importance: 95, occurred_at: daysAgo(1) }),
      hit({ id: 'mid', importance: 50, occurred_at: daysAgo(15) }),
    ];
    const out = rankMemoryHits({ hits, topK: 2, now: NOW });
    expect(out.map((h) => h.id)).toEqual(['recent-important', 'mid']);
  });

  it('handles duplicate ids without collapsing them', () => {
    const a = hit({ id: 'dup', importance: 90, occurred_at: daysAgo(1) });
    const b = hit({ id: 'dup', importance: 10, occurred_at: daysAgo(1) });
    const out = rankMemoryHits({ hits: [a, b], topK: 2, now: NOW });
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(a);
  });

  it('empty input and non-positive topK return empty', () => {
    expect(rankMemoryHits({ hits: [], topK: 5, now: NOW })).toEqual([]);
    expect(rankMemoryHits({ hits: [hit({ id: 'a' })], topK: 0, now: NOW })).toEqual([]);
  });
});

describe('shadowCompareHits (shadow harness)', () => {
  it('returns a ranked selection plus a comparison of old vs new order', () => {
    const naive = [
      hit({ id: 'a', content: 'aa', importance: 50, occurred_at: daysAgo(200) }),
      hit({ id: 'b', content: 'bbb', importance: 50, occurred_at: daysAgo(1) }),
    ];
    const { ranked, comparison } = shadowCompareHits(naive, {
      hits: naive,
      topK: 2,
      now: NOW,
    });
    // ranked re-orders by relevance (recent 'b' first)
    expect(ranked.map((h) => h.id)).toEqual(['b', 'a']);
    expect(comparison.naive_selection_ids).toEqual(['a', 'b']);
    expect(comparison.ranked_selection_ids).toEqual(['b', 'a']);
    expect(comparison.naive_chars).toBe(5);
    expect(comparison.ranked_chars).toBe(5);
    expect(comparison.overlap_pct).toBe(100); // same set, different order
  });

  it('reports reduced overlap when ranking drops a naive pick under a tighter cap', () => {
    const hits = [
      hit({ id: 'old', content: 'oo', importance: 10, occurred_at: daysAgo(300) }),
      hit({ id: 'fresh', content: 'ff', importance: 90, occurred_at: daysAgo(1) }),
    ];
    // naive keeps both (cap 2); ranked under cap 1 keeps only 'fresh'
    const { ranked, comparison } = shadowCompareHits(hits, { hits, topK: 1, now: NOW });
    expect(ranked.map((h) => h.id)).toEqual(['fresh']);
    expect(comparison.ranked_selection_ids).toEqual(['fresh']);
    expect(comparison.overlap_pct).toBe(100); // fresh is in the naive set
  });
});
