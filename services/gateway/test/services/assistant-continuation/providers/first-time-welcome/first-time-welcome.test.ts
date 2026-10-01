/**
 * R6 (BOOTSTRAP-ORB-R6R7-PROVIDERS) — first-time-welcome provider tests.
 *
 * Locks the contract:
 *   - Fires (status=returned, priority 95) when is_first_session=true.
 *   - Suppresses when is_first_session=false / no row.
 *   - Skips on missing inputs.
 *   - Errors on DB error.
 *   - Flips is_first_session=false fire-and-forget on fire.
 *   - VTID-04760: carries an INTENT (never a finished spoken sentence —
 *     NEVER-rule 41), pointing at Episode 1 of the Audiobook; the wake-brief
 *     block renders it compositionally and LiveKit never speaks it.
 */

import {
  makeFirstTimeWelcomeProvider,
  FIRST_TIME_WELCOME_PROVIDER_KEY,
  FIRST_TIME_WELCOME_EXTRA_KEY,
  FIRST_TIME_WELCOME_PRIORITY,
} from '../../../../../src/services/assistant-continuation/providers/first-time-welcome';
import {
  buildFirstTimeWelcomeIntent,
  FIRST_TIME_WELCOME_DEDUPE_PREFIX,
} from '../../../../../src/services/assistant-continuation/providers/first-time-welcome/content';
import { buildVertexWakeBriefBlock } from '../../../../../src/orb/live/session/live-session-controller';
import { livekitSpeakableWakeLine } from '../../../../../src/routes/orb-livekit';

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

describe('R6 first-time-welcome content (VTID-04760 intent)', () => {
  it('is an English intent that points at Episode 1 of the Audiobook', () => {
    const intent = buildFirstTimeWelcomeIntent({ firstName: null });
    expect(intent).toMatch(/Audiobook/);
    expect(intent).toMatch(/Episode 1/);
    expect(intent).toMatch(/Vitana/);
    // No more 90-day plan framing and no per-language finished scripts.
    expect(intent).not.toMatch(/90/);
    expect(intent).not.toMatch(/Langlebigkeits|Herzlich willkommen/);
  });

  it('is written as an instruction to the model, not a line to recite', () => {
    const intent = buildFirstTimeWelcomeIntent({ firstName: null });
    expect(intent).toMatch(/^This is the member's very first conversation/);
    expect(intent).not.toMatch(/^(Hello|Hallo|Welcome|Willkommen)/);
  });

  it('names the member when known', () => {
    expect(buildFirstTimeWelcomeIntent({ firstName: 'Dragan' })).toMatch(/Dragan/);
    expect(buildFirstTimeWelcomeIntent({ firstName: null })).not.toMatch(/first name is/);
  });

  it('renders as a compositional wake-brief block, never the verbatim one', () => {
    const block = buildVertexWakeBriefBlock(
      buildFirstTimeWelcomeIntent({ firstName: null }),
      'de',
      `${FIRST_TIME_WELCOME_DEDUPE_PREFIX}u1`,
    );
    expect(block).toMatch(/FIRST-EVER CONVERSATION/);
    expect(block).toMatch(/compose every word yourself/);
    expect(block).not.toMatch(/VERBATIM|letter-for-letter/i);
  });

  it('is never handed to the LiveKit agent for deterministic session.say()', () => {
    expect(
      livekitSpeakableWakeLine({ userFacingLine: 'intent text', dedupeKey: 'first-time-welcome:u1' }),
    ).toBe('');
    expect(
      livekitSpeakableWakeLine({ userFacingLine: ' other line ', dedupeKey: 'new-day:u1' }),
    ).toBe('other line');
    expect(livekitSpeakableWakeLine(null)).toBe('');
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

  it('carries the same language-neutral intent for lang=de, and a CTA into the Audiobook', async () => {
    const { sb } = makeFakeSupabase({ is_first_session: true });
    const p = makeFirstTimeWelcomeProvider(baseOpts);
    const res = await p.produce(makeCtx({ lang: 'de', firstName: null }, sb));
    expect(res.status).toBe('returned');
    expect(res.candidate?.userFacingLine).toBe(buildFirstTimeWelcomeIntent({ firstName: null }));
    expect(res.candidate?.cta).toEqual({
      type: 'navigate',
      route: '/autopilot?audiobook=play',
      payload: { intent: 'audiobook_episode_1' },
    });
  });
});
