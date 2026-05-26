/**
 * VTID-03152 — Slice A: user_journey persistence layer tests.
 *
 * Covers:
 *   - computeDayInJourney pure math
 *   - resolveCurrentWave picks the latest-start matching enabled wave
 *   - getJourneyState happy path, missing row falls back to app_users math, DB error returns null
 *   - ensureUserJourneyRow inserts when missing, returns false on unique_violation, returns false on other errors
 *   - updateSessionEndState no-ops when patch is empty, pushes greeting opening capped at 5
 */

import {
  computeDayInJourney,
  resolveCurrentWave,
  getJourneyState,
  ensureUserJourneyRow,
  updateSessionEndState,
} from '../../../src/services/journey/user-journey-service';

const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');

describe('VTID-03152 user-journey-service', () => {
  describe('computeDayInJourney', () => {
    it('returns 0 on the same day as start', () => {
      expect(computeDayInJourney('2026-06-01T08:00:00.000Z', FIXED_NOW)).toBe(0);
    });
    it('returns floor of elapsed days', () => {
      // 14 days minus a few hours -> floor 13
      expect(computeDayInJourney('2026-05-19T18:00:00.000Z', FIXED_NOW)).toBe(12);
    });
    it('returns 0 for future started_at (clamped)', () => {
      expect(computeDayInJourney('2026-07-01T00:00:00.000Z', FIXED_NOW)).toBe(0);
    });
    it('handles 90+ days past start', () => {
      // 100 days before FIXED_NOW
      const start = new Date(FIXED_NOW.getTime() - 100 * 86_400_000).toISOString();
      expect(computeDayInJourney(start, FIXED_NOW)).toBe(100);
    });
  });

  describe('resolveCurrentWave', () => {
    it('returns the earliest-ending matching wave (matches existing buildJourney behavior)', () => {
      // Day 0: wave-1 (ends 7) is the only match → wave-1.
      expect(resolveCurrentWave(0)?.id).toBe('wave-1');
      // Day 5: wave-1 (0-7) AND wave-2 (1-14) match. wave-1 ends earlier → wave-1.
      expect(resolveCurrentWave(5)?.id).toBe('wave-1');
      // Day 14: wave-2 (1-14), wave-3 (7-30), wave-4 (14-60) match. wave-2 ends earliest → wave-2.
      expect(resolveCurrentWave(14)?.id).toBe('wave-2');
    });
    it('returns null past all enabled waves', () => {
      expect(resolveCurrentWave(120)).toBeNull();
    });
  });

  describe('getJourneyState', () => {
    function makeClient(opts: {
      journeyRow?: any;
      journeyError?: any;
      appUserRow?: any;
      appUserError?: any;
    }) {
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

    it('returns derived state for a present row', async () => {
      const start = new Date(FIXED_NOW.getTime() - 14 * 86_400_000).toISOString();
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
      const state = await getJourneyState(client, 'u1');
      expect(state).not.toBeNull();
      expect(state!.day_in_journey).toBe(14);
      expect(state!.days_left).toBe(76);
      expect(state!.current_wave?.id).toBe('wave-2'); // Daily Anchors (ends 14) at day 14, matching buildJourney's earliest-end policy
      expect(state!.fallback_used).toBe(false);
      jest.useRealTimers();
    });

    it('falls back to app_users.created_at when journey row missing', async () => {
      const start = new Date(FIXED_NOW.getTime() - 5 * 86_400_000).toISOString();
      jest.useFakeTimers().setSystemTime(FIXED_NOW);
      const client = makeClient({
        journeyRow: null,
        appUserRow: { user_id: 'u2', created_at: start },
      });
      const state = await getJourneyState(client, 'u2');
      expect(state).not.toBeNull();
      expect(state!.day_in_journey).toBe(5);
      expect(state!.is_first_session).toBe(false);
      expect(state!.fallback_used).toBe(true);
      expect(state!.current_wave?.id).toBe('wave-1'); // day 5 → Getting Started (ends 7, earliest)
      jest.useRealTimers();
    });

    it('returns null on DB error', async () => {
      const client = makeClient({ journeyError: { message: 'boom' } });
      const state = await getJourneyState(client, 'u3');
      expect(state).toBeNull();
    });

    it('returns null when neither row is present', async () => {
      const client = makeClient({});
      const state = await getJourneyState(client, 'u4');
      expect(state).toBeNull();
    });
  });

  describe('ensureUserJourneyRow', () => {
    it('returns true when insert succeeds', async () => {
      const client = {
        from(_t: string) {
          return {
            insert() { return this; },
            select() { return this; },
            async maybeSingle() { return { data: { user_id: 'u5' }, error: null }; },
          } as any;
        },
      } as any;
      const created = await ensureUserJourneyRow(client, 'u5', { tenant_id: 't1' });
      expect(created).toBe(true);
    });

    it('returns false when insert hits unique_violation (idempotent path)', async () => {
      const client = {
        from(_t: string) {
          return {
            insert() { return this; },
            select() { return this; },
            async maybeSingle() {
              return { data: null, error: { code: '23505', message: 'duplicate' } };
            },
          } as any;
        },
      } as any;
      const created = await ensureUserJourneyRow(client, 'u6');
      expect(created).toBe(false);
    });

    it('returns false on other DB errors', async () => {
      const client = {
        from(_t: string) {
          return {
            insert() { return this; },
            select() { return this; },
            async maybeSingle() {
              return { data: null, error: { code: '42P01', message: 'no table' } };
            },
          } as any;
        },
      } as any;
      const created = await ensureUserJourneyRow(client, 'u7');
      expect(created).toBe(false);
    });
  });

  describe('updateSessionEndState', () => {
    it('does nothing on empty patch', async () => {
      let updateCalled = false;
      const client = {
        from(_t: string) {
          return {
            update() { updateCalled = true; return this; },
            eq() { return Promise.resolve({ error: null }); },
          } as any;
        },
      } as any;
      await updateSessionEndState(client, 'u8', {});
      expect(updateCalled).toBe(false);
    });

    it('pushes greeting opening capped at 5', async () => {
      const captured: Record<string, unknown> = {};
      const client = {
        from(_t: string) {
          return {
            select() { return this; },
            eq() { return this; },
            async maybeSingle() {
              return { data: { recent_greeting_openings: ['o1', 'o2', 'o3', 'o4', 'o5'] }, error: null };
            },
            update(patch: Record<string, unknown>) {
              Object.assign(captured, patch);
              return { eq: () => Promise.resolve({ error: null }) };
            },
          } as any;
        },
      } as any;
      await updateSessionEndState(client, 'u9', { pushed_greeting_opening: 'o6' });
      expect((captured.recent_greeting_openings as string[]).length).toBe(5);
      expect((captured.recent_greeting_openings as string[])[0]).toBe('o6');
      expect((captured.recent_greeting_openings as string[])).not.toContain('o5');
    });

    it('clear_first_session writes is_first_session=false', async () => {
      const captured: Record<string, unknown> = {};
      const client = {
        from(_t: string) {
          return {
            update(patch: Record<string, unknown>) {
              Object.assign(captured, patch);
              return { eq: () => Promise.resolve({ error: null }) };
            },
          } as any;
        },
      } as any;
      await updateSessionEndState(client, 'u10', { clear_first_session: true });
      expect(captured.is_first_session).toBe(false);
    });
  });
});
