/**
 * VTID-04892 — Vitana Onboarding Assistant, slice 1 (shadow only).
 * `npm run test:onboarding`
 *
 * Plan v3 (docs/plans/VITANA-ONBOARDING-ASSISTANT-PLAN.md), sparred and owner
 * approved. Pins: the stage/ladder/decision rules; the mode rules (never on
 * staging, feature flag, rollout date, no live mode yet); the tick writes only
 * coach-owned tables and sends nothing; strict exclusion (a failed lookup
 * skips the whole tick); a 90-day simulation; the tick enforces its own token.
 */
import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import request from 'supertest';

const mockStrict = jest.fn();
jest.mock('../src/lib/excluded-test-service-accounts', () => ({
  fetchExcludedTestServiceAccountIdsStrict: (...a: unknown[]) => mockStrict(...a),
  fetchExcludedTestServiceAccountIds: jest.fn(async () => new Set<string>()),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import {
  decide, inCohort, localDate, nextAction, stageForTenure, MAX_IGNORED_STREAK, type MemberInput,
} from '../src/services/onboarding-coach/ladder';
import { resolveCoachConfig } from '../src/services/onboarding-coach/config';
import { runCoachTick } from '../src/services/onboarding-coach/coach-service';

const DAY = 86_400_000;
const NOW = new Date('2026-10-20T10:00:00Z');
const ROLLOUT = new Date('2026-10-15T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

function member(over: Partial<MemberInput> = {}): MemberInput {
  return {
    joinedAt: daysAgo(0.2),
    localDay: '2026-10-20',
    achieved: new Set(),
    audiobook: { reminderSet: false, listenedToday: false, everListened: false },
    touchedToday: false,
    ...over,
  };
}

describe('VTID-04892: stages and the ladder', () => {
  it('maps tenure to stages and ends at 90 days', () => {
    expect([0, 1, 2, 3, 4, 7, 8, 30, 31, 60, 61, 89, 90].map(stageForTenure)).toEqual(
      ['d0', 'd1', 'd2_3', 'd2_3', 'd4_7', 'd4_7', 'd8_30', 'd8_30', 'd31_60', 'd31_60', 'd61_90', 'd61_90', 'done']);
  });

  it('teaches in ladder order and only steps the member is far enough in for', () => {
    expect(nextAction('d0', new Set(), false)).toBe('listen_first_episode');
    expect(nextAction('d0', new Set(), true)).toBe('complete_profile');
    expect(nextAction('d0', new Set(['profile_complete']), true)).toBeNull(); // first_diary starts at d1
    expect(nextAction('d1', new Set(['profile_complete']), true)).toBe('first_diary');
    expect(nextAction('d4_7', new Set(['profile_complete', 'first_diary', 'first_group']), true)).toBe('first_connection');
    expect(nextAction('done', new Set(), false)).toBeNull();
  });

  it('only uses milestones that milestone-service already detects (no new milestones in slice 1)', () => {
    const { MILESTONES } = require('../src/services/milestone-service');
    const { LADDER } = require('../src/services/onboarding-coach/ladder');
    for (const r of LADDER) if ('milestone' in r.doneWhen) expect(MILESTONES[r.doneWhen.milestone]).toBeDefined();
  });
});

describe('VTID-04892: one member, one day', () => {
  it('would touch a fresh member with the next step', () => {
    expect(decide(member(), NOW)).toEqual({ stage: 'd0', actionKey: 'listen_first_episode', decision: 'would_touch', reason: 'touch' });
  });

  it('respects opt-out, the 90-day window and snooze', () => {
    expect(decide(member({ optedOutAt: daysAgo(1) }), NOW).reason).toBe('opted_out');
    expect(decide(member({ joinedAt: daysAgo(95) }), NOW).reason).toBe('graduated');
    expect(decide(member({ snoozedUntil: new Date(NOW.getTime() + DAY) }), NOW).reason).toBe('snoozed');
  });

  it('backs off ×2 after each ignored touch and stops after 3 ignores', () => {
    expect(decide(member({ ignoredStreak: 1, lastTouchAt: daysAgo(1) }), NOW).reason).toBe('backing_off');
    expect(decide(member({ ignoredStreak: 1, lastTouchAt: daysAgo(3) }), NOW).decision).toBe('would_touch');
    expect(decide(member({ ignoredStreak: 2, lastTouchAt: daysAgo(3) }), NOW).reason).toBe('backing_off');
    expect(decide(member({ ignoredStreak: MAX_IGNORED_STREAK, lastTouchAt: daysAgo(30) }), NOW).reason).toBe('paused_after_ignores');
  });

  it('gives the day to the Audiobook reminder (set and today not heard, or already sent today)', () => {
    const reminder = { reminderSet: true, listenedToday: false, everListened: true };
    expect(decide(member({ audiobook: reminder }), NOW).reason).toBe('audiobook_owns_day');
    expect(decide(member({ audiobook: { ...reminder, listenedToday: true, reminderLastSentLocalDate: '2026-10-20' } }), NOW).reason)
      .toBe('audiobook_owns_day');
    expect(decide(member({ audiobook: { ...reminder, listenedToday: true, reminderLastSentLocalDate: '2026-10-19' } }), NOW).decision)
      .toBe('would_touch');
  });

  it('never a second touch the same local day', () => {
    expect(decide(member({ touchedToday: true }), NOW).reason).toBe('already_touched_today');
  });

  it('a pilot stage override wins over tenure', () => {
    expect(decide(member({ joinedAt: daysAgo(400), stageOverride: 'd0' }), NOW).stage).toBe('d0');
  });

  it('cohort = joined on/after rollout − 30 days and still inside 90 days', () => {
    expect(inCohort(daysAgo(20), ROLLOUT, NOW)).toBe(true);          // joined before rollout, within 30 days of it
    expect(inCohort(new Date(ROLLOUT.getTime() - 31 * DAY), ROLLOUT, NOW)).toBe(false);
    expect(inCohort(daysAgo(91), new Date(NOW.getTime() - 200 * DAY), NOW)).toBe(false);
  });

  it("uses the member's local date", () => {
    const lateUtc = new Date('2026-10-20T23:30:00Z');
    expect(localDate(lateUtc, 'Europe/Berlin')).toBe('2026-10-21');
    expect(localDate(lateUtc, 'America/New_York')).toBe('2026-10-20');
    expect(localDate(lateUtc, 'Not/AZone')).toBe('2026-10-21'); // falls back to Europe/Berlin
  });
});

describe('VTID-04892: mode', () => {
  const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;
  it('never runs on staging', () => {
    expect(resolveCoachConfig(env({ VOA_ROLLOUT_DATE: '2026-10-15' }), { isStaging: true, featureLive: true }).mode)
      .toBe('disabled-on-staging');
  });
  it('is off without the feature flag or a valid rollout date', () => {
    expect(resolveCoachConfig(env({ VOA_ROLLOUT_DATE: '2026-10-15' }), { isStaging: false, featureLive: false }).mode).toBe('off');
    expect(resolveCoachConfig(env({}), { isStaging: false, featureLive: true }).reason).toBe('rollout_date_missing');
    expect(resolveCoachConfig(env({ VOA_ROLLOUT_DATE: 'soon' }), { isStaging: false, featureLive: true }).mode).toBe('off');
  });
  it('has no live mode in slice 1: VOA_MODE=live still runs shadow', () => {
    const c = resolveCoachConfig(env({ VOA_ROLLOUT_DATE: '2026-10-15', VOA_MODE: 'live' }), { isStaging: false, featureLive: true });
    expect(c).toMatchObject({ mode: 'shadow', reason: 'live_not_available' });
  });
});

// ── Minimal in-memory supabase-js shim (only what the coach uses) ─────────────
function fakeDb(tables: Record<string, any[]>) {
  const writes: Array<{ table: string; op: string; rows: any[] }> = [];
  const rpc = jest.fn(async () => ({ data: null, error: null }));
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let range: [number, number] | null = null;
    const q: any = {
      select: () => q,
      order: () => q,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      gte: (c: string, v: any) => { filters.push((r) => String(r[c]) >= String(v)); return q; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q; },
      range: (a: number, b: number) => { range = [a, b]; return q; },
      upsert: async (rows: any[], opts: { onConflict: string }) => {
        writes.push({ table, op: 'upsert', rows });
        const keys = opts.onConflict.split(',');
        const t = (tables[table] ??= []);
        for (const r of rows) {
          const i = t.findIndex((x) => keys.every((k) => x[k] === r[k]));
          if (i >= 0) t[i] = { ...t[i], ...r }; else t.push({ ...r });
        }
        return { error: null };
      },
      insert: async (rows: any) => { writes.push({ table, op: 'insert', rows: [rows].flat() }); return { error: null }; },
      update: () => { writes.push({ table, op: 'update', rows: [] }); return q; },
      delete: () => { writes.push({ table, op: 'delete', rows: [] }); return q; },
      then: (ok: any, ko: any) => {
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (range) rows = rows.slice(range[0], range[1] + 1);
        return Promise.resolve({ data: rows, error: null }).then(ok, ko);
      },
    };
    return q;
  }
  return { client: { from, rpc } as any, writes, rpc, tables };
}

const NEW = '11111111-1111-4111-8111-111111111111';
const BOT = '22222222-2222-4222-8222-222222222222';
const VETERAN = '33333333-3333-4333-8333-333333333333';
const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const shadow = { mode: 'shadow' as const, reason: 'shadow', rolloutDate: ROLLOUT };

function seed() {
  return {
    user_tenants: [
      { user_id: NEW, tenant_id: T, is_primary: true, created_at: daysAgo(2).toISOString() },
      { user_id: BOT, tenant_id: T, is_primary: true, created_at: daysAgo(1).toISOString() },
      { user_id: VETERAN, tenant_id: T, is_primary: true, created_at: daysAgo(300).toISOString() },
    ],
    profiles: [{ user_id: NEW, timezone: 'Europe/Berlin' }],
    autopilot_recommendations: [{ user_id: NEW, source_type: 'milestone', status: 'completed', source_ref: 'profile_complete' }],
    user_guided_journey_state: [{ user_id: NEW, metadata: { daily_listen: { date: '2026-10-19', sessions: [255] } } }],
    onboarding_coach_state: [] as any[],
    onboarding_coach_decisions: [] as any[],
    onboarding_touch_ledger: [] as any[],
  };
}

describe('VTID-04892: the tick (shadow — sends nothing)', () => {
  beforeEach(() => mockStrict.mockReset());

  it('skips the whole tick when the strict exclusion lookup fails', async () => {
    mockStrict.mockResolvedValue({ ok: false, error: 'boom' });
    const db = fakeDb(seed());
    const emit = jest.fn(async () => ({ ok: true }));
    const r = await runCoachTick({ sb: db.client, now: NOW, config: shadow, emit });
    expect(r).toMatchObject({ ok: false, reason: 'exclusion_unavailable' });
    expect(db.writes).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
  });

  it('decides for cohort members only, writes only coach tables, one aggregate event', async () => {
    mockStrict.mockResolvedValue({ ok: true, ids: new Set([BOT]) });
    const db = fakeDb(seed());
    const emit = jest.fn(async () => ({ ok: true }));
    const r = await runCoachTick({ sb: db.client, now: NOW, config: shadow, emit });

    expect(r).toMatchObject({ ok: true, mode: 'shadow', cohort: 1, excluded: 1, would_touch: 1, stage_changes: 0 });
    expect(new Set(db.writes.map((w) => w.table))).toEqual(new Set(['onboarding_coach_state', 'onboarding_coach_decisions']));
    expect(db.writes.every((w) => w.op === 'upsert')).toBe(true);
    expect(db.rpc).not.toHaveBeenCalled(); // no claim, no credit_wallet, nothing
    expect(db.tables.onboarding_coach_decisions).toEqual([
      expect.objectContaining({ user_id: NEW, local_day: '2026-10-20', mode: 'shadow', stage: 'd2_3', action_key: 'first_diary', decision: 'would_touch' }),
    ]);
    expect(emit).toHaveBeenCalledTimes(1);
    expect((emit.mock.calls[0] as any)[0].type).toBe('onboarding.coach.tick_completed');
  });

  it('re-running the same day overwrites the decision (one row per member per day)', async () => {
    mockStrict.mockResolvedValue({ ok: true, ids: new Set([BOT]) });
    const db = fakeDb(seed());
    await runCoachTick({ sb: db.client, now: NOW, config: shadow, emit: jest.fn(async () => ({ ok: true })) as any });
    await runCoachTick({ sb: db.client, now: new Date(NOW.getTime() + 3_600_000), config: shadow, emit: jest.fn(async () => ({ ok: true })) as any });
    expect(db.tables.onboarding_coach_decisions).toHaveLength(1);
  });

  it('simulates 90 days: a stage change emits one transition event, then the member graduates', async () => {
    mockStrict.mockResolvedValue({ ok: true, ids: new Set([BOT]) });
    const db = fakeDb(seed());
    const types: string[] = [];
    const emit = jest.fn(async (e: any) => { types.push(e.type); return { ok: true }; });
    for (let d = 0; d <= 90; d++) {
      await runCoachTick({ sb: db.client, now: new Date(NOW.getTime() + d * DAY), config: shadow, emit });
    }
    const stages = types.filter((t) => t === 'onboarding.coach.stage_changed').length;
    expect(stages).toBe(4); // d2_3 → d4_7 → d8_30 → d31_60 → d61_90 (graduates out of the cohort at day 90)
    expect(types.filter((t) => t === 'onboarding.coach.tick_completed')).toHaveLength(91);
    expect(db.tables.onboarding_coach_decisions.length).toBeGreaterThan(80);
    expect(db.writes.some((w) => !['onboarding_coach_state', 'onboarding_coach_decisions'].includes(w.table))).toBe(false);
  });

  it('the coach code has no send path at all in slice 1', () => {
    const dir = path.join(__dirname, '../src/services/onboarding-coach');
    const src = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    for (const forbidden of ['notifyUser', 'sendPushToUser', 'chat_messages', 'profile_posts', 'recordTouch', 'credit_wallet', 'claim_onboarding_touch']) {
      expect(src).not.toContain(forbidden);
    }
  });
});

describe('VTID-04892: the endpoints', () => {
  const prev = { ...process.env };
  afterEach(() => { process.env = { ...prev }; jest.resetModules(); });

  function appWith(env: Record<string, string | undefined>) {
    process.env = { ...prev, ...env } as NodeJS.ProcessEnv;
    jest.resetModules();
    const app = express();
    app.use(express.json());
    app.use('/api/v1/scheduled-notifications', require('../src/routes/scheduled-notifications').default);
    app.use('/api/v1/onboarding-coach', require('../src/routes/onboarding-coach').default);
    return app;
  }

  it('the tick needs the internal token whatever the global auth mode is', async () => {
    const app = appWith({ GATEWAY_INTERNAL_TOKEN: 'secret', SCHEDULED_NOTIFICATIONS_AUTH_MODE: 'off' });
    expect((await request(app).post('/api/v1/scheduled-notifications/onboarding-coach-tick')).status).toBe(401);
    expect((await request(app).post('/api/v1/scheduled-notifications/onboarding-coach-tick').set('X-Gateway-Internal', 'nope')).status).toBe(403);
  });

  it('503 when no internal token is configured', async () => {
    const app = appWith({ GATEWAY_INTERNAL_TOKEN: '', SCHEDULED_NOTIFICATIONS_AUTH_MODE: 'off' });
    expect((await request(app).post('/api/v1/scheduled-notifications/onboarding-coach-tick')).status).toBe(503);
  });

  it('the staging gateway refuses the tick even with a valid token', async () => {
    const app = appWith({ GATEWAY_INTERNAL_TOKEN: 'secret', VITANA_ENV: 'staging', FEATURE_ONBOARDING_ASSISTANT_ENV: 'staging+prod', VOA_ROLLOUT_DATE: '2026-10-15' });
    const r = await request(app).post('/api/v1/scheduled-notifications/onboarding-coach-tick').set('X-Gateway-Internal', 'secret');
    expect(r.status).toBe(409);
    expect(r.body.mode).toBe('disabled-on-staging');
  });

  it('status is a read-only GET with the mode and nothing about members', async () => {
    const app = appWith({ VITANA_ENV: 'staging' });
    const r = await request(app).get('/api/v1/onboarding-coach/status');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, mode: 'disabled-on-staging', reason: 'staging_shares_production_database', env: 'staging' });
  });
});
