// VTID-05027 — /ops/health/push-dispatch reports how many ACTIVE members a
// push actually reached (push_reach_active RPC, 7 days) and turns degraded
// when fewer than 90 % of at least 10 eligible members were reached. A missing
// or failing RPC omits the field and never degrades.
import express from 'express';
import request from 'supertest';

let reachResult: { data: unknown; error: { message: string } | null } = { data: null, error: { message: 'no mock' } };
let reachArgs: unknown;

jest.mock('../src/lib/supabase', () => ({
  getSupabase: () => ({
    rpc: (name: string, args?: unknown) => {
      if (name === 'push_reach_active') {
        reachArgs = args;
        return Promise.resolve(reachResult);
      }
      return Promise.resolve({ data: null, error: { message: 'no mock' } });
    },
    from: () => {
      const b: any = {
        select: () => b,
        is: () => b,
        in: () => b,
        not: () => b,
        gte: () => b,
        order: () => b,
        limit: () => Promise.resolve({ data: [], error: null }),
      };
      return b;
    },
  }),
}));

import {
  opsHealthChecksRouter,
  resetOpsHealthCacheForTests,
  evalPushDispatch,
  PUSH_REACH_MIN_ELIGIBLE,
} from '../src/routes/ops-health-checks';

const now = Date.parse('2026-10-10T12:00:00Z');

describe('evalPushDispatch with active-member reach', () => {
  test('no reach → field omitted, behaviour unchanged', () => {
    expect(evalPushDispatch([], now)).toEqual({ status: 'ok', unsent: 0 });
  });

  test('reach is reported with its ratio', () => {
    const r = evalPushDispatch([], now, undefined, { active: 16, eligible: 15, reached: 14 });
    expect(r).toEqual({ status: 'ok', unsent: 0, active_reach_7d: { active: 16, eligible: 15, reached: 14, ratio: 0.93 } });
  });

  test('below 90 % of at least 10 eligible → degraded active_member_reach_low', () => {
    const r = evalPushDispatch([], now, undefined, { active: 30, eligible: 20, reached: 17 });
    expect(r.status).toBe('degraded');
    expect(r.reason).toBe('active_member_reach_low');
  });

  test('exactly 90 % is ok', () => {
    expect(evalPushDispatch([], now, undefined, { active: 12, eligible: 10, reached: 9 }).status).toBe('ok');
  });

  test('too few eligible members → no verdict', () => {
    const r = evalPushDispatch([], now, undefined, { active: 9, eligible: PUSH_REACH_MIN_ELIGIBLE - 1, reached: 0 });
    expect(r.status).toBe('ok');
  });

  test('zero eligible → ratio null, ok', () => {
    const r = evalPushDispatch([], now, undefined, { active: 3, eligible: 0, reached: 0 });
    expect(r).toEqual(expect.objectContaining({ status: 'ok', active_reach_7d: { active: 3, eligible: 0, reached: 0, ratio: null } }));
  });

  test('a stalled backlog and FCM errors are checked first', () => {
    const low = { active: 30, eligible: 20, reached: 2 };
    const old = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    expect(evalPushDispatch([{ created_at: old }], now, undefined, low).status).toBe('down');
    expect(evalPushDispatch([], now, { fcm_error: 30 }, low).reason).toBe('fcm_send_errors');
  });
});

describe('GET /ops/health/push-dispatch', () => {
  function app() {
    const a = express();
    a.use('/api/v1/ops/health', opsHealthChecksRouter);
    return a;
  }

  beforeEach(() => {
    resetOpsHealthCacheForTests();
    reachArgs = undefined;
  });

  test('calls push_reach_active for 7 days and reports active_reach_7d', async () => {
    reachResult = { data: [{ active: '16', eligible: '15', reached: '14' }], error: null };
    const res = await request(app()).get('/api/v1/ops/health/push-dispatch');
    expect(reachArgs).toEqual({ p_days: 7 });
    expect(res.body.status).toBe('ok');
    expect(res.body.active_reach_7d).toEqual({ active: 16, eligible: 15, reached: 14, ratio: 0.93 });
  });

  test('low reach → degraded', async () => {
    reachResult = { data: [{ active: 40, eligible: 30, reached: 20 }], error: null };
    const res = await request(app()).get('/api/v1/ops/health/push-dispatch');
    expect(res.body.status).toBe('degraded');
    expect(res.body.reason).toBe('active_member_reach_low');
  });

  test('RPC error (e.g. not migrated) → field omitted, still ok', async () => {
    reachResult = { data: null, error: { message: 'function push_reach_active does not exist' } };
    const res = await request(app()).get('/api/v1/ops/health/push-dispatch');
    expect(res.body.status).toBe('ok');
    expect(res.body).not.toHaveProperty('active_reach_7d');
  });
});
