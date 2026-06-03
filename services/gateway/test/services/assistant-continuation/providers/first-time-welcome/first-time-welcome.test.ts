/**
 * R6 (BOOTSTRAP-ORB-R6R7-PROVIDERS) — first-time-welcome provider tests.
 *
 * Locks the contract:
 *   - Fires (status=returned, priority 95) when is_first_session=true.
 *   - Suppresses when is_first_session=false / no row.
 *   - Skips on missing inputs.
 *   - Errors on DB error.
 *   - Flips is_first_session=false fire-and-forget on fire.
 *   - EN + DE content both present and authored (real DE, not a copy of EN).
 */

import {
  makeFirstTimeWelcomeProvider,
  FIRST_TIME_WELCOME_PROVIDER_KEY,
  FIRST_TIME_WELCOME_EXTRA_KEY,
  FIRST_TIME_WELCOME_PRIORITY,
} from '../../../../../src/services/assistant-continuation/providers/first-time-welcome';
import {
  renderFirstTimeWelcomeLine,
  FIRST_TIME_WELCOME_LOCALES,
} from '../../../../../src/services/assistant-continuation/providers/first-time-welcome/content';

function makeFakeSupabase(
  row: { is_first_session: boolean } | null,
  errorMsg?: string,
) {
  const captured: any = { updatePatch: null, queriedTable: null };
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

function makeCtx(extraOverride: any = {}, sbOverride?: any) {
  return {
    surface: 'orb_wake',
    sessionId: 's1',
    userId: 'u1',
    tenantId: 't1',
    extra: {
      [FIRST_TIME_WELCOME_EXTRA_KEY]: {
        supabase:
          sbOverride ?? makeFakeSupabase({ is_first_session: true }).sb,
        userId: 'u1',
        tenantId: 't1',
        lang: 'en',
        firstName: 'Dragan',
        ...extraOverride,
      },
    },
  } as any;
}

describe('R6 first-time-welcome content', () => {
  it('exposes both EN and DE locales', () => {
    expect(FIRST_TIME_WELCOME_LOCALES).toContain('en');
    expect(FIRST_TIME_WELCOME_LOCALES).toContain('de');
  });

  it('renders an EN script naming the 90-day plan and inviting a goal', () => {
    const line = renderFirstTimeWelcomeLine({ lang: 'en', firstName: null });
    expect(line).toMatch(/Vitana/);
    expect(line).toMatch(/longevity companion/i);
    expect(line).toMatch(/90-day/);
    expect(line).toMatch(/\?$/); // ends on the first-goal invitation
  });

  it('renders a REAL German script (not a copy of EN)', () => {
    const de = renderFirstTimeWelcomeLine({ lang: 'de', firstName: null });
    const en = renderFirstTimeWelcomeLine({ lang: 'en', firstName: null });
    expect(de).not.toEqual(en);
    expect(de).toMatch(/Vitana/);
    expect(de).toMatch(/Langlebigkeits-Begleiterin/);
    expect(de).toMatch(/90-Tage-Starterplan/);
    expect(de).toMatch(/\?$/);
  });

  it('substitutes firstName when present', () => {
    const line = renderFirstTimeWelcomeLine({ lang: 'en', firstName: 'Dragan' });
    expect(line).toMatch(/Dragan/);
    expect(line).not.toMatch(/\{name\}/);
  });

  it('falls back to EN for an unknown locale', () => {
    const unknown = renderFirstTimeWelcomeLine({ lang: 'zz', firstName: null });
    const en = renderFirstTimeWelcomeLine({ lang: 'en', firstName: null });
    expect(unknown).toEqual(en);
  });
});

describe('R6 first-time-welcome provider', () => {
  const baseOpts = {
    newId: () => 'fixed-id',
    now: () => 1_000,
  };

  it('has the right key and orb_wake surface', () => {
    const p = makeFirstTimeWelcomeProvider(baseOpts);
    expect(p.key).toBe(FIRST_TIME_WELCOME_PROVIDER_KEY);
    expect(p.surfaces).toEqual(['orb_wake']);
  });

  it('fires with priority 95 when is_first_session=true', async () => {
    const { sb } = makeFakeSupabase({ is_first_session: true });
    const p = makeFirstTimeWelcomeProvider(baseOpts);
    const res = await p.produce(makeCtx({}, sb));
    expect(res.status).toBe('returned');
    expect(res.candidate?.priority).toBe(FIRST_TIME_WELCOME_PRIORITY);
    expect(res.candidate?.priority).toBe(95);
    expect(res.candidate?.kind).toBe('wake_brief');
    expect(res.candidate?.surface).toBe('orb_wake');
    expect(res.candidate?.userFacingLine).toMatch(/Dragan/);
    expect(res.candidate?.dedupeKey).toBe('first-time-welcome:u1');
  });

  it('flips is_first_session=false fire-and-forget when it fires', async () => {
    const { sb, captured } = makeFakeSupabase({ is_first_session: true });
    const p = makeFirstTimeWelcomeProvider(baseOpts);
    await p.produce(makeCtx({}, sb));
    // microtask drain so the fire-and-forget update lands
    await Promise.resolve();
    await Promise.resolve();
    expect(captured.updatePatch).toEqual({ is_first_session: false });
  });

  it('suppresses when is_first_session=false', async () => {
    const { sb } = makeFakeSupabase({ is_first_session: false });
    const p = makeFirstTimeWelcomeProvider(baseOpts);
    const res = await p.produce(makeCtx({}, sb));
    expect(res.status).toBe('suppressed');
    expect(res.reason).toBe('is_first_session_false');
  });

  it('suppresses when there is no user_journey row', async () => {
    const { sb } = makeFakeSupabase(null);
    const p = makeFirstTimeWelcomeProvider(baseOpts);
    const res = await p.produce(makeCtx({}, sb));
    expect(res.status).toBe('suppressed');
    expect(res.reason).toBe('no_user_journey_row');
  });

  it('skips when inputs are missing', async () => {
    const p = makeFirstTimeWelcomeProvider(baseOpts);
    const res = await p.produce({ surface: 'orb_wake', extra: {} } as any);
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('no_first_time_welcome_inputs');
  });

  it('errors on a DB error', async () => {
    const { sb } = makeFakeSupabase(null, 'boom');
    const p = makeFirstTimeWelcomeProvider(baseOpts);
    const res = await p.produce(makeCtx({}, sb));
    expect(res.status).toBe('errored');
    expect(res.reason).toMatch(/boom/);
  });

  it('renders the DE line when lang=de and fires', async () => {
    const { sb } = makeFakeSupabase({ is_first_session: true });
    const p = makeFirstTimeWelcomeProvider(baseOpts);
    const res = await p.produce(makeCtx({ lang: 'de', firstName: null }, sb));
    expect(res.status).toBe('returned');
    expect(res.candidate?.userFacingLine).toMatch(/Langlebigkeits-Begleiterin/);
  });
});
