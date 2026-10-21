import {
  clamp01,
  recencyDecay,
  cosineSimilarity,
  scoreMemory,
  rankMemory,
  compareSelections,
  RECENCY_HALFLIFE_DAYS,
  type MemoryCandidate,
} from '../../src/services/memory-ranker';

const NOW = new Date('2026-05-30T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

function cand(over: Partial<MemoryCandidate> & { id: string }): MemoryCandidate {
  return {
    content: 'x'.repeat(100),
    importance: 0.5,
    occurred_at: daysAgo(1),
    ...over,
  };
}

describe('clamp01', () => {
  it('clamps out-of-range and non-finite to [0,1]', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(NaN)).toBe(0);
    expect(clamp01(Infinity)).toBe(1);
  });
});

describe('recencyDecay', () => {
  it('is 1.0 for "now" and decays toward 0', () => {
    expect(recencyDecay(NOW.toISOString(), NOW)).toBeCloseTo(1, 5);
    expect(recencyDecay(daysAgo(RECENCY_HALFLIFE_DAYS), NOW)).toBeCloseTo(Math.exp(-1), 5);
    expect(recencyDecay(daysAgo(365), NOW)).toBeLessThan(0.01);
  });
  it('clamps future timestamps to 1.0 and unparseable to 0', () => {
    expect(recencyDecay(daysAgo(-5), NOW)).toBe(1); // 5 days in the future
    expect(recencyDecay('not-a-date', NOW)).toBe(0);
  });
});

describe('cosineSimilarity', () => {
  it('maps identical vectors to 1 and opposite to 0', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(0, 5);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.5, 5); // orthogonal → midpoint
  });
  it('returns 0 for missing / mismatched / zero vectors', () => {
    expect(cosineSimilarity(undefined, [1])).toBe(0);
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });
});

describe('scoreMemory', () => {
  it('weights importance 0.4 + recency 0.4 + similarity 0.2', () => {
    const c = cand({ id: 'a', importance: 1, occurred_at: NOW.toISOString(), embedding: [1, 0] });
    const [scored] = scoreMemory({ candidates: [c], intentEmbedding: [1, 0], now: NOW });
    // importance 1*0.4 + recency 1*0.4 + similarity 1*0.2 = 1.0
    expect(scored.score).toBeCloseTo(1.0, 5);
  });
  it('omits similarity when no intent embedding', () => {
    const c = cand({ id: 'a', importance: 1, occurred_at: NOW.toISOString(), embedding: [1, 0] });
    const [scored] = scoreMemory({ candidates: [c], now: NOW });
    expect(scored.score).toBeCloseTo(0.8, 5); // 0.4 + 0.4, no similarity term
  });
});

describe('rankMemory', () => {
  it('returns at most topK candidates', () => {
    const cands = Array.from({ length: 10 }, (_, i) => cand({ id: String(i) }));
    expect(rankMemory({ candidates: cands, now: NOW, topK: 3 })).toHaveLength(3);
  });

  it('topK <= 0 returns empty', () => {
    const cands = [cand({ id: 'a' })];
    expect(rankMemory({ candidates: cands, now: NOW, topK: 0 })).toEqual([]);
  });

  it('high importance dominates low importance at equal recency', () => {
    const hi = cand({ id: 'hi', importance: 0.9, occurred_at: daysAgo(2) });
    const lo = cand({ id: 'lo', importance: 0.1, occurred_at: daysAgo(2) });
    const out = rankMemory({ candidates: [lo, hi], now: NOW, topK: 1 });
    expect(out[0].id).toBe('hi');
  });

  it('recent dominates stale at equal importance', () => {
    const recent = cand({ id: 'recent', importance: 0.5, occurred_at: daysAgo(1) });
    const stale = cand({ id: 'stale', importance: 0.5, occurred_at: daysAgo(200) });
    const out = rankMemory({ candidates: [stale, recent], now: NOW, topK: 1 });
    expect(out[0].id).toBe('recent');
  });

  it('embedding match can lift an otherwise-weaker candidate', () => {
    const intent = [1, 0, 0];
    const match = cand({ id: 'match', importance: 0.3, occurred_at: daysAgo(10), embedding: [1, 0, 0] });
    const noMatch = cand({ id: 'noMatch', importance: 0.35, occurred_at: daysAgo(10), embedding: [0, 1, 0] });
    const out = rankMemory({ candidates: [noMatch, match], intentEmbedding: intent, now: NOW, topK: 1 });
    expect(out[0].id).toBe('match');
  });

  it('is stable for tied scores (preserves input order)', () => {
    const a = cand({ id: 'a', importance: 0.5, occurred_at: daysAgo(1) });
    const b = cand({ id: 'b', importance: 0.5, occurred_at: daysAgo(1) });
    const out = rankMemory({ candidates: [a, b], now: NOW, topK: 2 });
    expect(out.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('heavy-user drop: keeps the most useful subset under a tight cap', () => {
    const cands: MemoryCandidate[] = [
      cand({ id: 'old-trivial', importance: 0.1, occurred_at: daysAgo(180) }),
      cand({ id: 'recent-important', importance: 0.9, occurred_at: daysAgo(1) }),
      cand({ id: 'mid', importance: 0.5, occurred_at: daysAgo(15) }),
    ];
    const out = rankMemory({ candidates: cands, now: NOW, topK: 2 });
    expect(out.map((c) => c.id)).toEqual(['recent-important', 'mid']);
  });

  it('light user: returns everything when topK exceeds count', () => {
    const cands = [cand({ id: 'a' }), cand({ id: 'b' })];
    expect(rankMemory({ candidates: cands, now: NOW, topK: 50 })).toHaveLength(2);
  });
});

describe('compareSelections (shadow harness)', () => {
  it('reports overlap pct, ids, and char totals', () => {
    const naive = [cand({ id: 'a', content: 'aa' }), cand({ id: 'b', content: 'bbb' })];
    const ranked = [cand({ id: 'a', content: 'aa' }), cand({ id: 'c', content: 'cccc' })];
    const cmp = compareSelections(naive, ranked);
    expect(cmp.naive_selection_ids).toEqual(['a', 'b']);
    expect(cmp.ranked_selection_ids).toEqual(['a', 'c']);
    expect(cmp.naive_chars).toBe(5);
    expect(cmp.ranked_chars).toBe(6);
    expect(cmp.overlap_pct).toBe(50); // 1 of 2 ranked ids in naive
  });
  it('overlap is 0 for an empty ranked selection', () => {
    expect(compareSelections([cand({ id: 'a' })], []).overlap_pct).toBe(0);
  });
});
