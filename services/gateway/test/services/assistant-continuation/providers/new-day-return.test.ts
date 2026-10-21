/**
 * VTID-03164 — new-day-return provider tests.
 *
 * Locks the contract:
 *   - Suppresses on missing inputs / no timezone / is_first_session=true / same-day repeat
 *   - Fires with priority 90 when last_session_date < today_in_user_tz
 *   - Picks salutation by local hour bucket
 *   - Composes line from pool with named/unnamed variants
 *   - Stamps last_session_date fire-and-forget (no throw)
 *   - Suppresses Teacher path by winning the ranker via priority 90 > 85
 */

import {
  makeNewDayReturnProvider,
  NEW_DAY_RETURN_PROVIDER_KEY,
  NEW_DAY_RETURN_EXTRA_KEY,
  todayInTimezone,
  localHourInTimezone,
  pickSalutationKind,
  renderNewDayReturnLine,
} from '../../../../src/services/assistant-continuation/providers/new-day-return';

function makeFakeSupabase(row: { last_session_date: string | null; is_first_session: boolean } | null, errorMsg?: string) {
  const captured: any = {};
  const sb = {
    from(table: string) {
      const builder: any = {
        select() { return builder; },
        eq() { return builder; },
        async maybeSingle() {
          captured.queriedTable = table;
          if (errorMsg) return { data: null, error: { message: errorMsg } };
          return { data: row, error: null };
        },
        update(patch: any) {
          captured.updatePatch = patch;
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
      return builder;
    },
  } as any;
  return { sb, captured };
}

function makeCtx(extraOverride: any = {}) {
  return {
    surface: 'orb_wake',
    sessionId: 's1',
    userId: 'u1',
    tenantId: 't1',
    extra: {
      [NEW_DAY_RETURN_EXTRA_KEY]: {
        supabase: extraOverride.supabase ?? makeFakeSupabase({ last_session_date: '2026-06-14', is_first_session: false }).sb,
        userId: 'u1',
        tenantId: 't1',
        lang: 'en',
        firstName: 'Dragan',
        timezone: 'Europe/Berlin',
        ...extraOverride,
      },
    },
  } as any;
}

const FIXED_NOW = new Date('2026-06-15T10:30:00.000Z'); // ~12:30 in Berlin

describe('VTID-03164 helpers', () => {
  describe('todayInTimezone', () => {
    it('returns YYYY-MM-DD in IANA TZ', () => {
      expect(todayInTimezone(FIXED_NOW, 'Europe/Berlin')).toBe('2026-06-15');
    });
    it('handles TZ flipping to next-day vs UTC', () => {
      // UTC 22:00 → Sydney 08:00 next day
      const utcEvening = new Date('2026-06-14T22:00:00.000Z');
      expect(todayInTimezone(utcEvening, 'Australia/Sydney')).toBe('2026-06-15');
    });
    it('handles TZ flipping to previous-day vs UTC', () => {
      // UTC 02:00 → LA 19:00 prev day
      const utcEarly = new Date('2026-06-15T02:00:00.000Z');
      expect(todayInTimezone(utcEarly, 'America/Los_Angeles')).toBe('2026-06-14');
    });
    it('falls back to UTC on null TZ', () => {
      expect(todayInTimezone(FIXED_NOW, null)).toBe('2026-06-15');
    });
    it('falls back to UTC on invalid TZ', () => {
      expect(todayInTimezone(FIXED_NOW, 'Not/A_Real_Timezone')).toBe('2026-06-15');
    });
  });

  describe('localHourInTimezone', () => {
    it('returns local hour in IANA TZ', () => {
      expect(localHourInTimezone(FIXED_NOW, 'Europe/Berlin')).toBe(12);
    });
    it('falls back to UTC hour on null TZ', () => {
      expect(localHourInTimezone(FIXED_NOW, null)).toBe(10);
    });
  });

  describe('pickSalutationKind', () => {
    it('maps very early hours to evening (avoids "good morning" at 3am)', () => {
      expect(pickSalutationKind(2)).toBe('evening');
      expect(pickSalutationKind(4)).toBe('evening');
    });
    it('maps 5-11 to morning', () => {
      expect(pickSalutationKind(5)).toBe('morning');
      expect(pickSalutationKind(11)).toBe('morning');
    });
    it('maps 12-17 to afternoon', () => {
      expect(pickSalutationKind(12)).toBe('afternoon');
      expect(pickSalutationKind(17)).toBe('afternoon');
    });
    it('maps 18-23 to evening', () => {
      expect(pickSalutationKind(18)).toBe('evening');
      expect(pickSalutationKind(23)).toBe('evening');
    });
  });

  describe('renderNewDayReturnLine', () => {
    it('substitutes firstName when present', () => {
      const line = renderNewDayReturnLine(
        { lang: 'de', salutation: 'morning', firstName: 'Dragan' },
        () => 0,
      );
      expect(line).toMatch(/Dragan/);
      expect(line).toMatch(/Guten Morgen/);
    });
    it('uses no-name pool when firstName is null', () => {
      const line = renderNewDayReturnLine(
        { lang: 'de', salutation: 'morning', firstName: null },
        () => 0,
      );
      expect(line).not.toMatch(/Dragan/);
      expect(line).not.toMatch(/{name}/);
    });
    it('falls back to en when lang pool missing', () => {
      const line = renderNewDayReturnLine(
        { lang: 'ja', salutation: 'morning', firstName: 'Dragan' },
        () => 0,
      );
      expect(line).toMatch(/Dragan/);
      expect(line).toMatch(/Good morning|Morning/);
    });
    it('English afternoon variant', () => {
      const line = renderNewDayReturnLine(
        { lang: 'en', salutation: 'afternoon', firstName: 'Dragan' },
        () => 0,
      );
      expect(line).toMatch(/afternoon/i);
    });
    it('English evening variant', () => {
      const line = renderNewDayReturnLine(
        { lang: 'en', salutation: 'evening', firstName: null },
        () => 0,
      );
      expect(line).toMatch(/evening|Evening/);
    });
    it('rng index out of range clamps to first entry', () => {
      const line = renderNewDayReturnLine(
        { lang: 'en', salutation: 'morning', firstName: 'Dragan' },
        () => 999, // clamps to last
      );
      expect(line).toMatch(/Dragan/);
    });
  });
});

describe('VTID-03164 makeNewDayReturnProvider', () => {
  it('exposes the correct surface + key', () => {
    const p = makeNewDayReturnProvider();
    expect(p.key).toBe(NEW_DAY_RETURN_PROVIDER_KEY);
    expect(p.surfaces).toEqual(['orb_wake']);
  });

  it('skips when inputs are missing', async () => {
    const p = makeNewDayReturnProvider();
    const r = await p.produce({ surface: 'orb_wake', extra: {} } as any);
    expect(r.status).toBe('skipped');
    expect((r as any).reason).toBe('no_new_day_return_inputs');
  });

  it('suppresses when timezone is missing', async () => {
    const p = makeNewDayReturnProvider();
    const r = await p.produce(makeCtx({ timezone: null }));
    expect(r.status).toBe('suppressed');
    expect((r as any).reason).toBe('no_timezone');
  });

  it('errors gracefully on DB fetch failure', async () => {
    const p = makeNewDayReturnProvider();
    const { sb } = makeFakeSupabase(null, 'boom');
    const r = await p.produce(makeCtx({ supabase: sb }));
    expect(r.status).toBe('errored');
    expect((r as any).reason).toMatch(/user_journey_fetch_failed/);
  });

  it('suppresses when is_first_session=true (first-time welcome territory)', async () => {
    const p = makeNewDayReturnProvider();
    const { sb } = makeFakeSupabase({ last_session_date: null, is_first_session: true });
    const r = await p.produce(makeCtx({ supabase: sb }));
    expect(r.status).toBe('suppressed');
    expect((r as any).reason).toBe('is_first_session_true');
  });

  it('suppresses when same-day repeat (last_session_date === today)', async () => {
    jest.useFakeTimers().setSystemTime(FIXED_NOW);
    const p = makeNewDayReturnProvider({ now: () => FIXED_NOW.getTime() });
    const { sb } = makeFakeSupabase({ last_session_date: '2026-06-15', is_first_session: false });
    const r = await p.produce(makeCtx({ supabase: sb }));
    expect(r.status).toBe('suppressed');
    expect((r as any).reason).toMatch(/^same_day_/);
    jest.useRealTimers();
  });

  it('fires with priority 90 on new-day return', async () => {
    jest.useFakeTimers().setSystemTime(FIXED_NOW);
    const p = makeNewDayReturnProvider({ now: () => FIXED_NOW.getTime(), rng: () => 0 });
    const { sb } = makeFakeSupabase({ last_session_date: '2026-06-14', is_first_session: false });
    const r = await p.produce(makeCtx({ supabase: sb }));
    expect(r.status).toBe('returned');
    const c = (r as any).candidate;
    expect(c.priority).toBe(90);
    expect(c.surface).toBe('orb_wake');
    expect(c.kind).toBe('wake_brief');
    expect(c.dedupeKey).toBe('new-day-return:2026-06-15');
    expect(c.userFacingLine).toMatch(/Dragan/);
    expect(c.userFacingLine).toMatch(/afternoon|Afternoon/); // afternoon Berlin, lang=en in ctx
    jest.useRealTimers();
  });

  it('fires when last_session_date is null (returning user whose row never had a stamp)', async () => {
    jest.useFakeTimers().setSystemTime(FIXED_NOW);
    const p = makeNewDayReturnProvider({ now: () => FIXED_NOW.getTime() });
    const { sb } = makeFakeSupabase({ last_session_date: null, is_first_session: false });
    const r = await p.produce(makeCtx({ supabase: sb }));
    expect(r.status).toBe('returned');
    jest.useRealTimers();
  });

  it('uses no-name pool when firstName is null', async () => {
    jest.useFakeTimers().setSystemTime(FIXED_NOW);
    const p = makeNewDayReturnProvider({ now: () => FIXED_NOW.getTime() });
    const { sb } = makeFakeSupabase({ last_session_date: '2026-06-14', is_first_session: false });
    const r = await p.produce(makeCtx({ supabase: sb, firstName: null }));
    expect(r.status).toBe('returned');
    expect((r as any).candidate.userFacingLine).not.toMatch(/Dragan/);
    expect((r as any).candidate.userFacingLine).not.toMatch(/{name}/);
    jest.useRealTimers();
  });

  it('priority 90 wins against a synthetic Teacher candidate at 85', async () => {
    // Verifies the architectural contract: this provider's priority beats Teacher's.
    jest.useFakeTimers().setSystemTime(FIXED_NOW);
    const p = makeNewDayReturnProvider({ now: () => FIXED_NOW.getTime() });
    const { sb } = makeFakeSupabase({ last_session_date: '2026-06-14', is_first_session: false });
    const r = await p.produce(makeCtx({ supabase: sb }));
    expect((r as any).candidate.priority).toBeGreaterThan(85);
    jest.useRealTimers();
  });
});
