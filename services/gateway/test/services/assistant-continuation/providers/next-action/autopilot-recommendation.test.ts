/**
 * VTID-03057 (B0d-real slice Xb) — autopilot-recommendation source tests.
 */

import {
  produceAutopilotRecommendation,
  normalizeConfidence,
  priorityForConfidence,
  recencyBoostForLastSeen,
  renderLine,
} from '../../../../../src/services/assistant-continuation/providers/next-action/sources/autopilot-recommendation';
import type { NextActionSourceContext } from '../../../../../src/services/assistant-continuation/providers/next-action/types';

function fakeSupabase(
  rows: unknown[] | null,
  err: { message: string } | null = null,
  shouldThrow = false,
): import('@supabase/supabase-js').SupabaseClient {
  // Chain mirrors the actual query:
  //   .from('autopilot_recommendations').select(...).eq(...).eq(...).neq(...).order(...).order(...).order(...).limit(...)
  const finalResult = err ? { data: null, error: err } : { data: rows, error: null };
  const chain = {
    eq: () => chain,
    neq: () => chain,
    order: () => chain,
    limit: () => (shouldThrow ? Promise.reject(new Error('boom')) : Promise.resolve(finalResult)),
  };
  return {
    from: () => ({
      select: () => chain,
    }),
    rpc: async () => ({ data: null, error: null }),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

function ctxWith(sb: import('@supabase/supabase-js').SupabaseClient): NextActionSourceContext {
  return {
    userId: 'u1',
    tenantId: 't1',
    lang: 'en',
    nowIso: '2026-05-18T08:00:00Z',
    decisionContext: null,
    supabase: sb,
  };
}

describe('autopilot-recommendation pure helpers', () => {
  test('normalizeConfidence', () => {
    expect(normalizeConfidence('high')).toBe('high');
    expect(normalizeConfidence('Medium')).toBe('medium');
    expect(normalizeConfidence('LOW')).toBe('low');
    expect(normalizeConfidence(0.9)).toBe('high');
    expect(normalizeConfidence(0.5)).toBe('medium');
    expect(normalizeConfidence(0.4)).toBe('low');
    expect(normalizeConfidence(null)).toBe('low');
    expect(normalizeConfidence(undefined)).toBe('low');
    expect(normalizeConfidence({})).toBe('low');
  });

  test('priorityForConfidence', () => {
    expect(priorityForConfidence('high')).toBe(88);
    expect(priorityForConfidence('medium')).toBe(78);
    expect(priorityForConfidence('low')).toBe(60);
  });

  test('recencyBoostForLastSeen', () => {
    // Within 24h
    expect(recencyBoostForLastSeen('2026-05-17T08:30:00Z', '2026-05-18T08:00:00Z')).toBe(3);
    // 25h+ ago
    expect(recencyBoostForLastSeen('2026-05-17T06:00:00Z', '2026-05-18T08:00:00Z')).toBe(0);
    // Missing → 0
    expect(recencyBoostForLastSeen(null, '2026-05-18T08:00:00Z')).toBe(0);
    // Garbage timestamp → 0
    expect(recencyBoostForLastSeen('not-a-date', '2026-05-18T08:00:00Z')).toBe(0);
  });

  test('renderLine', () => {
    expect(renderLine('Try water tracking', 'A small step on hydration.', 'en'))
      .toContain('water tracking');
    expect(renderLine('Beweg dich kurz', 'Kleiner Schritt.', 'de'))
      .toContain('Beweg dich kurz');
    // No summary path
    expect(renderLine('Title only', null, 'en')).toMatch(/take a look/);
    expect(renderLine('Nur Titel', null, 'de')).toMatch(/anschauen/);
  });
});

describe('produceAutopilotRecommendation source', () => {
  test('no rows → skipped:no_eligible_record', async () => {
    const r = await produceAutopilotRecommendation(ctxWith(fakeSupabase([])));
    expect(r.candidate).toBeNull();
    expect(r.skippedReason).toBe('no_eligible_record');
  });

  test('Supabase error → skipped:source_unavailable', async () => {
    const r = await produceAutopilotRecommendation(
      ctxWith(fakeSupabase(null, { message: 'rls denied' })),
    );
    expect(r.candidate).toBeNull();
    expect(r.skippedReason).toBe('source_unavailable');
  });

  test('throw → skipped:errored', async () => {
    const r = await produceAutopilotRecommendation(
      ctxWith(fakeSupabase(null, null, true)),
    );
    expect(r.candidate).toBeNull();
    expect(r.skippedReason).toBe('errored');
  });

  test('empty title → skipped:no_eligible_record', async () => {
    const r = await produceAutopilotRecommendation(
      ctxWith(
        fakeSupabase([
          {
            id: 'rec-1',
            title: '',
            summary: 'some summary',
            confidence: 'high',
            last_seen_at: null,
            created_at: '2026-05-18T07:00:00Z',
            domain: 'voice',
          },
        ]),
      ),
    );
    expect(r.candidate).toBeNull();
    expect(r.skippedReason).toBe('no_eligible_record');
  });

  test('high-confidence recent rec → priority 91 (88 + 3 boost)', async () => {
    const r = await produceAutopilotRecommendation(
      ctxWith(
        fakeSupabase([
          {
            id: 'rec-2',
            title: 'Try a 5-minute walk before lunch',
            summary: 'Easier than scheduled exercise; counts for the day.',
            confidence: 'high',
            last_seen_at: '2026-05-17T20:00:00Z', // 12h ago
            created_at: '2026-05-15T00:00:00Z',
            domain: 'exercise',
          },
        ]),
      ),
    );
    expect(r.candidate?.priority).toBe(91);
    expect(r.candidate?.confidence).toBe('high');
    expect(r.candidate?.dedupeKey).toBe('autopilot_recommendation:rec-2');
    expect(r.candidate?.userFacingLine).toContain('Try a 5-minute walk');
    expect(r.candidate?.reasons.length).toBe(2); // base + recency
  });

  test('high-confidence non-recent rec → priority 88 (no boost)', async () => {
    const r = await produceAutopilotRecommendation(
      ctxWith(
        fakeSupabase([
          {
            id: 'rec-3',
            title: 'Hydration check-in',
            summary: null,
            confidence: 'high',
            last_seen_at: '2026-05-15T08:00:00Z', // 3 days ago
            created_at: '2026-05-15T00:00:00Z',
            domain: 'hydration',
          },
        ]),
      ),
    );
    expect(r.candidate?.priority).toBe(88);
    expect(r.candidate?.reasons.length).toBe(1); // base only
  });

  test('low-confidence rec → priority 60, still above threshold', async () => {
    const r = await produceAutopilotRecommendation(
      ctxWith(
        fakeSupabase([
          {
            id: 'rec-4',
            title: 'Some weak suggestion',
            summary: null,
            confidence: 'low',
            last_seen_at: null,
            created_at: '2026-05-15T00:00:00Z',
            domain: null,
          },
        ]),
      ),
    );
    expect(r.candidate?.priority).toBe(60);
    expect(r.candidate?.confidence).toBe('low');
  });
});

describe('DEV-COMHU-0505 — autopilot CTA carries an executable on-yes tool', () => {
  test('candidate CTA wires activate_recommendation with the recommendation id', async () => {
    const r = await produceAutopilotRecommendation(
      ctxWith(
        fakeSupabase([
          {
            id: 'rec-cta',
            title: 'Schedule a focus block',
            summary: 'Protect 90 minutes tomorrow morning.',
            confidence: 'high',
            last_seen_at: '2026-05-17T20:00:00Z',
            created_at: '2026-05-15T00:00:00Z',
            domain: 'productivity',
          },
        ]),
      ),
    );
    const cta = r.candidate?.cta;
    expect(cta?.type).toBe('ask_permission');
    // The fix: every spoken permission offer now carries a deterministic on-yes
    // tool + the id, so "yes" invokes activate_recommendation (not a guess).
    expect((cta as { onYesTool?: string }).onYesTool).toBe('activate_recommendation');
    expect((cta as { payload?: Record<string, unknown> }).payload).toMatchObject({
      id: 'rec-cta',
      recommendation_id: 'rec-cta',
    });
  });
});
