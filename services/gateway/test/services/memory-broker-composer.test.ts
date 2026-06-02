import {
  brokerMemory,
  isMemoryBrokerEnabled,
  applyCharBudget,
  DEFAULT_MEMORY_CHAR_BUDGET,
} from '../../src/services/memory-broker-composer';
import type { MemoryCandidate, ShadowComparison } from '../../src/services/memory-ranker';

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

// Silence the default console.log shadow line during tests by always injecting
// a logger; we assert on the returned comparison instead.
const noopLogger = () => {};

describe('isMemoryBrokerEnabled', () => {
  it('defaults OFF when unset/empty/garbage', () => {
    expect(isMemoryBrokerEnabled({})).toBe(false);
    expect(isMemoryBrokerEnabled({ FEATURE_MEMORY_BROKER: '' })).toBe(false);
    expect(isMemoryBrokerEnabled({ FEATURE_MEMORY_BROKER: 'no' })).toBe(false);
    expect(isMemoryBrokerEnabled({ FEATURE_MEMORY_BROKER: '0' })).toBe(false);
  });

  it('is ON for recognized truthy strings (case-insensitive)', () => {
    for (const v of ['1', 'true', 'TRUE', 'on', 'On', 'enabled', 'ENABLED', ' true ']) {
      expect(isMemoryBrokerEnabled({ FEATURE_MEMORY_BROKER: v })).toBe(true);
    }
  });
});

describe('applyCharBudget', () => {
  it('returns empty for non-positive budget', () => {
    expect(applyCharBudget([cand({ id: 'a' })], 0)).toEqual([]);
    expect(applyCharBudget([cand({ id: 'a' })], -10)).toEqual([]);
  });

  it('greedily keeps within budget and skips later oversized items', () => {
    const items = [
      cand({ id: 'a', content: 'x'.repeat(40) }),
      cand({ id: 'b', content: 'x'.repeat(40) }),
      cand({ id: 'c', content: 'x'.repeat(40) }),
    ];
    // Budget fits two (80) but not three (120).
    const kept = applyCharBudget(items, 80);
    expect(kept.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('always keeps the first item even if it exceeds the budget', () => {
    const kept = applyCharBudget(
      [cand({ id: 'big', content: 'x'.repeat(9999) }), cand({ id: 'small', content: 'x' })],
      10,
    );
    expect(kept.map((c) => c.id)).toEqual(['big']);
  });
});

describe('brokerMemory', () => {
  it('flag OFF → selected equals the NAIVE (input-order) selection', () => {
    // Make a clearly different ranked order: oldest+lowest-importance first in input.
    const candidates = [
      cand({ id: 'stale', importance: 0.0, occurred_at: daysAgo(120) }),
      cand({ id: 'fresh', importance: 1.0, occurred_at: daysAgo(0) }),
    ];
    const res = brokerMemory({
      query: 'remember my name',
      candidates,
      now: NOW,
      env: {}, // flag OFF
      logger: noopLogger,
    });
    expect(res.enabled).toBe(false);
    expect(res.selected).toBe(res.naive);
    expect(res.selected.map((c) => c.id)).toEqual(['stale', 'fresh']);
  });

  it('flag ON → selected equals the RANKED selection (fresh/important first)', () => {
    const candidates = [
      cand({ id: 'stale', importance: 0.0, occurred_at: daysAgo(120) }),
      cand({ id: 'fresh', importance: 1.0, occurred_at: daysAgo(0) }),
    ];
    const res = brokerMemory({
      query: 'remember my name',
      candidates,
      now: NOW,
      env: { FEATURE_MEMORY_BROKER: 'true' },
      logger: noopLogger,
    });
    expect(res.enabled).toBe(true);
    expect(res.selected).toBe(res.ranked);
    expect(res.selected.map((c) => c.id)).toEqual(['fresh', 'stale']);
  });

  it('routes via retrieval-router and derives topK from the memory_garden limit', () => {
    // "remember ... my" → personal_history rule, primary memory_garden.
    const res = brokerMemory({
      query: 'remember what I told you about my family',
      candidates: [],
      now: NOW,
      logger: noopLogger,
    });
    expect(res.routerDecision.matched_rule).toBe('personal_history');
    expect(res.routerDecision.sources_to_query).toContain('memory_garden');
    // Default memory_garden limit is 12.
    expect(res.topK).toBe(12);
  });

  it('respects limit_overrides passthrough to size topK', () => {
    const res = brokerMemory({
      query: 'remember my goal',
      candidates: Array.from({ length: 20 }, (_, i) => cand({ id: `c${i}` })),
      now: NOW,
      limitOverrides: { memory_garden: 5 },
      logger: noopLogger,
    });
    expect(res.topK).toBe(5);
    // Each candidate is 100 chars; budget default 6000 fits all 5.
    expect(res.naive).toHaveLength(5);
    expect(res.ranked).toHaveLength(5);
  });

  it('applies the char budget after ranking', () => {
    const candidates = Array.from({ length: 12 }, (_, i) =>
      cand({ id: `c${i}`, content: 'x'.repeat(1000) }),
    );
    const res = brokerMemory({
      query: 'remember my routine',
      candidates,
      now: NOW,
      charBudget: 2500, // fits 2 full (2000) but not 3 (3000)
      logger: noopLogger,
    });
    expect(res.selected.length).toBe(2);
    expect(res.charBudget).toBe(2500);
  });

  it('uses the default char budget when none provided', () => {
    const res = brokerMemory({
      query: 'remember my name',
      candidates: [cand({ id: 'a' })],
      now: NOW,
      logger: noopLogger,
    });
    expect(res.charBudget).toBe(DEFAULT_MEMORY_CHAR_BUDGET);
  });

  it('emits a shadow comparison by default and reports overlap', () => {
    let captured: ShadowComparison | undefined;
    const res = brokerMemory({
      query: 'remember my schedule',
      candidates: [
        cand({ id: 'stale', importance: 0.0, occurred_at: daysAgo(120) }),
        cand({ id: 'fresh', importance: 1.0, occurred_at: daysAgo(0) }),
      ],
      now: NOW,
      logger: (_line, comparison) => {
        captured = comparison;
      },
    });
    expect(res.shadow).toBeDefined();
    expect(captured).toBe(res.shadow);
    // Same two ids in both selections → 100% overlap regardless of order.
    expect(res.shadow!.overlap_pct).toBe(100);
    expect(new Set(res.shadow!.naive_selection_ids)).toEqual(
      new Set(res.shadow!.ranked_selection_ids),
    );
  });

  it('skips the shadow comparison when shadow=false', () => {
    const res = brokerMemory({
      query: 'remember my name',
      candidates: [cand({ id: 'a' })],
      now: NOW,
      shadow: false,
      logger: noopLogger,
    });
    expect(res.shadow).toBeUndefined();
  });
});
