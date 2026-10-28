/**
 * VTID-03058 (B0d-real slice Xc) — calendar-upcoming source tests.
 */

import {
  produceCalendarUpcoming,
  priorityForMinutes,
  computeMinutesUntil,
  renderLine,
} from '../../../../../src/services/assistant-continuation/providers/next-action/sources/calendar-upcoming';
import type { NextActionSourceContext } from '../../../../../src/services/assistant-continuation/providers/next-action/types';

function fakeSupabase(
  rows: unknown[] | null,
  err: { message: string } | null = null,
  shouldThrow = false,
): import('@supabase/supabase-js').SupabaseClient {
  const finalResult = err ? { data: null, error: err } : { data: rows, error: null };
  const chain = {
    eq: () => chain,
    gte: () => chain,
    lte: () => chain,
    order: () => chain,
    limit: () => (shouldThrow ? Promise.reject(new Error('boom')) : Promise.resolve(finalResult)),
  };
  return {
    from: () => ({ select: () => chain }),
    rpc: async () => ({ data: null, error: null }),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

function ctxWith(sb: import('@supabase/supabase-js').SupabaseClient, lang = 'en'): NextActionSourceContext {
  return {
    userId: 'u1',
    tenantId: 't1',
    lang,
    nowIso: '2026-05-18T08:00:00Z',
    decisionContext: null,
    supabase: sb,
  };
}

describe('calendar-upcoming pure helpers', () => {
  test('priorityForMinutes banding', () => {
    expect(priorityForMinutes(15)).toBe(92);
    expect(priorityForMinutes(29)).toBe(92);
    expect(priorityForMinutes(30)).toBe(82);
    expect(priorityForMinutes(119)).toBe(82);
    expect(priorityForMinutes(120)).toBe(72);
    expect(priorityForMinutes(359)).toBe(72);
    expect(priorityForMinutes(360)).toBe(62);
    expect(priorityForMinutes(24 * 60)).toBe(62);
    expect(priorityForMinutes(24 * 60 + 1)).toBe(0);
  });

  test('computeMinutesUntil', () => {
    expect(computeMinutesUntil('2026-05-18T09:00:00Z', '2026-05-18T08:00:00Z')).toBe(60);
    expect(Number.isNaN(computeMinutesUntil('garbage', '2026-05-18T08:00:00Z'))).toBe(true);
  });

  test('renderLine — bands', () => {
    expect(renderLine('Standup', 15, 'en')).toMatch(/starts in 15 minutes/);
    expect(renderLine('Meeting', 60, 'en')).toMatch(/60 minutes/);
    expect(renderLine('Workshop', 5 * 60, 'en')).toMatch(/about 5 hours/);
    expect(renderLine('Standup', 15, 'de')).toMatch(/In 15 Minuten/);
  });
});

describe('produceCalendarUpcoming source', () => {
  test('no rows → no_eligible_record', async () => {
    const r = await produceCalendarUpcoming(ctxWith(fakeSupabase([])));
    expect(r.candidate).toBeNull();
    expect(r.skippedReason).toBe('no_eligible_record');
  });

  test('supabase error → source_unavailable', async () => {
    const r = await produceCalendarUpcoming(
      ctxWith(fakeSupabase(null, { message: 'rls denied' })),
    );
    expect(r.skippedReason).toBe('source_unavailable');
  });

  test('throw → errored', async () => {
    const r = await produceCalendarUpcoming(ctxWith(fakeSupabase(null, null, true)));
    expect(r.skippedReason).toBe('errored');
  });

  test('event 15min ahead → priority 92, confidence high, dedupe by id', async () => {
    const r = await produceCalendarUpcoming(
      ctxWith(
        fakeSupabase([
          {
            id: 'evt-1',
            title: 'Team standup',
            start_time: '2026-05-18T08:15:00Z',
            end_time: '2026-05-18T08:30:00Z',
            status: 'scheduled',
            event_type: 'meeting',
          },
        ]),
      ),
    );
    expect(r.candidate?.priority).toBe(92);
    expect(r.candidate?.confidence).toBe('high');
    expect(r.candidate?.dedupeKey).toBe('calendar_upcoming:evt-1');
    expect(r.candidate?.userFacingLine).toContain('Team standup');
    expect(r.candidate?.cta?.type).toBe('ask_permission');
  });

  test('event 5h ahead → priority 72, confidence low', async () => {
    const r = await produceCalendarUpcoming(
      ctxWith(
        fakeSupabase([
          {
            id: 'evt-2',
            title: 'Workshop',
            start_time: '2026-05-18T13:00:00Z',
            end_time: null,
            status: 'scheduled',
            event_type: null,
          },
        ]),
      ),
    );
    expect(r.candidate?.priority).toBe(72);
    expect(r.candidate?.confidence).toBe('low');
  });

  test('empty title falls back to generic phrase', async () => {
    const r = await produceCalendarUpcoming(
      ctxWith(
        fakeSupabase([
          {
            id: 'evt-3',
            title: '',
            start_time: '2026-05-18T08:10:00Z',
            end_time: null,
            status: 'scheduled',
            event_type: null,
          },
        ]),
      ),
    );
    expect(r.candidate?.userFacingLine.toLowerCase()).toContain('event');
  });
});
