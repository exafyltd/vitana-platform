/**
 * VTID-03060 (B0d-real slice Xe) — continuity source tests.
 *
 * Both continuity-pending-thread and continuity-promise-owed consume
 * decisionContext.continuity (already compiled by the assistant decision
 * context compiler). Tests stub the supabase client to a no-op since
 * neither source queries the DB directly.
 */

import {
  produceContinuityPendingThread,
  extractContinuity,
  renderLine as renderThreadLine,
} from '../../../../../src/services/assistant-continuation/providers/next-action/sources/continuity-pending-thread';
import {
  produceContinuityPromiseOwed,
  rankPromise,
  renderLine as renderPromiseLine,
} from '../../../../../src/services/assistant-continuation/providers/next-action/sources/continuity-promise-owed';
import type { NextActionSourceContext } from '../../../../../src/services/assistant-continuation/providers/next-action/types';
import type { DecisionContinuity } from '../../../../../src/orb/context/types';

function fakeSupabase(): import('@supabase/supabase-js').SupabaseClient {
  return {
    from: () => ({}) as never,
    rpc: async () => ({ data: null, error: null }),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

function makeCont(over: Partial<DecisionContinuity> = {}): DecisionContinuity {
  return {
    open_threads: over.open_threads ?? [],
    promises_owed: over.promises_owed ?? [],
    promises_kept_recently: over.promises_kept_recently ?? [],
    counts: over.counts ?? {
      open_threads_total: (over.open_threads ?? []).length,
      promises_owed_total: (over.promises_owed ?? []).length,
      promises_overdue: 0,
      threads_mentioned_today: 0,
    },
    recommended_follow_up: over.recommended_follow_up ?? 'none',
  };
}

function ctxWith(decisionContext: unknown, lang = 'en'): NextActionSourceContext {
  return {
    userId: 'u1',
    tenantId: 't1',
    lang,
    nowIso: '2026-05-18T08:00:00Z',
    decisionContext,
    supabase: fakeSupabase(),
  };
}

// ---------------------------------------------------------------------------
// continuity-pending-thread
// ---------------------------------------------------------------------------

describe('continuity-pending-thread helpers', () => {
  test('extractContinuity is defensive', () => {
    expect(extractContinuity(null)).toBeNull();
    expect(extractContinuity({})).toBeNull();
    expect(extractContinuity({ continuity: null })).toBeNull();
    expect(extractContinuity({ continuity: 'oops' })).toBeNull();
    const c = makeCont();
    expect(extractContinuity({ continuity: c })).toEqual(c);
  });

  test('renderThreadLine — EN+DE recency', () => {
    expect(renderThreadLine('sleep tracker', null, 1, 'en')).toMatch(/yesterday.*"sleep tracker"/);
    expect(renderThreadLine('Schlaftracker', null, 1, 'de')).toMatch(/gestern.*"Schlaftracker"/);
    expect(renderThreadLine('hydration', 'aim for 2.5L', 3, 'en')).toMatch(
      /3 days ago about "hydration" — gist: aim for 2\.5L/,
    );
    expect(renderThreadLine('hydration', null, null, 'en')).toMatch(/a while back about "hydration"/);
  });
});

describe('produceContinuityPendingThread', () => {
  test('no continuity → no_data', async () => {
    const r = await produceContinuityPendingThread(ctxWith(null));
    expect(r.skippedReason).toBe('no_data');
  });

  test('empty open_threads → no_eligible_record', async () => {
    const r = await produceContinuityPendingThread(
      ctxWith({ continuity: makeCont() }),
    );
    expect(r.skippedReason).toBe('no_eligible_record');
  });

  test('thread present + recommended → priority 75 confidence high', async () => {
    const r = await produceContinuityPendingThread(
      ctxWith({
        continuity: makeCont({
          open_threads: [
            {
              thread_id: 't-1',
              topic: 'sleep tracker',
              summary: 'aim for 7h',
              days_since_last_mention: 1,
            },
          ],
          recommended_follow_up: 'mention_open_thread',
        }),
      }),
    );
    expect(r.candidate?.priority).toBe(75);
    expect(r.candidate?.confidence).toBe('high');
    expect(r.candidate?.dedupeKey).toBe('continuity_pending_thread:t-1');
    expect(r.candidate?.userFacingLine).toContain('"sleep tracker"');
  });

  test('thread present but recommended != mention_open_thread → priority 55 confidence medium', async () => {
    const r = await produceContinuityPendingThread(
      ctxWith({
        continuity: makeCont({
          open_threads: [
            {
              thread_id: 't-2',
              topic: 'meditation',
              summary: null,
              days_since_last_mention: 5,
            },
          ],
          recommended_follow_up: 'none',
        }),
      }),
    );
    expect(r.candidate?.priority).toBe(55);
    expect(r.candidate?.confidence).toBe('medium');
  });

  test('empty topic on first thread → no_eligible_record', async () => {
    const r = await produceContinuityPendingThread(
      ctxWith({
        continuity: makeCont({
          open_threads: [
            {
              thread_id: 't-3',
              topic: '   ',
              summary: null,
              days_since_last_mention: 2,
            },
          ],
        }),
      }),
    );
    expect(r.skippedReason).toBe('no_eligible_record');
  });
});

// ---------------------------------------------------------------------------
// continuity-promise-owed
// ---------------------------------------------------------------------------

describe('continuity-promise-owed helpers', () => {
  test('rankPromise — address_overdue_promise wins highest', () => {
    expect(
      rankPromise(makeCont({ recommended_follow_up: 'address_overdue_promise' }), true),
    ).toEqual({ priority: 88, confidence: 'high' });
  });
  test('rankPromise — overdue without recommendation', () => {
    expect(rankPromise(makeCont({ recommended_follow_up: 'none' }), true)).toEqual({
      priority: 78,
      confidence: 'high',
    });
  });
  test('rankPromise — not overdue', () => {
    expect(rankPromise(makeCont({ recommended_follow_up: 'none' }), false)).toEqual({
      priority: 60,
      confidence: 'medium',
    });
  });
  test('renderPromiseLine — EN+DE overdue + non-overdue', () => {
    expect(renderPromiseLine('the magnesium check', true, 'en')).toMatch(/I still owe you/);
    expect(renderPromiseLine('die Magnesium-Frage', true, 'de')).toMatch(/schulde dir noch/);
    expect(renderPromiseLine('the magnesium check', false, 'en')).toMatch(/circle back/);
  });
});

describe('produceContinuityPromiseOwed', () => {
  test('no continuity → no_data', async () => {
    const r = await produceContinuityPromiseOwed(ctxWith(null));
    expect(r.skippedReason).toBe('no_data');
  });

  test('empty promises_owed → no_eligible_record', async () => {
    const r = await produceContinuityPromiseOwed(ctxWith({ continuity: makeCont() }));
    expect(r.skippedReason).toBe('no_eligible_record');
  });

  test('overdue promise + recommended addressing → priority 88', async () => {
    const r = await produceContinuityPromiseOwed(
      ctxWith({
        continuity: makeCont({
          promises_owed: [
            {
              promise_id: 'p-1',
              promise_text: 'the magnesium check-in',
              overdue: true,
              decision_id: 'd-9',
            },
          ],
          recommended_follow_up: 'address_overdue_promise',
        }),
      }),
    );
    expect(r.candidate?.priority).toBe(88);
    expect(r.candidate?.confidence).toBe('high');
    expect(r.candidate?.dedupeKey).toBe('continuity_promise_owed:p-1');
    expect(r.candidate?.userFacingLine).toMatch(/owe you/);
    expect(r.candidate?.cta?.type).toBe('ask_permission');
  });

  test('non-overdue promise → priority 60', async () => {
    const r = await produceContinuityPromiseOwed(
      ctxWith({
        continuity: makeCont({
          promises_owed: [
            {
              promise_id: 'p-2',
              promise_text: 'the calendar review',
              overdue: false,
              decision_id: null,
            },
          ],
        }),
      }),
    );
    expect(r.candidate?.priority).toBe(60);
    expect(r.candidate?.confidence).toBe('medium');
  });

  test('empty promise_text → no_eligible_record', async () => {
    const r = await produceContinuityPromiseOwed(
      ctxWith({
        continuity: makeCont({
          promises_owed: [
            {
              promise_id: 'p-3',
              promise_text: '   ',
              overdue: true,
              decision_id: null,
            },
          ],
        }),
      }),
    );
    expect(r.skippedReason).toBe('no_eligible_record');
  });
});
