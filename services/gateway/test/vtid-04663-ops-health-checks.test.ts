/**
 * VTID-04663 — Service Health Phase 2: checks for signals the database already
 * computes (routes/ops-health-checks.ts).
 */

import express from 'express';
import request from 'supertest';

let rpcResults: Record<string, { data: unknown; error: { message: string } | null }> = {};
let rpcCalls: string[] = [];
let pushRows: Array<{ created_at: string }> = [];
let pushQuery: Record<string, unknown> = {};

jest.mock('../src/lib/supabase', () => ({
  getSupabase: () => ({
    rpc: (name: string, args?: unknown) => {
      rpcCalls.push(name);
      if (args) pushQuery[`${name}.args`] = args;
      return Promise.resolve(rpcResults[name] ?? { data: null, error: { message: 'no mock' } });
    },
    from: (table: string) => {
      pushQuery.table = table;
      const b: any = {
        select: (c: string) => ((pushQuery.select = c), b),
        is: (c: string, v: unknown) => ((pushQuery.is = [c, v]), b),
        in: (c: string, v: unknown) => ((pushQuery.in = [c, v]), b),
        gte: (c: string, v: string) => ((pushQuery.gte = [c, v]), b),
        order: () => b,
        limit: () => Promise.resolve({ data: pushRows, error: null }),
      };
      return b;
    },
  }),
}));

import {
  opsHealthChecksRouter,
  resetOpsHealthCacheForTests,
  evalLlmRouting,
  evalAnthropicCredit,
  evalGoogleFallback,
  evalLocaleCoverage,
  evalTestActorGuard,
  evalLedgerIntegrity,
  evalOrbSessionLedger,
  evalPushDispatch,
} from '../src/routes/ops-health-checks';
import { classifyHealthResponse } from '../src/services/service-health-probe';

const HEALTHY_VITALS = {
  llm_stages_on_forbidden_provider: [],
  llm_anthropic_credit_failures_24h: 0,
  llm_bedrock_completions_24h: 2043,
  llm_vertex_completions_24h: 0,
  locales_ga: 11,
  journey_checklist_incomplete_ga_locales: [],
  notif_test_actor_guard_present: true,
  notif_test_actor_trigger_enabled: true,
};

function app() {
  const a = express();
  a.use('/api/v1/ops/health', opsHealthChecksRouter);
  return a;
}

beforeEach(() => {
  resetOpsHealthCacheForTests();
  rpcCalls = [];
  pushRows = [];
  pushQuery = {};
  rpcResults = {
    ci_vital_systems_health: { data: HEALTHY_VITALS, error: null },
    ci_ledger_integrity_check: { data: [], error: null },
    ci_orb_session_state_health: {
      data: { table_exists: true, session_starts_24h: 390, acks_24h: 320, acks_failed_24h: 0 },
      error: null,
    },
  };
});

describe('evaluators', () => {
  it('llm routing: a stage on a forbidden provider is down', () => {
    expect(evalLlmRouting(HEALTHY_VITALS).status).toBe('ok');
    expect(evalLlmRouting({ llm_stages_on_forbidden_provider: [{ stage: 'worker' }] }).status).toBe('down');
  });
  it('anthropic credit failures are down, Google completions are degraded', () => {
    expect(evalAnthropicCredit({ llm_anthropic_credit_failures_24h: 3 }).status).toBe('down');
    expect(evalAnthropicCredit(HEALTHY_VITALS).status).toBe('ok');
    expect(evalGoogleFallback({ llm_vertex_completions_24h: 1 }).status).toBe('degraded');
    expect(evalGoogleFallback(HEALTHY_VITALS).status).toBe('ok');
  });
  it('locale coverage and the test-account guard', () => {
    expect(evalLocaleCoverage({ journey_checklist_incomplete_ga_locales: [{ locale: 'tr' }] }).status).toBe('degraded');
    expect(evalLocaleCoverage(HEALTHY_VITALS).status).toBe('ok');
    // VTID-04880: the retired Navigator catalog no longer degrades a locale.
    const navOnly = evalLocaleCoverage({ nav_catalog_incomplete_ga_locales: [{ locale: 'tr' }] } as any);
    expect(navOnly.status).toBe('ok');
    expect(navOnly).not.toHaveProperty('nav_incomplete');
    expect(evalTestActorGuard({ notif_test_actor_guard_present: false }).reason).toBe('guard_function_missing');
    expect(evalTestActorGuard({ notif_test_actor_guard_present: true, notif_test_actor_trigger_enabled: false }).reason).toBe(
      'guard_trigger_disabled',
    );
    expect(evalTestActorGuard(HEALTHY_VITALS).status).toBe('ok');
  });
  it('ledger integrity and the ORB session ledger', () => {
    expect(evalLedgerIntegrity([]).status).toBe('ok');
    expect(evalLedgerIntegrity([{ vtid: 'VTID-1' }])).toMatchObject({ status: 'degraded', violations_7d: 1, vtids: ['VTID-1'] });
    expect(evalOrbSessionLedger({ table_exists: false }).status).toBe('down');
    expect(evalOrbSessionLedger({ table_exists: true, acks_failed_24h: 2 }).status).toBe('degraded');
    expect(evalOrbSessionLedger({ table_exists: true, acks_failed_24h: 0 }).status).toBe('ok');
    // ALERT-ORB-SESSION-STATE-HEALTH rule: traffic with no state writes is a failure
    expect(evalOrbSessionLedger({ table_exists: true, session_starts_24h: 5, state_writes_24h: 0, acks_failed_24h: 0 }))
      .toMatchObject({ status: 'down', reason: 'no_state_writes' });
    expect(evalOrbSessionLedger({ table_exists: true, session_starts_24h: 4, state_writes_24h: 0 }).status).toBe('ok');
    expect(evalOrbSessionLedger({ table_exists: true, session_starts_24h: 50, state_writes_24h: 12 }).status).toBe('ok');
  });
  it('push dispatch: stale over 15 min or backlog over 25 is degraded, over 60 min is down', () => {
    const now = Date.parse('2026-09-26T12:00:00Z');
    const ago = (m: number) => new Date(now - m * 60000).toISOString();
    expect(evalPushDispatch([], now).status).toBe('ok');
    expect(evalPushDispatch([{ created_at: ago(2) }], now).status).toBe('ok');
    expect(evalPushDispatch([{ created_at: ago(20) }], now).status).toBe('degraded');
    expect(evalPushDispatch(Array.from({ length: 30 }, () => ({ created_at: ago(1) })), now).status).toBe('degraded');
    expect(evalPushDispatch([{ created_at: ago(90) }], now)).toMatchObject({ status: 'down', oldest_age_min: 90 });
  });
});

describe('routes', () => {
  const PATHS = [
    'llm-routing',
    'anthropic-credit',
    'google-fallback',
    'locale-coverage',
    'test-actor-guard',
    'vtid-ledger',
    'orb-session-ledger',
    'push-dispatch',
  ];

  it.each(PATHS)('/%s answers 200 JSON that the panel reads as healthy', async (p) => {
    const res = await request(app()).get(`/api/v1/ops/health/${p}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(classifyHealthResponse(res.status, res.body).healthy).toBe(true);
  });

  it('the five vital checks share one cached RPC call', async () => {
    const a = app();
    for (const p of PATHS.slice(0, 5)) await request(a).get(`/api/v1/ops/health/${p}`);
    expect(rpcCalls.filter((c) => c === 'ci_vital_systems_health')).toHaveLength(1);
  });

  it('push dispatch reads only the dispatcher 48 h window of push-eligible unsent rows', async () => {
    await request(app()).get('/api/v1/ops/health/push-dispatch');
    expect(pushQuery.table).toBe('user_notifications');
    expect(pushQuery.is).toEqual(['push_sent_at', null]);
    expect(pushQuery.in).toEqual(['channel', ['push', 'push_and_inapp']]);
    const since = Date.parse((pushQuery.gte as [string, string])[1]);
    expect(Math.abs(Date.now() - 48 * 3600 * 1000 - since)).toBeLessThan(60_000);
  });

  it('a failing RPC is reported as down with its reason, never green', async () => {
    rpcResults.ci_vital_systems_health = { data: null, error: { message: 'permission denied' } };
    const res = await request(app()).get('/api/v1/ops/health/llm-routing');
    expect(res.body).toMatchObject({ status: 'down', reason: 'check_failed' });
    expect(res.body.detail).toMatch(/permission denied/);
    expect(classifyHealthResponse(res.status, res.body).healthy).toBe(false);
  });

  it('the ledger check calls ci_ledger_integrity_check with a 7-day window', async () => {
    rpcResults.ci_ledger_integrity_check = { data: [{ vtid: 'VTID-00001' }], error: null };
    const res = await request(app()).get('/api/v1/ops/health/vtid-ledger');
    expect(res.body).toMatchObject({ status: 'degraded', violations_7d: 1 });
    expect(pushQuery['ci_ledger_integrity_check.args']).toEqual({ p_lookback_days: 7 });
  });
});
