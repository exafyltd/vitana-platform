/**
 * VTID-05277 — plan kiro-autonomy-fallback §5 F (lane staging-proof).
 *
 * The proof lane's own test: with the repo variable CLAUDE_AVAILABLE=false the
 * Project Manager runs in Kiro-fallback mode. It pins the three things the
 * staging suite (docs/validation/VTID-05277/staging-tests.json) reads on the
 * deployed build:
 *   1. claudeAvailability — only the literal flag `false` (or the 4 h rule)
 *      makes Claude unavailable; unset / true / unknown keeps today's routing.
 *   2. the public GET /mode carries exactly {ok, enabled, mode, executor_mode}
 *      and reports `kiro_fallback` after a tick that observed the flag false;
 *      GET /status stays behind requireServiceOrAdmin and carries the detail.
 *   3. end of the seat rotation never goes to `claude` while Claude is
 *      unavailable — it goes to the exceptions seat.
 *
 * Pure: no network, no DB, no write. Read-only by construction.
 */
import express from 'express';
import request from 'supertest';
import { createProjectManagerRouter } from '../src/routes/project-manager';
import {
  claudeAvailability,
  runDecideTick,
  type PmObserver,
  type PmStatusSnapshot,
} from '../src/services/project-manager';
import { decide, parkDecision, reassignDecision } from '../src/services/project-manager/decide';
import {
  EXCEPTIONS_SEAT,
  type ObservedClaude,
  type ObservedLane,
  type ObservedState,
} from '../src/services/project-manager/types';

const SERVICE_TOKEN = 'test-proof-service-token';
const NOW = Date.parse('2026-10-20T21:00:00Z');
const HOUR = 3600_000;
const ISO = (ms: number) => new Date(ms).toISOString();

const FLAG_FALSE: ObservedClaude = { flag: false, oldest_assigned_at: null, last_action_at: null };
const FLAG_TRUE: ObservedClaude = { flag: true, oldest_assigned_at: null, last_action_at: null };

function lane(o: Partial<ObservedLane> = {}): ObservedLane {
  return {
    slug: 'kiro-autonomy-fallback',
    lane: 'staging-proof',
    vtid: 'VTID-05277',
    state: 'ready',
    seat: 'exafy',
    reviewer_seat: 'jtadic',
    area: 'frontend',
    paths: ['services/gateway/test/kiro-autonomy-fallback-proof.test.ts'],
    depends_on: [],
    pr: null,
    reviews: [],
    executing_log: [],
    state_since: ISO(NOW - 30 * HOUR),
    last_branch_activity: null,
    claimed_at: null,
    seat_ran_automation_in_window: false,
    staging_verified: false,
    deploys: true,
    staging_verified_at: null,
    gate2_sent: false,
    ...o,
  };
}

function state(lanes: ObservedLane[], claude?: ObservedClaude): ObservedState {
  return {
    mode: 'live',
    lanes,
    rotations: [{ area: 'frontend', seats: ['exafy'] }],
    ...(claude ? { claude } : {}),
  };
}

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  return fn().finally(() => {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

function appWith(getSnapshot?: () => PmStatusSnapshot) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/project-manager', createProjectManagerRouter(getSnapshot));
  return app;
}

describe('VTID-05277 proof 1: claudeAvailability (plan §3)', () => {
  it('flag false → unavailable (flag_false)', () => {
    expect(claudeAvailability(FLAG_FALSE, NOW)).toEqual({ available: false, reason: 'flag_false' });
  });
  it('flag true, unknown, or nothing observed → available (no silent fallback)', () => {
    expect(claudeAvailability(FLAG_TRUE, NOW)).toEqual({ available: true, reason: null });
    expect(claudeAvailability({ flag: null, oldest_assigned_at: null, last_action_at: null }, NOW)).toEqual({
      available: true,
      reason: null,
    });
    expect(claudeAvailability(undefined, NOW)).toEqual({ available: true, reason: null });
  });
  it('4 h without a Claude Code action → unavailable (no_action_4h), flag true does not override', () => {
    const c: ObservedClaude = { flag: true, oldest_assigned_at: ISO(NOW - 5 * HOUR), last_action_at: null };
    expect(claudeAvailability(c, NOW)).toEqual({ available: false, reason: 'no_action_4h' });
  });
});

describe('VTID-05277 proof 2: /mode and /status bodies', () => {
  const fallbackSnap: PmStatusSnapshot = {
    mode: 'live',
    last_tick_at: ISO(NOW),
    decisions: [],
    claude: { available: false, reason: 'flag_false' },
    fallback: true,
    build_lanes_in_flight: { 'kiro-autonomy-fallback': 1 },
    last_lease: 'acquired',
  };

  it('/mode is public and carries exactly ok, enabled, mode, executor_mode = kiro_fallback', async () => {
    await withEnv({ PM_AGENT_ENABLED: 'true', GATEWAY_SERVICE_TOKEN: SERVICE_TOKEN }, async () => {
      const res = await request(appWith(() => fallbackSnap)).get('/api/v1/project-manager/mode');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, enabled: true, mode: 'live', executor_mode: 'kiro_fallback' });
      expect(res.body).not.toHaveProperty('claude_available');
      expect(res.body).not.toHaveProperty('claude_reason');
      expect(res.body).not.toHaveProperty('decisions');
    });
  });

  it('/status stays auth-gated (401 without a token, 401 with an invalid bearer)', async () => {
    await withEnv({ GATEWAY_SERVICE_TOKEN: SERVICE_TOKEN }, async () => {
      const app = appWith(() => fallbackSnap);
      expect((await request(app).get('/api/v1/project-manager/status')).status).toBe(401);
      const probe = await request(app)
        .get('/api/v1/project-manager/status')
        .set('Authorization', 'Bearer staging-verify.invalid.probe');
      expect(probe.status).toBe(401);
    });
  });

  it('/status with the service token carries claude, fallback and last_lease', async () => {
    await withEnv({ PM_AGENT_ENABLED: 'true', GATEWAY_SERVICE_TOKEN: SERVICE_TOKEN }, async () => {
      const res = await request(appWith(() => fallbackSnap))
        .get('/api/v1/project-manager/status')
        .set('Authorization', `Bearer ${SERVICE_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        enabled: true,
        mode: 'live',
        claude: { available: false, reason: 'flag_false' },
        fallback: true,
        last_lease: 'acquired',
      });
    });
  });

  it('a tick that observes CLAUDE_AVAILABLE=false makes the default /mode report kiro_fallback', async () => {
    await withEnv({ PM_AGENT_ENABLED: 'true', PM_MODE: 'live' }, async () => {
      const observer: PmObserver = { observe: async () => state([], FLAG_FALSE) };
      await runDecideTick({ observer, emitter: { emit: async () => undefined }, now: () => NOW });
      const res = await request(appWith()).get('/api/v1/project-manager/mode');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, enabled: true, mode: 'live', executor_mode: 'kiro_fallback' });
    });
  });

  it('a tick with Claude available keeps the default /mode on claude_primary', async () => {
    await withEnv({ PM_AGENT_ENABLED: 'true', PM_MODE: 'live' }, async () => {
      const observer: PmObserver = { observe: async () => state([], FLAG_TRUE) };
      await runDecideTick({ observer, emitter: { emit: async () => undefined }, now: () => NOW });
      const res = await request(appWith()).get('/api/v1/project-manager/mode');
      expect(res.body.executor_mode).toBe('claude_primary');
    });
  });
});

describe('VTID-05277 proof 3: end of rotation never goes to claude while unavailable', () => {
  it('stale ready lane at the end of the rotation → exceptions seat, not claude', () => {
    const l = lane();
    const d = reassignDecision(l, state([l], FLAG_FALSE), NOW);
    expect(d).not.toBeNull();
    expect(d?.to_actor).toBe(EXCEPTIONS_SEAT);
    expect(d?.to_actor).not.toBe('claude');
    expect(d?.fallback).toBe(true);
  });

  it('a stale review at the end of the rotation → exceptions seat, not claude', () => {
    const l = lane({ state: 'in-review', reviewer_seat: 'exafy' });
    const d = reassignDecision(l, state([l], FLAG_FALSE), NOW);
    expect(d?.to_actor).toBe(EXCEPTIONS_SEAT);
  });

  it('no decision of a fallback tick routes any job to claude', () => {
    const lanes = [
      lane({ lane: 'a' }),
      lane({ lane: 'b', state: 'in-review', reviewer_seat: 'exafy' }),
      lane({ lane: 'c', area: null }),
    ];
    const decisions = decide(state(lanes, FLAG_FALSE), NOW);
    expect(decisions.length).toBeGreaterThan(0);
    for (const d of decisions) {
      expect(JSON.stringify(d)).not.toMatch(/"(to_actor|next_actor)":"claude"/);
    }
  });

  it('a parked lane goes to the exceptions seat while unavailable', () => {
    const l = lane({
      state: 'executing',
      claimed_at: ISO(NOW - 60 * HOUR),
      last_branch_activity: null,
      driver_heartbeat_at: null,
    });
    const d = parkDecision(l, NOW, { available: false, reason: 'flag_false' });
    expect(d).toMatchObject({ kind: 'park', reason: 'stale_claim', to_actor: EXCEPTIONS_SEAT, fallback: true });
  });

  it('control: Claude available → end of rotation still goes to claude (today’s routing)', () => {
    const l = lane();
    const d = reassignDecision(l, state([l], FLAG_TRUE), NOW);
    expect(d?.to_actor).toBe('claude');
    expect(d?.fallback).toBe(false);
  });
});
