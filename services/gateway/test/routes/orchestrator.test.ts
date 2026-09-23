/**
 * VTID-04319 — Orchestrator v2 P1 (docs/ORCHESTRATOR-REDESIGN-PLAN.md §3.1, §3.3, §3.5).
 *
 * AC-1 resolveAgentContext: one context from role_preferences, user_tenants,
 *      partner_organization_members and the route; reads fail soft.
 * AC-2 run ledger read side: query normalisation and per-plane summary.
 * AC-3 routes: /context needs any signed-in user; /runs, /runs/summary and
 *      /agents need exafy_admin; nothing writes.
 * AC-4 migration: additive, service-role only, view is security_invoker.
 * VTID-04325 AC-5 /policy: any signed-in user sees the defaults, their own
 *      ceilings and an optional dry evaluation; bad input is a 400.
 * VTID-04375 AC-7 /delegations: exafy_admin only; targets + job counts.
 * VTID-04370 AC-6 /budgets: exafy_admin only; today's spend vs budgets, over
 *      lines listed as would_deny; a read error is a 502.
 * VTID-04362 AC-6 /policy/shadow: exafy_admin only; returns the shadow window
 *      and the tool catalog summary; enforced is false.
 */

import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import request from 'supertest';

const identity: { current: any } = { current: null };

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn(async (req: any, res: any, next: any) => {
    if (!identity.current) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = identity.current;
    return next();
  }),
}));

const tables: Record<string, { data?: unknown; error?: { message: string } | null }> = {};
const calls: Array<{ table: string; ops: string[] }> = [];

function stubSupabase() {
  return {
    from(table: string) {
      const rec = { table, ops: [] as string[] };
      calls.push(rec);
      const result = tables[table] ?? { data: [], error: null };
      const chain: any = {};
      chain.range = (..._a: unknown[]) => { rec.ops.push('range'); return chain; };
      for (const op of ['select', 'eq', 'in', 'order', 'limit', 'gte']) {
        chain[op] = (..._a: unknown[]) => { rec.ops.push(op); return chain; };
      }
      for (const op of ['insert', 'update', 'upsert', 'delete']) {
        chain[op] = () => { throw new Error(`write attempted on ${table}`); };
      }
      chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({ data: result.data ?? null, error: result.error ?? null }).then(resolve, reject);
      return chain;
    },
  } as any;
}

jest.mock('../../src/lib/supabase', () => ({ getSupabase: () => stubSupabase() }));
jest.mock('../../src/services/orb-tools-shared', () => ({ ORB_TOOL_NAMES: ['log_water', 'dev_recent_events', 'dev_publish_to_prod'] }));

import { buildAgentContext, normalizeChannel, resolveAgentContext } from '../../src/services/orchestrator/context';
import { normalizeRunQuery, summarizeRunRows, RUN_LIST_MAX_LIMIT } from '../../src/services/orchestrator/run-ledger';
import orchestratorRouter from '../../src/routes/orchestrator';

function app() {
  const a = express();
  a.use('/api/v1/orchestrator', orchestratorRouter);
  return a;
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  calls.length = 0;
  identity.current = null;
});

describe('buildAgentContext (pure)', () => {
  test('preference wins and is reported as the source', () => {
    const c = buildAgentContext({
      user_id: 'u', tenant_id: 't', role_preference: 'admin', tenant_active_role: 'community',
      current_route: '/admin/users', channel: 'voice', now: new Date('2026-09-23T00:00:00Z'),
    });
    expect(c).toMatchObject({
      platform_role: 'admin', tenant_active_role: 'community', role_source: 'role_preferences',
      surface: 'admin', channel: 'voice', resolved_at: '2026-09-23T00:00:00.000Z', orgs: [],
    });
  });
  test('falls back to user_tenants, then none', () => {
    expect(buildAgentContext({ user_id: 'u', tenant_id: 't', tenant_active_role: 'patient' }).role_source).toBe('user_tenants');
    expect(buildAgentContext({ user_id: 'u', tenant_id: 't' })).toMatchObject({ platform_role: null, role_source: 'none' });
  });
  test('surface comes from the route, mobile is always vitanaland, explicit wins', () => {
    expect(buildAgentContext({ user_id: 'u', tenant_id: 't', current_route: '/command-hub/x' }).surface).toBe('command-hub');
    expect(buildAgentContext({ user_id: 'u', tenant_id: 't', current_route: '/backoffice', is_mobile: true }).surface).toBe('vitanaland');
    expect(buildAgentContext({ user_id: 'u', tenant_id: 't', explicit_surface: 'backoffice' }).surface).toBe('backoffice');
  });
  test('unknown channel normalises to web', () => {
    expect(normalizeChannel('smoke-signal')).toBe('web');
    expect(normalizeChannel('ci')).toBe('ci');
  });
});

describe('resolveAgentContext (reads)', () => {
  test('combines preference, membership and org membership', async () => {
    tables.role_preferences = { data: [{ role: 'backoffice' }] };
    tables.user_tenants = { data: [{ active_role: 'community' }] };
    tables.partner_organization_members = {
      data: [{ role: 'org_admin', partner_organization_id: 'o1', partner_organizations: { id: 'o1', org_key: 'acme', commerce_vertical: 'clinic' } }],
    };
    const c = await resolveAgentContext(stubSupabase(), { user_id: 'u', tenant_id: 't', current_route: '/backoffice/x' });
    expect(c).toMatchObject({
      platform_role: 'backoffice', surface: 'backoffice',
      orgs: [{ org_id: 'o1', org_key: 'acme', org_role: 'org_admin', commerce_vertical: 'clinic' }],
    });
  });
  test('a failed read leaves that field empty instead of throwing', async () => {
    tables.role_preferences = { error: { message: 'boom' } };
    tables.user_tenants = { data: [{ active_role: 'community' }] };
    tables.partner_organization_members = { error: { message: 'boom' } };
    const c = await resolveAgentContext(stubSupabase(), { user_id: 'u', tenant_id: 't' });
    expect(c).toMatchObject({ platform_role: 'community', role_source: 'user_tenants', orgs: [] });
  });
  test('no tenant: role reads are skipped', async () => {
    await resolveAgentContext(stubSupabase(), { user_id: 'u', tenant_id: null });
    expect(calls.map((c) => c.table)).toEqual(['partner_organization_members']);
  });
});

describe('run ledger read side (pure)', () => {
  test('normalizeRunQuery bounds the limit and rejects unknown statuses', () => {
    expect(normalizeRunQuery({ limit: '9999', status: 'exploded' })).toMatchObject({ limit: RUN_LIST_MAX_LIMIT, status: null });
    expect(normalizeRunQuery({})).toMatchObject({ limit: 50, plane: null, since: null });
    expect(normalizeRunQuery({ status: 'failed', since: 'nope' })).toMatchObject({ status: 'failed', since: null });
  });
  test('summarizeRunRows folds per plane, busiest first', () => {
    const out = summarizeRunRows([
      { plane: 'dev_autopilot', status: 'failed' },
      { plane: 'dev_autopilot', status: 'succeeded' },
      { plane: 'dev_autopilot', status: 'failed' },
      { plane: 'self_healing', status: 'failed' },
    ]);
    expect(out[0]).toEqual({ plane: 'dev_autopilot', total: 3, by_status: { failed: 2, succeeded: 1 } });
    expect(out[1]).toEqual({ plane: 'self_healing', total: 1, by_status: { failed: 1 } });
  });
});

describe('routes', () => {
  const admin = { user_id: 'a', tenant_id: 't', exafy_admin: true, email: null, role: 'authenticated' };
  const member = { user_id: 'm', tenant_id: 't', exafy_admin: false, email: null, role: 'authenticated' };

  test('/context: 401 anonymous, own context for a member', async () => {
    expect((await request(app()).get('/api/v1/orchestrator/context')).status).toBe(401);
    identity.current = member;
    tables.user_tenants = { data: [{ active_role: 'community' }] };
    const res = await request(app()).get('/api/v1/orchestrator/context?route=/home&channel=voice');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ user_id: 'm', platform_role: 'community', channel: 'voice', surface: 'vitanaland' });
  });

  test('/runs, /runs/summary, /agents: 403 for a non-admin', async () => {
    identity.current = member;
    for (const p of ['/runs', '/runs/summary', '/agents']) {
      expect((await request(app()).get(`/api/v1/orchestrator${p}`)).status).toBe(403);
    }
  });

  test('/runs reads the unified view with the normalised filters', async () => {
    identity.current = admin;
    tables.agent_runs_unified = { data: [{ run_key: 'dev_autopilot:1', plane: 'dev_autopilot', status: 'failed' }] };
    const res = await request(app()).get('/api/v1/orchestrator/runs?plane=dev_autopilot&status=failed&limit=5');
    expect(res.status).toBe(200);
    expect(res.body.data.runs).toHaveLength(1);
    const q = calls.find((c) => c.table === 'agent_runs_unified')!;
    expect(q.ops).toEqual(expect.arrayContaining(['select', 'order', 'eq', 'limit']));
  });

  test('/runs/summary returns per-plane counts', async () => {
    identity.current = admin;
    tables.agent_runs_unified = { data: [{ plane: 'self_healing', status: 'failed' }] };
    const res = await request(app()).get('/api/v1/orchestrator/runs/summary?days=3');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ days: 3, truncated: false, planes: [{ plane: 'self_healing', total: 1 }] });
  });

  test('/policy: 401 anonymous; own ceilings and a dry evaluation for a member (VTID-04325)', async () => {
    expect((await request(app()).get('/api/v1/orchestrator/policy')).status).toBe(401);
    identity.current = member;
    tables.user_tenants = { data: [{ active_role: 'community' }] };
    const res = await request(app()).get('/api/v1/orchestrator/policy?channel=voice&domain=community&tier=commit');
    expect(res.status).toBe(200);
    expect(res.body.data.defaults.enforced).toBe(false);
    expect(res.body.data.ceilings).toMatchObject({ community: 'draft', admin: 'none' });
    expect(res.body.data.evaluation).toMatchObject({ decision: 'escalate', domain: 'community', requested: 'commit' });
    expect((await request(app()).get('/api/v1/orchestrator/policy?domain=nope')).status).toBe(400);
    expect((await request(app()).get('/api/v1/orchestrator/policy?domain=dev&tier=root')).status).toBe(400);
  });

  test('/policy/shadow: 403 for a member; window + catalog for an admin (VTID-04362)', async () => {
    const { recordToolDecision, resetShadow } = await import('../../src/services/orchestrator/policy-shadow');
    resetShadow();
    identity.current = member;
    expect((await request(app()).get('/api/v1/orchestrator/policy/shadow')).status).toBe(403);
    recordToolDecision({ tool: 'dev_recent_events', role: 'community' });
    identity.current = admin;
    const res = await request(app()).get('/api/v1/orchestrator/policy/shadow');
    expect(res.status).toBe(200);
    expect(res.body.data.shadow).toMatchObject({ enforced: false, total_calls: 1, by_decision: { deny: 1 } });
    expect(res.body.data.catalog).toMatchObject({ tools: 3, unclassified: [] });
    expect(res.body.data.catalog.by_domain_tier.dev).toEqual({ read: 1, high: 1 });
  });

  test('/budgets: 403 for a member; spend vs budgets for an admin (VTID-04370)', async () => {
    identity.current = member;
    expect((await request(app()).get('/api/v1/orchestrator/budgets')).status).toBe(403);
    identity.current = admin;
    tables.oasis_events = { data: [
      { metadata: { service: 'dev-autopilot-planning', vtid: 'VTID-1', model: 'eu.anthropic.claude-opus-4-5-20251101-v1:0', input_tokens: 10_000_000, output_tokens: 400_000, cost_estimate_usd: 0 } },
      { metadata: { service: 'autopilot-agent', vtid: 'VTID-2', model: 'deepseek-flash', input_tokens: 1000, output_tokens: 10, cost_estimate_usd: 0.01 } },
    ] };
    const res = await request(app()).get('/api/v1/orchestrator/budgets');
    expect(res.status).toBe(200);
    expect(res.body.data.enforced).toBe(false);
    expect(res.body.data.spend).toMatchObject({ calls: 2, repriced_calls: 1 });
    expect(res.body.data.would_deny.map((l: any) => l.key)).toEqual(expect.arrayContaining(['dev-autopilot-planning', 'VTID-1']));
    tables.oasis_events = { error: { message: 'boom' } };
    expect((await request(app()).get('/api/v1/orchestrator/budgets')).status).toBe(502);
  });

  test('/delegations: 403 for a member; targets and job counts for an admin (VTID-04375)', async () => {
    identity.current = member;
    expect((await request(app()).get('/api/v1/orchestrator/delegations')).status).toBe(403);
    identity.current = admin;
    const res = await request(app()).get('/api/v1/orchestrator/delegations');
    expect(res.status).toBe(200);
    expect(res.body.data.targets.map((t: any) => t.agent_id)).toContain('operator');
    expect(res.body.data.jobs).toHaveProperty('total');
  });

  test('/agents returns agent cards; a read error is a 502, not a crash', async () => {
    identity.current = admin;
    tables.agents_registry = { data: [{ agent_id: 'orb-live', enabled: true }] };
    expect((await request(app()).get('/api/v1/orchestrator/agents')).body.data.agents).toHaveLength(1);
    tables.agents_registry = { error: { message: 'column does not exist' } };
    expect((await request(app()).get('/api/v1/orchestrator/agents')).status).toBe(502);
  });
});

describe('migration', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'supabase', 'migrations', '20260923120000_vtid_04319_orchestrator_run_ledger.sql'),
    'utf8',
  );
  test('is additive: no DROP / TRUNCATE / DELETE', () => {
    expect(sql).not.toMatch(/\b(DROP\s+(TABLE|COLUMN|VIEW)|TRUNCATE|DELETE\s+FROM)\b/i);
  });
  test('ledger tables are service-role only and the view runs as the invoker', () => {
    expect(sql).toMatch(/REVOKE ALL ON agent_runs, agent_run_steps, agent_run_signals FROM anon, authenticated/);
    expect(sql).toMatch(/REVOKE ALL ON agent_runs_unified FROM anon, authenticated/);
    expect(sql).toMatch(/VIEW agent_runs_unified WITH \(security_invoker = true\)/);
    for (const t of ['agent_runs', 'agent_run_steps', 'agent_run_signals']) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE ${t}\\s+ENABLE ROW LEVEL SECURITY`));
    }
  });
  test('the projection covers every existing run plane', () => {
    for (const src of ['dev_autopilot_executions', 'automation_runs', 'self_healing_log', 'agent_runs n']) {
      expect(sql).toContain(`FROM ${src}`);
    }
  });
});
