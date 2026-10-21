/**
 * BOOTSTRAP-DAY-COUNTER-DRIFT — journey-stage-for-prompt tests.
 *
 * Pins the conversation-flow fix in routes/orb-live.ts and
 * services/context-pack-builder.ts: both used to call
 * journey-calendar-mapper.getJourneyStage() with the WRONG date argument
 * (`new Date()` / the conversation's own start timestamp instead of the
 * user's registration date), so `Date.now() - Date.now()` always floored to
 * 0 and every session told the LLM "Journey: Day 0 of 90" regardless of the
 * user's real tenure. getJourneyStageForPrompt() wraps the canonical
 * getJourneyState() instead, so this must return the REAL elapsed day count.
 */

import { getJourneyStageForPrompt } from '../../../src/services/journey/journey-stage-for-prompt';

const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');

function makeClient(opts: { journeyRow?: any; journeyError?: any; appUserRow?: any; appUserError?: any }) {
  return {
    from(table: string) {
      const builder: any = {
        select() { return builder; },
        eq() { return builder; },
        order() { return builder; },
        limit() { return builder; },
        async maybeSingle() {
          if (table === 'user_journey') {
            return { data: opts.journeyRow ?? null, error: opts.journeyError ?? null };
          }
          if (table === 'app_users') {
            return { data: opts.appUserRow ?? null, error: opts.appUserError ?? null };
          }
          return { data: null, error: null };
        },
      };
      return builder;
    },
  } as any;
}

describe('BOOTSTRAP-DAY-COUNTER-DRIFT getJourneyStageForPrompt', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns the REAL elapsed day count, never "Day 0" for an established user', async () => {
    // 51 days into the journey — mirrors the reported bug (chat said "51.
    // Tag", but the old getJourneyStage(new Date()) call would have
    // evaluated Date.now() - Date.now() and returned day 0 here instead.
    const start = new Date(FIXED_NOW.getTime() - 51 * 86_400_000).toISOString();
    jest.useFakeTimers().setSystemTime(FIXED_NOW);
    const client = makeClient({
      journeyRow: {
        user_id: 'u1', tenant_id: 't1', started_at: start, total_days: 90,
        plan_type: 'default', plan_summary: null, current_wave_id: null,
        current_milestone_id: null, status: 'active', completed_milestone_ids: [],
        is_first_session: false, last_session_date: null, last_acknowledged_day: null,
        recent_greeting_openings: [], plan_negotiated_at: null,
        created_at: start, updated_at: start,
      },
    });

    const stage = await getJourneyStageForPrompt(client, 'u1');

    expect(stage).not.toBeNull();
    expect(stage!.day_number).toBe(51);
    expect(stage!.day_number).not.toBe(0);
    expect(stage!.total_days).toBe(90);
  });

  it('resolves a real wave name, not the "Discovery" catch-all, when within an enabled wave', async () => {
    // Day 5 falls inside wave-1 (0-7) per DEFAULT_WAVE_CONFIG.
    const start = new Date(FIXED_NOW.getTime() - 5 * 86_400_000).toISOString();
    jest.useFakeTimers().setSystemTime(FIXED_NOW);
    const client = makeClient({
      journeyRow: {
        user_id: 'u2', tenant_id: 't1', started_at: start, total_days: 90,
        plan_type: 'default', plan_summary: null, current_wave_id: null,
        current_milestone_id: null, status: 'active', completed_milestone_ids: [],
        is_first_session: false, last_session_date: null, last_acknowledged_day: null,
        recent_greeting_openings: [], plan_negotiated_at: null,
        created_at: start, updated_at: start,
      },
    });

    const stage = await getJourneyStageForPrompt(client, 'u2');

    expect(stage!.wave_name).not.toBe('Discovery');
  });

  it('falls back to app_users.created_at when the user_journey row is missing (no journey → still not day 0 for an old signup)', async () => {
    const start = new Date(FIXED_NOW.getTime() - 20 * 86_400_000).toISOString();
    jest.useFakeTimers().setSystemTime(FIXED_NOW);
    const client = makeClient({ appUserRow: { user_id: 'u3', created_at: start } });

    const stage = await getJourneyStageForPrompt(client, 'u3');

    expect(stage).not.toBeNull();
    expect(stage!.day_number).toBe(20);
  });

  it('returns null (never a fabricated day count) when neither row exists', async () => {
    const client = makeClient({});
    const stage = await getJourneyStageForPrompt(client, 'u4');
    expect(stage).toBeNull();
  });
});
