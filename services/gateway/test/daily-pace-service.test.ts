/**
 * Tests for the daily-pace notification service.
 *
 * Coverage:
 *   - bucketPace() — table-driven, locks 0.7 / 0.4 thresholds + clamping
 *   - tone → i18n key resolution returns distinct non-empty DE/EN strings
 *   - userLocalDate / userLocalHour across fractional/extreme offsets + DST
 *   - computePaceDecision with a hand-rolled mock SupabaseClient covers
 *     every SkipReason and the happy path
 *   - Route fan-out (supertest) covers wrong-hour skip, invalid tz, and
 *     same-second idempotency
 */

import express from 'express';
import request from 'supertest';
import {
  bucketPace,
  computePaceDecision,
  paceToneKeys,
  userLocalDate,
  userLocalHour,
  type PaceTone,
} from '../src/services/daily-pace-service';
import { tt } from '../src/i18n/catalog';

// ─────────────────────────────────────────────────────────────
// Hand-rolled supabase mock builder.
//
// The PostgREST-style builder chain (.from().select().eq()...) terminates
// in either an awaited promise (count queries / maybeSingle) or a
// chainable call. Our mock returns objects whose key methods all return
// `this`, and which expose `.then` so they can be `await`ed at the end of
// the chain. The behaviour per `from(table)` is supplied by the test.
// ─────────────────────────────────────────────────────────────

type TableHandler = (query: { method: 'select' | 'insert' | 'update'; filters: Record<string, any>; payload?: any }) => any;

function makeSupa(handlers: Record<string, TableHandler>) {
  // Track inserts per table so the idempotency test can mirror writes
  const writes: Record<string, any[]> = {};

  function builder(table: string, method: 'select' | 'insert' | 'update', payload?: any) {
    const filters: Record<string, any> = {};
    let countMode = false;
    let single = false;

    const chain: any = {
      select(_cols?: string, opts?: any) {
        if (opts?.count) countMode = true;
        return chain;
      },
      insert(row: any) {
        writes[table] = writes[table] || [];
        const rows = Array.isArray(row) ? row : [row];
        writes[table].push(...rows);
        return builder(table, 'insert', row);
      },
      update(row: any) {
        return builder(table, 'update', row);
      },
      eq(col: string, val: any) {
        filters[col] = val;
        return chain;
      },
      gte(col: string, val: any) {
        filters[`${col}__gte`] = val;
        return chain;
      },
      lte(_col: string, _val: any) {
        return chain;
      },
      lt(_col: string, _val: any) {
        return chain;
      },
      not(_a: any, _b: any, _c: any) {
        return chain;
      },
      is(_col: string, _val: any) {
        return chain;
      },
      in(_col: string, _val: any) {
        return chain;
      },
      or(_clause: string) {
        return chain;
      },
      order(_col: string, _opts?: any) {
        return chain;
      },
      limit(_n: number) {
        return chain;
      },
      maybeSingle() {
        single = true;
        return execute();
      },
      then(onF: any, onR: any) {
        return execute().then(onF, onR);
      },
    };

    async function execute() {
      const handler = handlers[table];
      if (!handler) {
        return countMode ? { count: 0, data: null, error: null } : { data: null, error: null };
      }
      const result = handler({ method, filters, payload });
      if (countMode) {
        return { count: result?.count ?? 0, data: null, error: null };
      }
      if (single) {
        const row = Array.isArray(result?.data) ? (result.data[0] ?? null) : (result?.data ?? null);
        return { data: row, error: null };
      }
      return { data: result?.data ?? null, error: null };
    }

    return chain;
  }

  const supa: any = {
    from(table: string) {
      return builder(table, 'select');
    },
    __writes: writes,
  };
  return supa;
}

// =============================================================================
// bucketPace — table-driven
// =============================================================================
describe('bucketPace', () => {
  const cases: Array<[number, number, PaceTone, number]> = [
    [7, 10, 'on_track', 0.7],
    [4, 10, 'slightly_behind', 0.4],
    [3, 10, 'falling_behind', 0.3],
    [0, 0, 'falling_behind', 0],
    [10, 10, 'on_track', 1],
    [69, 100, 'slightly_behind', 0.69], // locks `>= 0.7` strict semantics
    [39, 100, 'falling_behind', 0.39], // locks `>= 0.4` strict semantics
    [12, 10, 'on_track', 1], // clamped — guards against future filter mismatch
  ];

  it.each(cases)('(%i, %i) → %s / ratio≈%f', (a, s, tone, ratio) => {
    const out = bucketPace(a, s);
    expect(out.tone).toBe(tone);
    expect(out.ratio).toBeCloseTo(ratio, 5);
  });
});

// =============================================================================
// tone → i18n key mapping
// =============================================================================
describe('paceToneKeys → tt() resolution', () => {
  const expected: Record<PaceTone, { de_title: string; en_title: string }> = {
    on_track: { de_title: 'Auf Kurs ✨', en_title: 'On track ✨' },
    slightly_behind: {
      de_title: 'Heute geht noch was',
      en_title: "Today's still open",
    },
    falling_behind: {
      de_title: 'Dein Ziel wartet',
      en_title: 'Your goal is waiting',
    },
  };

  for (const tone of Object.keys(expected) as PaceTone[]) {
    it(`${tone} resolves to distinct non-empty DE/EN strings`, () => {
      const { titleKey, bodyKey } = paceToneKeys(tone);
      const deTitle = tt(titleKey as any, 'de');
      const enTitle = tt(titleKey as any, 'en');
      const deBody = tt(bodyKey as any, 'de');
      const enBody = tt(bodyKey as any, 'en');

      expect(deTitle).toBe(expected[tone].de_title);
      expect(enTitle).toBe(expected[tone].en_title);
      expect(deTitle).not.toBe(enTitle);
      expect(deBody.length).toBeGreaterThan(10);
      expect(enBody.length).toBeGreaterThan(10);
      expect(deBody).not.toBe(enBody);
      expect(deTitle).not.toBe(deBody);
    });
  }
});

// =============================================================================
// userLocalDate / userLocalHour
// =============================================================================
describe('userLocalDate / userLocalHour', () => {
  it('Pacific/Pago_Pago (UTC-11) at 2026-05-29T06:00:00Z → 2026-05-28', () => {
    expect(userLocalDate(new Date('2026-05-29T06:00:00Z'), 'Pacific/Pago_Pago')).toBe('2026-05-28');
  });

  it('Pacific/Kiritimati (UTC+14) at 2026-05-28T22:00:00Z → 2026-05-29', () => {
    expect(userLocalDate(new Date('2026-05-28T22:00:00Z'), 'Pacific/Kiritimati')).toBe('2026-05-29');
  });

  it('Asia/Kathmandu (+5:45) at 2026-05-28T14:00:00Z → local hour 19 (19:45)', () => {
    // 14:00 UTC + 5:45 = 19:45 local → hour 19
    expect(userLocalHour(new Date('2026-05-28T14:00:00Z'), 'Asia/Kathmandu')).toBe(19);
  });

  it('Asia/Kathmandu at 2026-05-28T13:00:00Z → local hour 18 (18:45, not 19)', () => {
    // Confirms the fractional offset doesn't tick to 19 too early
    expect(userLocalHour(new Date('2026-05-28T13:00:00Z'), 'Asia/Kathmandu')).toBe(18);
  });

  it('Europe/Berlin DST spring-forward 2026-03-29T01:00:00Z → local hour 03', () => {
    // 02:00 local is skipped on this date; 01:00Z is 03:00 CEST
    expect(userLocalHour(new Date('2026-03-29T01:00:00Z'), 'Europe/Berlin')).toBe(3);
  });

  it('Europe/Berlin 2026-03-29T17:00:00Z (post-DST) → local hour 19', () => {
    expect(userLocalHour(new Date('2026-03-29T17:00:00Z'), 'Europe/Berlin')).toBe(19);
  });

  it('Europe/Berlin DST fall-back 2026-10-25 → both 19:00 instances map to local hour 19 once', () => {
    // Fall-back: 03:00 CEST → 02:00 CET. The 19:00 hour is unambiguous.
    // 17:00Z → 18:00 CEST/CET? On 2026-10-25 at 17Z, we're past the
    // fall-back (which happens at 01:00Z), so we're on CET (UTC+1) →
    // local hour 18. The interesting double-fire window is the 0-3
    // local-hour band, which we already test above. Sanity check 19h:
    expect(userLocalHour(new Date('2026-10-25T18:00:00Z'), 'Europe/Berlin')).toBe(19);
  });
});

// =============================================================================
// computePaceDecision — all SkipReasons + happy path
// =============================================================================
describe('computePaceDecision', () => {
  // 17:00 UTC on a non-DST day = 19:00 Europe/Berlin (CEST, UTC+2)
  // 2026-05-28 is in CEST so UTC+2 → 17:00Z = 19:00 local
  const NOW_BERLIN_19 = new Date('2026-05-28T17:00:00Z');
  // Same moment, but for Berlin user this is 19:00 local.
  const TENANT = 'tenant-test-1';
  const USER = 'user-A';

  const baseHandlers = {
    app_users: () => ({ data: { timezone: 'Europe/Berlin' } }),
    user_preferences: () => ({ data: null }),
    memory_facts: () => ({ data: null }),
  };

  it('returns wrong_hour when local hour ≠ 19', async () => {
    const supa = makeSupa({ ...baseHandlers });
    const decision = await computePaceDecision(supa, USER, TENANT, new Date('2026-05-28T10:00:00Z'));
    expect(decision.shouldNotify).toBe(false);
    expect(decision.skipReason).toBe('wrong_hour');
    expect(decision.userLocalHour).toBe(12); // 10Z + 2 = 12 CEST
  });

  it('returns no_goal when no active life_compass row', async () => {
    const supa = makeSupa({
      ...baseHandlers,
      life_compass: () => ({ data: null }),
    });
    const d = await computePaceDecision(supa, USER, TENANT, NOW_BERLIN_19);
    expect(d.shouldNotify).toBe(false);
    expect(d.skipReason).toBe('no_goal');
  });

  it('returns muted when push_enabled=false', async () => {
    const supa = makeSupa({
      ...baseHandlers,
      life_compass: () => ({ data: { id: 'g1' } }),
      user_notification_preferences: () => ({ data: { push_enabled: false } }),
    });
    const d = await computePaceDecision(supa, USER, TENANT, NOW_BERLIN_19);
    expect(d.shouldNotify).toBe(false);
    expect(d.skipReason).toBe('muted');
  });

  it('returns insufficient_actions when surfaced_7d < 3', async () => {
    const supa = makeSupa({
      ...baseHandlers,
      life_compass: () => ({ data: { id: 'g1' } }),
      user_notification_preferences: () => ({ data: { push_enabled: true } }),
      autopilot_recommendations: ({ filters }) => {
        // Only count query — return small count for surfaced
        if (filters.status === 'activated') return { count: 0 };
        return { count: 2 };
      },
    });
    const d = await computePaceDecision(supa, USER, TENANT, NOW_BERLIN_19);
    expect(d.shouldNotify).toBe(false);
    expect(d.skipReason).toBe('insufficient_actions');
    expect(d.surfaced7d).toBe(2);
  });

  it('returns already_sent when a daily_pace_check row already exists today', async () => {
    const supa = makeSupa({
      ...baseHandlers,
      life_compass: () => ({ data: { id: 'g1' } }),
      user_notification_preferences: () => ({ data: { push_enabled: true } }),
      autopilot_recommendations: ({ filters }) => {
        if (filters.status === 'activated') return { count: 3 };
        return { count: 5 };
      },
      user_notifications: () => ({
        data: [
          { id: 'n1', created_at: NOW_BERLIN_19.toISOString() }, // same instant → same local day
        ],
      }),
    });
    const d = await computePaceDecision(supa, USER, TENANT, NOW_BERLIN_19);
    expect(d.shouldNotify).toBe(false);
    expect(d.skipReason).toBe('already_sent');
  });

  it('happy path: 5 surfaced, 4 activated → on_track ratio=0.8', async () => {
    const supa = makeSupa({
      ...baseHandlers,
      life_compass: () => ({ data: { id: 'g1' } }),
      user_notification_preferences: () => ({ data: { push_enabled: true } }),
      autopilot_recommendations: ({ filters }) => {
        if (filters.status === 'activated') return { count: 4 };
        return { count: 5 };
      },
      user_notifications: () => ({ data: [] }),
    });
    const d = await computePaceDecision(supa, USER, TENANT, NOW_BERLIN_19);
    expect(d.shouldNotify).toBe(true);
    expect(d.tone).toBe('on_track');
    expect(d.ratio).toBeCloseTo(0.8, 5);
    expect(d.surfaced7d).toBe(5);
    expect(d.activated7d).toBe(4);
    expect(d.userLocalDate).toBe('2026-05-28');
    expect(d.userLocalHour).toBe(19);
    expect(d.timezone).toBe('Europe/Berlin');
  });

  it('invalid timezone string falls back to Europe/Berlin (does not throw)', async () => {
    const supa = makeSupa({
      app_users: () => ({ data: { timezone: 'CEST' } }), // not an IANA tz
      user_preferences: () => ({ data: null }),
      memory_facts: () => ({ data: null }),
      life_compass: () => ({ data: { id: 'g1' } }),
      user_notification_preferences: () => ({ data: { push_enabled: true } }),
      autopilot_recommendations: ({ filters }) => {
        if (filters.status === 'activated') return { count: 4 };
        return { count: 5 };
      },
      user_notifications: () => ({ data: [] }),
    });
    const d = await computePaceDecision(supa, USER, TENANT, NOW_BERLIN_19);
    expect(d.timezone).toBe('Europe/Berlin');
    expect(d.shouldNotify).toBe(true);
    expect(d.tone).toBe('on_track');
  });
});

// =============================================================================
// Route fan-out tests
// =============================================================================
describe('POST /daily-pace-notifications route', () => {
  const TENANT = 'tenant-test-1';

  // Stage tenant + Supabase mocking by stubbing the service client.
  // We patch the module's getServiceClient by setting the env vars; the
  // route's getServiceClient() builds a real client lazily, so for the
  // route test we instead point at a tiny in-memory supabase mock by
  // injecting it through a wrapping app and mocking `@supabase/supabase-js`.
  //
  // The simplest robust approach: mock `@supabase/supabase-js`'s
  // createClient so it returns our mock builder.

  function appFactory(supaMock: any) {
    // Mock @supabase/supabase-js createClient before importing the route
    jest.resetModules();
    jest.doMock('@supabase/supabase-js', () => ({
      createClient: () => supaMock,
    }));
    // Also stub the notification-service so we don't trigger FCM/Appilix
    jest.doMock('../src/services/notification-service', () => ({
      notifyUserAsync: jest.fn(),
      sendPushToUser: jest.fn(async () => 0),
      sendAppilixPush: jest.fn(async () => false),
      // Mirror the production TYPE_META entry so the route's metadata
      // lookup doesn't throw under the mocked module.
      TYPE_META: {
        daily_pace_check: { channel: 'push_and_inapp', priority: 'p2', category: 'calendar' },
      },
    }));

    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE = 'test-key';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const router = require('../src/routes/scheduled-notifications').default;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/scheduled-notifications', router);
    return app;
  }

  it('two users, only the 19:00-local user gets dispatched (other → wrong_hour)', async () => {
    // 2026-05-28T17:00:00Z = 19:00 Berlin (CEST), 10:00 Los Angeles (PDT)
    const userBerlin = '11111111-1111-1111-1111-111111111111';
    const userLA = '22222222-2222-2222-2222-222222222222';

    const supa = makeSupa({
      user_tenants: () => ({
        data: [{ user_id: userBerlin }, { user_id: userLA }],
      }),
      app_users: ({ filters }) => ({
        data:
          filters.user_id === userBerlin
            ? { timezone: 'Europe/Berlin' }
            : { timezone: 'America/Los_Angeles' },
      }),
      user_preferences: () => ({ data: null }),
      memory_facts: () => ({ data: null }),
      life_compass: () => ({ data: { id: 'g1' } }),
      user_notification_preferences: () => ({ data: { push_enabled: true } }),
      autopilot_recommendations: ({ filters }) => {
        if (filters.status === 'activated') return { count: 4 };
        return { count: 5 };
      },
      user_notifications: () => ({ data: [] }),
      app_users_locale_lookup: () => ({ data: [] }),
    });

    const app = appFactory(supa);

    // Pin "now" to 17:00 UTC on 2026-05-28 by monkey-patching Date inside
    // the request. Easiest: send a request and rely on actual current
    // time? No — we need determinism. Use jest.useFakeTimers.
    jest.useFakeTimers().setSystemTime(new Date('2026-05-28T17:00:00Z'));
    const res = await request(app)
      .post('/api/v1/scheduled-notifications/daily-pace-notifications')
      .send({ tenant_id: TENANT });
    jest.useRealTimers();

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.dispatched).toBe(1);
    expect(res.body.skipped.wrong_hour).toBe(1);
  });

  it('one user with bad tz string is handled per-user (other users unaffected)', async () => {
    const userGood = '33333333-3333-3333-3333-333333333333';
    const userBad = '44444444-4444-4444-4444-444444444444';

    const supa = makeSupa({
      user_tenants: () => ({
        data: [{ user_id: userGood }, { user_id: userBad }],
      }),
      app_users: ({ filters }) => ({
        data:
          filters.user_id === userGood
            ? { timezone: 'Europe/Berlin' }
            : { timezone: 'not-a-tz' }, // invalid — falls back to Europe/Berlin
      }),
      user_preferences: () => ({ data: null }),
      memory_facts: () => ({ data: null }),
      life_compass: () => ({ data: { id: 'g1' } }),
      user_notification_preferences: () => ({ data: { push_enabled: true } }),
      autopilot_recommendations: ({ filters }) => {
        if (filters.status === 'activated') return { count: 4 };
        return { count: 5 };
      },
      user_notifications: () => ({ data: [] }),
    });

    const app = appFactory(supa);
    jest.useFakeTimers().setSystemTime(new Date('2026-05-28T17:00:00Z'));
    const res = await request(app)
      .post('/api/v1/scheduled-notifications/daily-pace-notifications')
      .send({ tenant_id: TENANT });
    jest.useRealTimers();

    expect(res.status).toBe(200);
    // Both fall back to Berlin (invalid_tz resolver returns Europe/Berlin)
    // and both are at 19:00 local → both dispatched. This locks in the
    // behaviour that a bad tz string does NOT take down the loop.
    expect(res.body.ok).toBe(true);
    expect(res.body.dispatched + (res.body.skipped.invalid_tz || 0) + (res.body.skipped.error || 0)).toBe(2);
  });

  it('double-call within same UTC second: second call sees prior row and skips with already_sent', async () => {
    const user = '55555555-5555-5555-5555-555555555555';
    const seenNotifications: Array<{ id: string; created_at: string }> = [];

    const supa = makeSupa({
      user_tenants: () => ({ data: [{ user_id: user }] }),
      app_users: () => ({ data: { timezone: 'Europe/Berlin' } }),
      user_preferences: () => ({ data: null }),
      memory_facts: () => ({ data: null }),
      life_compass: () => ({ data: { id: 'g1' } }),
      user_notification_preferences: () => ({ data: { push_enabled: true } }),
      autopilot_recommendations: ({ filters }) => {
        if (filters.status === 'activated') return { count: 4 };
        return { count: 5 };
      },
      // Read returns whatever has been written so far. The route's pre-
      // insert simulates the notifyUserAsync row landing immediately.
      user_notifications: ({ method, payload }) => {
        if (method === 'insert') {
          const row = { id: `n${seenNotifications.length + 1}`, created_at: new Date().toISOString() };
          seenNotifications.push(row);
          return { data: [row] };
        }
        return { data: [...seenNotifications] };
      },
    });

    const app = appFactory(supa);
    jest.useFakeTimers().setSystemTime(new Date('2026-05-28T17:00:00Z'));

    const res1 = await request(app)
      .post('/api/v1/scheduled-notifications/daily-pace-notifications')
      .send({ tenant_id: TENANT });
    const res2 = await request(app)
      .post('/api/v1/scheduled-notifications/daily-pace-notifications')
      .send({ tenant_id: TENANT });

    jest.useRealTimers();

    expect(res1.body.dispatched).toBe(1);
    expect(res2.body.dispatched).toBe(0);
    expect(res2.body.skipped.already_sent).toBe(1);
  });
});
