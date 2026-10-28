/**
 * R7 (BOOTSTRAP-ORB-R6R7-PROVIDERS) — goal-completion-inquiry provider tests.
 *
 * Locks the contract:
 *   - Fires (status=returned, priority 92) when the active goal's
 *     target_date is in the past (end-of-day UTC).
 *   - Suppresses when no active goal / no target_date / target not yet past.
 *   - Skips on missing inputs. Errors on DB error.
 *   - End-of-day-UTC boundary: a goal due today is NOT yet complete.
 *   - dedupeKey keyed on the life_compass row id (one inquiry per goal).
 *   - EN + DE content both present and authored (real DE, not a copy of EN).
 */

import {
  makeGoalCompletionInquiryProvider,
  GOAL_COMPLETION_PROVIDER_KEY,
  GOAL_COMPLETION_EXTRA_KEY,
  GOAL_COMPLETION_PRIORITY,
  isTargetDateInPastEndOfDayUtc,
} from '../../../../../src/services/assistant-continuation/providers/goal-completion-inquiry';
import {
  renderGoalCompletionLine,
  GOAL_COMPLETION_LOCALES,
} from '../../../../../src/services/assistant-continuation/providers/goal-completion-inquiry/content';

interface CompassRow {
  id: string;
  primary_goal: string | null;
  target_date: string | null;
  is_active: boolean;
}

function makeFakeSupabase(row: CompassRow | null, errorMsg?: string) {
  const captured: any = { queriedTable: null };
  const sb = {
    from(table: string) {
      const builder: any = {
        select() {
          return builder;
        },
        eq() {
          return builder;
        },
        async maybeSingle() {
          captured.queriedTable = table;
          if (errorMsg) return { data: null, error: { message: errorMsg } };
          return { data: row, error: null };
        },
      };
      return builder;
    },
  } as any;
  return { sb, captured };
}

// 2026-06-15T10:30Z — used as the fixed "now" for past-date checks.
const NOW_MS = Date.parse('2026-06-15T10:30:00.000Z');

function makeCtx(extraOverride: any = {}, sbOverride?: any) {
  return {
    surface: 'orb_wake',
    sessionId: 's1',
    userId: 'u1',
    tenantId: 't1',
    extra: {
      [GOAL_COMPLETION_EXTRA_KEY]: {
        supabase:
          sbOverride ??
          makeFakeSupabase({
            id: 'lc-1',
            primary_goal: 'Run a 10k',
            target_date: '2026-06-01',
            is_active: true,
          }).sb,
        userId: 'u1',
        tenantId: 't1',
        lang: 'en',
        firstName: 'Dragan',
        ...extraOverride,
      },
    },
  } as any;
}

describe('R7 isTargetDateInPastEndOfDayUtc', () => {
  const now = new Date(NOW_MS); // 2026-06-15

  it('returns true for a date strictly before today', () => {
    expect(isTargetDateInPastEndOfDayUtc('2026-06-01', now)).toBe(true);
  });

  it('returns false for today (not yet end-of-day past)', () => {
    expect(isTargetDateInPastEndOfDayUtc('2026-06-15', now)).toBe(false);
  });

  it('returns false for a future date', () => {
    expect(isTargetDateInPastEndOfDayUtc('2026-07-01', now)).toBe(false);
  });

  it('accepts full ISO timestamps (uses date portion)', () => {
    expect(isTargetDateInPastEndOfDayUtc('2026-06-01T00:00:00.000Z', now)).toBe(true);
  });

  it('returns false for null / malformed input (fail-closed)', () => {
    expect(isTargetDateInPastEndOfDayUtc(null, now)).toBe(false);
    expect(isTargetDateInPastEndOfDayUtc('not-a-date', now)).toBe(false);
  });

  it('only flips the day AFTER the target — end-of-day boundary', () => {
    // target = yesterday relative to now; end-of-day yesterday < now → true
    const justAfterMidnight = new Date(Date.parse('2026-06-16T00:00:01.000Z'));
    expect(isTargetDateInPastEndOfDayUtc('2026-06-15', justAfterMidnight)).toBe(true);
    // but at 23:59:59 on the target day itself → still not past
    const lateSameDay = new Date(Date.parse('2026-06-15T23:59:59.000Z'));
    expect(isTargetDateInPastEndOfDayUtc('2026-06-15', lateSameDay)).toBe(false);
  });
});

describe('R7 goal-completion content', () => {
  it('exposes both EN and DE locales', () => {
    expect(GOAL_COMPLETION_LOCALES).toContain('en');
    expect(GOAL_COMPLETION_LOCALES).toContain('de');
  });

  it('renders an EN celebration + invitation', () => {
    const line = renderGoalCompletionLine({ lang: 'en', firstName: null, goalText: null });
    expect(line).toMatch(/hit your target/i);
    expect(line).toMatch(/next one together|take a moment/i);
  });

  it('renders a REAL German script (not a copy of EN)', () => {
    const de = renderGoalCompletionLine({ lang: 'de', firstName: null, goalText: null });
    const en = renderGoalCompletionLine({ lang: 'en', firstName: null, goalText: null });
    expect(de).not.toEqual(en);
    expect(de).toMatch(/Ziel erreicht/);
    expect(de).toMatch(/durchatmen|nächste Ziel/);
  });

  it('weaves the goal text in when present', () => {
    const line = renderGoalCompletionLine({
      lang: 'en',
      firstName: null,
      goalText: 'Run a 10k',
    });
    expect(line).toMatch(/Run a 10k/);
  });

  it('weaves the firstName in when present', () => {
    const line = renderGoalCompletionLine({ lang: 'en', firstName: 'Dragan', goalText: null });
    expect(line).toMatch(/^Dragan,/);
  });

  it('falls back to EN for an unknown locale', () => {
    const unknown = renderGoalCompletionLine({ lang: 'zz', firstName: null, goalText: null });
    const en = renderGoalCompletionLine({ lang: 'en', firstName: null, goalText: null });
    expect(unknown).toEqual(en);
  });
});

describe('R7 goal-completion-inquiry provider', () => {
  const baseOpts = {
    newId: () => 'fixed-id',
    now: () => NOW_MS,
  };

  it('has the right key and orb_wake surface', () => {
    const p = makeGoalCompletionInquiryProvider(baseOpts);
    expect(p.key).toBe(GOAL_COMPLETION_PROVIDER_KEY);
    expect(p.surfaces).toEqual(['orb_wake']);
  });

  it('fires with priority 92 when the active goal target_date is past', async () => {
    const { sb } = makeFakeSupabase({
      id: 'lc-1',
      primary_goal: 'Run a 10k',
      target_date: '2026-06-01',
      is_active: true,
    });
    const p = makeGoalCompletionInquiryProvider(baseOpts);
    const res = await p.produce(makeCtx({}, sb));
    expect(res.status).toBe('returned');
    expect(res.candidate?.priority).toBe(GOAL_COMPLETION_PRIORITY);
    expect(res.candidate?.priority).toBe(92);
    expect(res.candidate?.kind).toBe('check_in');
    expect(res.candidate?.surface).toBe('orb_wake');
    expect(res.candidate?.userFacingLine).toMatch(/Run a 10k/);
    expect(res.candidate?.dedupeKey).toBe('goal-completion-inquiry:lc-1');
  });

  it('suppresses when target_date is not yet past', async () => {
    const { sb } = makeFakeSupabase({
      id: 'lc-1',
      primary_goal: 'Run a 10k',
      target_date: '2026-07-01',
      is_active: true,
    });
    const p = makeGoalCompletionInquiryProvider(baseOpts);
    const res = await p.produce(makeCtx({}, sb));
    expect(res.status).toBe('suppressed');
    expect(res.reason).toMatch(/target_date_not_past/);
  });

  it('suppresses when there is no active goal', async () => {
    const { sb } = makeFakeSupabase(null);
    const p = makeGoalCompletionInquiryProvider(baseOpts);
    const res = await p.produce(makeCtx({}, sb));
    expect(res.status).toBe('suppressed');
    expect(res.reason).toBe('no_active_life_compass');
  });

  it('suppresses when the active goal has no target_date', async () => {
    const { sb } = makeFakeSupabase({
      id: 'lc-1',
      primary_goal: 'Run a 10k',
      target_date: null,
      is_active: true,
    });
    const p = makeGoalCompletionInquiryProvider(baseOpts);
    const res = await p.produce(makeCtx({}, sb));
    expect(res.status).toBe('suppressed');
    expect(res.reason).toBe('no_target_date');
  });

  it('skips when inputs are missing', async () => {
    const p = makeGoalCompletionInquiryProvider(baseOpts);
    const res = await p.produce({ surface: 'orb_wake', extra: {} } as any);
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('no_goal_completion_inputs');
  });

  it('errors on a DB error', async () => {
    const { sb } = makeFakeSupabase(null, 'boom');
    const p = makeGoalCompletionInquiryProvider(baseOpts);
    const res = await p.produce(makeCtx({}, sb));
    expect(res.status).toBe('errored');
    expect(res.reason).toMatch(/boom/);
  });

  it('renders the DE line when lang=de and fires', async () => {
    const { sb } = makeFakeSupabase({
      id: 'lc-1',
      primary_goal: null,
      target_date: '2026-06-01',
      is_active: true,
    });
    const p = makeGoalCompletionInquiryProvider(baseOpts);
    const res = await p.produce(makeCtx({ lang: 'de', firstName: null }, sb));
    expect(res.status).toBe('returned');
    expect(res.candidate?.userFacingLine).toMatch(/Ziel erreicht/);
  });
});
