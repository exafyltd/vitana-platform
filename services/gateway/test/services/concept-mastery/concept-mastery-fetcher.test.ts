/**
 * VTID-02936 (B3) — Supabase-backed ConceptMasteryFetcher tests.
 *
 * Verifies:
 *   - Read-only interface — no mutator methods exposed (B3 wall).
 *   - DB unavailable / error → empty arrays + source_health reason.
 *   - Single round-trip query split by signal_name prefix in JS.
 *   - Row mapping handles missing / wrong-type columns defensively.
 *   - Limit clamping (1..500, default 200).
 *   - Mastery confidence coerced to [0, 1].
 */

import {
  createSupabaseConceptMasteryFetcher,
  mapConceptExplainedRow,
  mapConceptMasteryRow,
  mapDykCardSeenRow,
  splitByFamily,
} from '../../../src/services/concept-mastery/concept-mastery-fetcher';

function makeFakeClient(behavior: {
  rows?: unknown[];
  error?: unknown;
  captureLimit?: (n: number) => void;
}) {
  const client = {
    from(_table: string) {
      const builder: any = {
        select() { return builder; },
        eq() { return builder; },
        or() { return builder; },
        order() { return builder; },
        limit(n: number) {
          if (behavior.captureLimit) behavior.captureLimit(n);
          return builder;
        },
        async then(resolve: (v: unknown) => void) {
          resolve({
            data: behavior.error ? null : (behavior.rows ?? []),
            error: behavior.error ?? null,
          });
        },
      };
      return builder;
    },
  };
  return client;
}

describe('B3 — Supabase-backed ConceptMasteryFetcher', () => {
  describe('read-only contract (B3 wall)', () => {
    it('ConceptMasteryFetcher interface exposes ONLY listConceptState', () => {
      const fetcher = createSupabaseConceptMasteryFetcher({ getDb: (() => null) as any });
      const keys = Object.keys(fetcher).sort();
      expect(keys).toEqual(['listConceptState']);
    });
  });

  describe('DB unavailable', () => {
    it('returns ok:false + empty arrays + reason when getSupabase returns null', async () => {
      const fetcher = createSupabaseConceptMasteryFetcher({ getDb: (() => null) as any });
      const r = await fetcher.listConceptState({ tenantId: 't', userId: 'u' });
      expect(r.ok).toBe(false);
      expect(r.concepts_explained).toEqual([]);
      expect(r.concepts_mastered).toEqual([]);
      expect(r.dyk_cards_seen).toEqual([]);
      expect(r.reason).toBe('supabase_unconfigured');
    });

    it('returns ok:false + empty arrays + reason on Supabase error', async () => {
      const client = makeFakeClient({ error: { message: 'boom' } });
      const fetcher = createSupabaseConceptMasteryFetcher({ getDb: (() => client) as any });
      const r = await fetcher.listConceptState({ tenantId: 't', userId: 'u' });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('boom');
      expect(r.concepts_explained).toEqual([]);
    });
  });

  describe('happy path', () => {
    it('splits a mixed row set by signal_name prefix', async () => {
      const client = makeFakeClient({
        rows: [
          { signal_name: 'concept_explained:vitana_index', count: 2, last_seen_at: '2026-05-10T12:00:00Z', source: 'orb_turn' },
          { signal_name: 'concept_mastery:vitana_index',   confidence: 0.85, last_seen_at: '2026-05-11T08:00:00Z', source: 'inferred' },
          { signal_name: 'dyk_card_seen:dyk_index_intro',  count: 1, last_seen_at: '2026-05-09T20:00:00Z' },
          { signal_name: 'unrelated:foo',                  count: 1, last_seen_at: '2026-05-09T20:00:00Z' },
        ],
      });
      const fetcher = createSupabaseConceptMasteryFetcher({ getDb: (() => client) as any });
      const r = await fetcher.listConceptState({ tenantId: 't', userId: 'u' });
      expect(r.ok).toBe(true);
      expect(r.concepts_explained).toHaveLength(1);
      expect(r.concepts_explained[0].concept_key).toBe('vitana_index');
      expect(r.concepts_mastered).toHaveLength(1);
      expect(r.concepts_mastered[0].confidence).toBeCloseTo(0.85);
      expect(r.dyk_cards_seen).toHaveLength(1);
      expect(r.dyk_cards_seen[0].card_key).toBe('dyk_index_intro');
    });

    it('returns empty arrays when no rows match', async () => {
      const client = makeFakeClient({ rows: [] });
      const fetcher = createSupabaseConceptMasteryFetcher({ getDb: (() => client) as any });
      const r = await fetcher.listConceptState({ tenantId: 't', userId: 'u' });
      expect(r.ok).toBe(true);
      expect(r.concepts_explained).toEqual([]);
      expect(r.concepts_mastered).toEqual([]);
      expect(r.dyk_cards_seen).toEqual([]);
    });
  });

  describe('limit clamping', () => {
    it('clamps undefined → 200', async () => {
      let captured = -1;
      const client = makeFakeClient({ rows: [], captureLimit: (n) => { captured = n; } });
      const fetcher = createSupabaseConceptMasteryFetcher({ getDb: (() => client) as any });
      await fetcher.listConceptState({ tenantId: 't', userId: 'u' });
      expect(captured).toBe(200);
    });

    it('clamps > 500 to 500', async () => {
      let captured = -1;
      const client = makeFakeClient({ rows: [], captureLimit: (n) => { captured = n; } });
      const fetcher = createSupabaseConceptMasteryFetcher({ getDb: (() => client) as any });
      await fetcher.listConceptState({ tenantId: 't', userId: 'u', limit: 9999 });
      expect(captured).toBe(500);
    });

    it('clamps < 1 to 1', async () => {
      let captured = -1;
      const client = makeFakeClient({ rows: [], captureLimit: (n) => { captured = n; } });
      const fetcher = createSupabaseConceptMasteryFetcher({ getDb: (() => client) as any });
      await fetcher.listConceptState({ tenantId: 't', userId: 'u', limit: 0 });
      expect(captured).toBe(1);
    });
  });

  describe('splitByFamily defensives', () => {
    it('ignores rows with no colon in signal_name', () => {
      const r = splitByFamily([
        { signal_name: 'no_colon', count: 1, last_seen_at: '2026-05-10T00:00:00Z' },
      ]);
      expect(r.concepts_explained).toEqual([]);
      expect(r.concepts_mastered).toEqual([]);
      expect(r.dyk_cards_seen).toEqual([]);
    });

    it('ignores rows where the suffix after colon is empty', () => {
      const r = splitByFamily([
        { signal_name: 'concept_explained:', count: 1, last_seen_at: '2026-05-10T00:00:00Z' },
      ]);
      expect(r.concepts_explained).toEqual([]);
    });

    it('ignores unknown families', () => {
      const r = splitByFamily([
        { signal_name: 'made_up_family:foo', count: 1, last_seen_at: '2026-05-10T00:00:00Z' },
      ]);
      expect(r.concepts_explained).toEqual([]);
      expect(r.concepts_mastered).toEqual([]);
      expect(r.dyk_cards_seen).toEqual([]);
    });

    it('preserves the key portion verbatim, including embedded colons after the first', () => {
      const r = splitByFamily([
        { signal_name: 'concept_explained:vitana_index:detail', count: 1, last_seen_at: '2026-05-10T00:00:00Z' },
      ]);
      expect(r.concepts_explained[0].concept_key).toBe('vitana_index:detail');
    });
  });

  describe('row mappers', () => {
    it('mapConceptExplainedRow handles a completely empty row', () => {
      const r = mapConceptExplainedRow({}, 'vitana_index');
      expect(r.concept_key).toBe('vitana_index');
      expect(r.count).toBe(0);
      expect(r.last_explained_at).toBe('');
      expect(r.source).toBeNull();
    });

    it('mapConceptExplainedRow coerces negative count to 0', () => {
      const r = mapConceptExplainedRow({ count: -5 }, 'x');
      expect(r.count).toBe(0);
    });

    it('mapConceptMasteryRow clamps confidence to [0, 1]', () => {
      expect(mapConceptMasteryRow({ confidence: 1.5 }, 'x').confidence).toBe(1);
      expect(mapConceptMasteryRow({ confidence: -0.3 }, 'x').confidence).toBe(0);
      expect(mapConceptMasteryRow({ confidence: 0.5 }, 'x').confidence).toBe(0.5);
    });

    it('mapConceptMasteryRow parses string confidence', () => {
      const r = mapConceptMasteryRow({ confidence: '0.72' }, 'x');
      expect(r.confidence).toBeCloseTo(0.72);
    });

    it('mapConceptMasteryRow returns null confidence for garbage', () => {
      expect(mapConceptMasteryRow({ confidence: 'huh' }, 'x').confidence).toBeNull();
      expect(mapConceptMasteryRow({}, 'x').confidence).toBeNull();
    });

    it('mapDykCardSeenRow handles a completely empty row', () => {
      const r = mapDykCardSeenRow({}, 'dyk_index_intro');
      expect(r.card_key).toBe('dyk_index_intro');
      expect(r.count).toBe(0);
      expect(r.last_seen_at).toBe('');
    });
  });
});
