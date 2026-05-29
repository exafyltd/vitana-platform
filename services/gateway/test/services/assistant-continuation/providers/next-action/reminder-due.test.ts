/**
 * VTID-03057 (B0d-real slice Xb) — reminder-due source tests.
 *
 * Coverage:
 *   - Pure helpers: priorityForMinutes, computeMinutesUntil, renderLine
 *   - Source: produceReminderDue
 *     * No rows → skipped:no_eligible_record
 *     * Supabase error → skipped:source_unavailable
 *     * Exception → skipped:errored
 *     * One row within horizon → candidate with right priority + dedupeKey
 *     * Row beyond horizon (shouldn't happen given the .lte filter, but
 *       defensive computeMinutesUntil branch is also covered)
 */

import {
  produceReminderDue,
  priorityForMinutes,
  computeMinutesUntil,
  renderLine,
} from '../../../../../src/services/assistant-continuation/providers/next-action/sources/reminder-due';
import type { NextActionSourceContext } from '../../../../../src/services/assistant-continuation/providers/next-action/types';

function fakeSupabase(
  rows: unknown[] | null,
  err: { message: string } | null = null,
  shouldThrow = false,
): import('@supabase/supabase-js').SupabaseClient {
  // Chain mirrors the actual query:
  //   .from('reminders').select(...).eq(...).in(...).gte(...).lte(...).order(...).limit(...)
  const finalResult = err ? { data: null, error: err } : { data: rows, error: null };
  const chain = {
    eq: () => chain,
    in: () => chain,
    gte: () => chain,
    lte: () => chain,
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

describe('reminder-due pure helpers', () => {
  test('priorityForMinutes — banding', () => {
    expect(priorityForMinutes(5)).toBe(95);
    expect(priorityForMinutes(9)).toBe(95);
    expect(priorityForMinutes(10)).toBe(85);
    expect(priorityForMinutes(29)).toBe(85);
    expect(priorityForMinutes(30)).toBe(75);
    expect(priorityForMinutes(59)).toBe(75);
    expect(priorityForMinutes(60)).toBe(65);
    expect(priorityForMinutes(120)).toBe(65);
    expect(priorityForMinutes(121)).toBe(0);
  });

  test('computeMinutesUntil — direction + bad input', () => {
    expect(computeMinutesUntil('2026-05-18T08:30:00Z', '2026-05-18T08:00:00Z')).toBe(30);
    expect(computeMinutesUntil('2026-05-18T07:30:00Z', '2026-05-18T08:00:00Z')).toBe(-30);
    expect(Number.isNaN(computeMinutesUntil('not-a-date', '2026-05-18T08:00:00Z'))).toBe(true);
  });

  test('renderLine — picks EN/DE based on lang', () => {
    expect(renderLine('hydrate', 5, 'en')).toMatch(/coming up in 5 minutes/);
    expect(renderLine('Wasser trinken', 5, 'de')).toMatch(/in 5 Minuten/);
    expect(renderLine('walk', 90, 'en')).toMatch(/about 2 hours/);
    expect(renderLine('Spaziergang', 90, 'de')).toMatch(/2 Stunden/);
  });
});

describe('produceReminderDue source', () => {
  test('no rows → skipped:no_eligible_record', async () => {
    const r = await produceReminderDue(ctxWith(fakeSupabase([])));
    expect(r.candidate).toBeNull();
    expect(r.skippedReason).toBe('no_eligible_record');
  });

  test('null rows → skipped:no_eligible_record', async () => {
    const r = await produceReminderDue(ctxWith(fakeSupabase(null)));
    expect(r.candidate).toBeNull();
    expect(r.skippedReason).toBe('no_eligible_record');
  });

  test('Supabase error → skipped:source_unavailable', async () => {
    const r = await produceReminderDue(
      ctxWith(fakeSupabase(null, { message: 'rls denied' })),
    );
    expect(r.candidate).toBeNull();
    expect(r.skippedReason).toBe('source_unavailable');
  });

  test('thrown exception → skipped:errored (never propagates)', async () => {
    const r = await produceReminderDue(ctxWith(fakeSupabase(null, null, true)));
    expect(r.candidate).toBeNull();
    expect(r.skippedReason).toBe('errored');
  });

  test('one row 28min ahead → priority 85, confidence high, dedupe by id', async () => {
    const r = await produceReminderDue(
      ctxWith(
        fakeSupabase([
          {
            id: 'r-123',
            action_text: 'magnesium',
            spoken_message: 'take magnesium',
            next_fire_at: '2026-05-18T08:28:00Z',
            status: 'pending',
          },
        ]),
      ),
    );
    expect(r.candidate).not.toBeNull();
    if (!r.candidate) return;
    expect(r.candidate.source).toBe('reminder_due');
    expect(r.candidate.priority).toBe(85);
    expect(r.candidate.confidence).toBe('high');
    expect(r.candidate.dedupeKey).toBe('reminder_due:r-123');
    expect(r.candidate.userFacingLine).toContain('magnesium');
    expect(r.candidate.userFacingLine).toContain('28');
    expect(r.candidate.cta?.type).toBe('ask_permission');
    expect(r.candidate.reasons[0].kind).toBe('reminder_due_within_horizon');
  });

  test('one row 90min ahead → priority 65, confidence medium', async () => {
    const r = await produceReminderDue(
      ctxWith(
        fakeSupabase([
          {
            id: 'r-456',
            action_text: 'walk',
            spoken_message: null,
            next_fire_at: '2026-05-18T09:30:00Z',
            status: 'pending',
          },
        ]),
      ),
    );
    expect(r.candidate?.priority).toBe(65);
    expect(r.candidate?.confidence).toBe('medium');
  });

  test('empty action_text falls back to generic "reminder" label', async () => {
    const r = await produceReminderDue(
      ctxWith(
        fakeSupabase([
          {
            id: 'r-789',
            action_text: '',
            spoken_message: null,
            next_fire_at: '2026-05-18T08:15:00Z',
            status: 'pending',
          },
        ]),
      ),
    );
    expect(r.candidate?.userFacingLine.toLowerCase()).toContain('reminder');
  });
});
