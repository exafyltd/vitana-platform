/**
 * VTID-04754: Jev P0 foundation — plane × data policy, per-tenant flag and
 * budget, persisted spend, caller resolution (canonical role, permitted set,
 * tenant fallback, exafy_admin target tenant) and the shadow framework.
 * Jev calls are injected; OASIS emit and Supabase are fakes.
 */
const emitted: any[] = [];
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async (e: any) => {
    emitted.push(e);
    return { ok: true };
  }),
}));

const ok = (data: unknown) => ({ data, error: null });
const repoState: {
  primary: string | null;
  pref: string | null;
  active: string | null;
  grants: string[];
  memberships: string[];
  grantsError?: boolean;
  tenants: Record<string, string>;
  shadow: any[];
} = { primary: null, pref: null, active: null, grants: [], memberships: [], tenants: {}, shadow: [] };

jest.mock('../src/services/jev/jev-repository', () => ({
  fetchPrimaryTenant: jest.fn(async () => ok(repoState.primary ? { tenant_id: repoState.primary } : null)),
  fetchLatestRolePreference: jest.fn(async () => ok(repoState.pref ? { role: repoState.pref } : null)),
  fetchTenantActiveRole: jest.fn(async () => ok(repoState.active ? { active_role: repoState.active } : null)),
  fetchExplicitRoleGrants: jest.fn(async () =>
    repoState.grantsError ? { data: null, error: { message: 'boom' } } : ok(repoState.grants.map((role) => ({ role }))),
  ),
  fetchActiveMembershipRoles: jest.fn(async () => ok(repoState.memberships.map((role) => ({ role })))),
  fetchTenantByIdOrSlug: jest.fn(async (_sb: unknown, v: string) => ok(repoState.tenants[v] ? { tenant_id: repoState.tenants[v], slug: v } : null)),
  insertShadowDecision: jest.fn(async (_sb: unknown, row: any) => {
    repoState.shadow.push(row);
    return ok({ id: `s${repoState.shadow.length}` });
  }),
  updateShadowOutcome: jest.fn(async () => ok(null)),
}));

import { decide } from '../src/services/jev/jev-decision-service';
import { listJevDecisions } from '../src/services/jev/jev-decisions';
import { evaluateJevPolicy, parseJevTenantFlag, JEV_DEFAULT_TENANT_FLAG, JEV_PLATFORM_TENANT } from '../src/services/jev/jev-policy';
import { createMemoryJevControl, setDefaultJevControlForTest, currentMonthUtc } from '../src/services/jev/jev-tenant-control';
import { resolveJevCaller, JevCallerError, computePermittedRoles } from '../src/services/jev/jev-caller';
import { jevGateMode, jevGateEnvName, runJevGate } from '../src/services/jev/jev-shadow';
import { resetJevStatsForTest } from '../src/services/jev/jev-telemetry';
import type { JevCallResult } from '../src/services/jev/jev-client';

const ENV = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' } as NodeJS.ProcessEnv;
const MEMBER_ENV = { ...ENV, JEV_COMMUNITY_ENABLED: 'true' } as NodeJS.ProcessEnv;
const staff = { actor_id: 'user-1', active_role: 'staff', tenant_id: 't1' };

function okCall(answers: any, input_tokens = 1_000_000): JevCallResult {
  return { ok: true, model: 'jev-1.13.0', answers, usage: { input_tokens, output_tokens: 2 }, latency_ms: 40, attempts: 1 };
}
const ticket = () =>
  okCall({
    category: { type: 'choice', choice: 'billing', probabilities: { billing: 0.95 }, confidence: 0.95 },
    urgency: { type: 'score', score: 1, probabilities: [0.1, 0.8, 0.05, 0.05], confidence: 0.8 },
  });
const opsAnswer = () =>
  okCall(
    {
      cause: { type: 'choice', choice: 'transient', probabilities: { transient: 0.9 }, confidence: 0.9 },
      needs_human: { type: 'noul', noul: 0.1 },
    },
    1000,
  );

beforeEach(() => {
  emitted.length = 0;
  resetJevStatsForTest();
  setDefaultJevControlForTest(createMemoryJevControl().control);
  Object.assign(repoState, { primary: null, pref: null, active: null, grants: [], memberships: [], grantsError: false, tenants: {}, shadow: [] });
});

afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-04754 every decision declares planes and a data class', () => {
  test.each(listJevDecisions().map((d) => [d.name, d]))('%s', (_n, d: any) => {
    expect(d.planes.length).toBeGreaterThan(0);
    expect(['telemetry', 'business', 'member_content', 'phi']).toContain(d.data);
    expect(d.planes).not.toContain('patient');
    // Autopilot may only be declared on decisions it can actually run.
    if (d.planes.includes('system_autopilot')) expect(['telemetry', 'member_content']).toContain(d.data);
  });

  test('no decision sends phi today', () => {
    expect(listJevDecisions().filter((d) => d.data === 'phi')).toEqual([]);
  });

  test('moderation reads member content; ops/CI/findings are telemetry', () => {
    const by = Object.fromEntries(listJevDecisions().map((d) => [d.name, d.data]));
    expect(by.moderation_severity).toBe('member_content');
    expect(by.ops_error_triage).toBe('telemetry');
    expect(by.ci_failure_bucket).toBe('telemetry');
    expect(by.finding_duplicate).toBe('telemetry');
  });
});

describe('VTID-04754 plane × data policy', () => {
  const base = { decisionPlanes: ['internal', 'system_autopilot', 'member', 'partner_org'] as any, flag: JEV_DEFAULT_TENANT_FLAG, env: {} };
  test('internal may send telemetry and business', () => {
    expect(evaluateJevPolicy({ ...base, plane: 'internal', data: 'telemetry' }).allowed).toBe(true);
    expect(evaluateJevPolicy({ ...base, plane: 'internal', data: 'business' }).allowed).toBe(true);
  });
  test('phi is refused on every plane, whatever the flags say', () => {
    const flag = { enabled: true, planes: ['internal', 'member', 'patient'] as any, monthly_budget_usd: 100 };
    for (const plane of ['internal', 'member', 'patient', 'system_autopilot', 'partner_org'] as const) {
      expect(evaluateJevPolicy({ ...base, plane, data: 'phi', flag, env: MEMBER_ENV })).toEqual({ allowed: false, reason: 'phi_refused_no_dpa' });
    }
  });
  test('patient plane is off', () => {
    expect(evaluateJevPolicy({ ...base, plane: 'patient', data: 'telemetry' })).toEqual({ allowed: false, reason: 'patient_plane_off' });
  });
  test('member content needs the env flag, the tenant plane and a budget — in that order', () => {
    const p = { ...base, plane: 'internal' as const, data: 'member_content' as const };
    expect(evaluateJevPolicy(p)).toEqual({ allowed: false, reason: 'community_not_enabled' });
    expect(evaluateJevPolicy({ ...p, env: MEMBER_ENV })).toEqual({ allowed: false, reason: 'tenant_plane_off' });
    const noBudget = { enabled: true, planes: ['internal', 'member'] as any, monthly_budget_usd: null };
    expect(evaluateJevPolicy({ ...p, env: MEMBER_ENV, flag: noBudget })).toEqual({ allowed: false, reason: 'member_budget_missing' });
    const full = { ...noBudget, monthly_budget_usd: 25 };
    expect(evaluateJevPolicy({ ...p, env: MEMBER_ENV, flag: full })).toEqual({ allowed: true });
  });
  test('Community Autopilot: telemetry yes, business no, member content by member rules', () => {
    expect(evaluateJevPolicy({ ...base, plane: 'system_autopilot', data: 'telemetry' }).allowed).toBe(true);
    expect(evaluateJevPolicy({ ...base, plane: 'system_autopilot', data: 'business' })).toEqual({ allowed: false, reason: 'autopilot_data_not_permitted' });
    expect(evaluateJevPolicy({ ...base, plane: 'system_autopilot', data: 'member_content' })).toEqual({ allowed: false, reason: 'community_not_enabled' });
  });
  test('partner_org needs the tenant flag to list it', () => {
    expect(evaluateJevPolicy({ ...base, plane: 'partner_org', data: 'business' })).toEqual({ allowed: false, reason: 'tenant_plane_off' });
    const flag = { enabled: true, planes: ['internal', 'partner_org'] as any, monthly_budget_usd: null };
    expect(evaluateJevPolicy({ ...base, plane: 'partner_org', data: 'business', flag }).allowed).toBe(true);
  });
  test('a decision only runs on the planes it declares', () => {
    expect(evaluateJevPolicy({ ...base, decisionPlanes: ['internal'], plane: 'system_autopilot', data: 'telemetry' })).toEqual({
      allowed: false,
      reason: 'plane_not_permitted_for_decision',
    });
  });
  test('enabled:false switches a tenant off, internal included', () => {
    const flag = { enabled: false, planes: ['internal'] as any, monthly_budget_usd: null };
    expect(evaluateJevPolicy({ ...base, plane: 'internal', data: 'business', flag })).toEqual({ allowed: false, reason: 'tenant_jev_disabled' });
  });
});

describe('VTID-04754 tenant flag parsing', () => {
  test('absent → internal default; malformed → null (fail closed)', () => {
    expect(parseJevTenantFlag(undefined)).toEqual(JEV_DEFAULT_TENANT_FLAG);
    expect(parseJevTenantFlag(null)).toEqual(JEV_DEFAULT_TENANT_FLAG);
    expect(parseJevTenantFlag({ enabled: 'yes' })).toBeNull();
    expect(parseJevTenantFlag({ enabled: true, planes: ['everyone'] })).toBeNull();
    expect(parseJevTenantFlag({ enabled: true, planes: ['internal'], monthly_budget_usd: -1 })).toBeNull();
    expect(parseJevTenantFlag({ enabled: true, planes: ['internal', 'member'], monthly_budget_usd: 20 })).toEqual({
      enabled: true,
      planes: ['internal', 'member'],
      monthly_budget_usd: 20,
    });
  });
  test('month key is UTC first-of-month', () => {
    expect(currentMonthUtc(new Date('2026-10-31T23:30:00Z'))).toBe('2026-10-01');
  });
});

describe('VTID-04754 decide() enforces tenant control before any token is spent', () => {
  test('a decided call records spend per tenant and plane', async () => {
    const mem = createMemoryJevControl();
    const r = await decide('support_ticket_triage', { body: 'charged twice' }, staff, { source: 't', call: jest.fn().mockResolvedValue(ticket()), env: ENV, control: mem.control });
    expect(r).toMatchObject({ ok: true, outcome: 'decided' });
    expect(mem.records).toEqual([{ tenantId: 't1', plane: 'internal', inputTokens: 1_000_000, costUsd: expect.closeTo(0.042, 8) }]);
  });

  test('platform telemetry without a tenant is counted under the platform id', async () => {
    const mem = createMemoryJevControl();
    const r = await decide('ops_error_triage', { message: 'ECONNRESET' }, { actor_id: 'self-healing', system: true }, { source: 't', call: jest.fn().mockResolvedValue(opsAnswer()), env: ENV, control: mem.control });
    expect(r.ok).toBe(true);
    expect(mem.records[0]).toMatchObject({ tenantId: JEV_PLATFORM_TENANT, plane: 'internal' });
  });

  test('business data without a tenant is refused', async () => {
    const call = jest.fn();
    const r = await decide('lead_score', { lead: 'x' }, { actor_id: 'b', active_role: 'backoffice' }, { source: 't', call, env: ENV });
    expect(r).toMatchObject({ ok: false, outcome: 'denied', reason: 'tenant_required', status: 400 });
    expect(call).not.toHaveBeenCalled();
  });

  test('exafy_admin must name a target tenant for tenant data; the call is marked cross_tenant', async () => {
    const call = jest.fn().mockResolvedValue(ticket());
    const none = await decide('support_ticket_triage', { body: 'x' }, { actor_id: 'root', exafy_admin: true }, { source: 't', call, env: ENV });
    expect(none).toMatchObject({ ok: false, reason: 'target_tenant_required', status: 400 });
    const named = await decide('support_ticket_triage', { body: 'x' }, { actor_id: 'root', exafy_admin: true, tenant_id: 't2', cross_tenant: true }, { source: 't', call, env: ENV });
    expect(named.ok).toBe(true);
    await new Promise((s) => setImmediate(s));
    expect(emitted[0].payload).toMatchObject({ actor_id: 'root', tenant_id: 't2', cross_tenant: true, role: 'exafy_admin', data: 'business' });
    expect(emitted[0].message).toContain('cross_tenant tenant=t2');
  });

  test('a tenant switched off is refused; an exhausted budget falls back with 429 and an event', async () => {
    const call = jest.fn().mockResolvedValue(ticket());
    const off = createMemoryJevControl({ t1: { enabled: false, planes: [] } });
    expect(await decide('support_ticket_triage', { body: 'x' }, staff, { source: 't', call, env: ENV, control: off.control })).toMatchObject({
      outcome: 'denied',
      reason: 'tenant_jev_disabled',
    });
    const spent = createMemoryJevControl({ t1: { enabled: true, planes: ['internal'], monthly_budget_usd: 5 } }, { t1: 5 });
    const r = await decide('support_ticket_triage', { body: 'x' }, staff, { source: 't', call, env: ENV, control: spent.control });
    expect(r).toMatchObject({ ok: false, outcome: 'fallback', reason: 'tenant_budget_exhausted', status: 429 });
    expect(call).not.toHaveBeenCalled();
    await new Promise((s) => setImmediate(s));
    expect(emitted.at(-1)).toMatchObject({ type: 'jev.decision.fallback' });
  });

  test('an unreadable tenant flag or spend fails closed', async () => {
    const call = jest.fn();
    const broken = { getTenantFlag: async () => null, getMonthSpend: async () => 0, recordSpend: async () => undefined };
    expect(await decide('support_ticket_triage', { body: 'x' }, staff, { source: 't', call, env: ENV, control: broken })).toMatchObject({
      outcome: 'fallback',
      reason: 'tenant_config_unavailable',
    });
    const noSpend = {
      getTenantFlag: async () => ({ enabled: true, planes: ['internal'] as any, monthly_budget_usd: 10 }),
      getMonthSpend: async () => null,
      recordSpend: async () => undefined,
    };
    expect(await decide('support_ticket_triage', { body: 'x' }, staff, { source: 't', call, env: ENV, control: noSpend })).toMatchObject({
      outcome: 'fallback',
      reason: 'budget_check_failed',
    });
    expect(call).not.toHaveBeenCalled();
  });

  test('moderation (member content) stays off for internal callers until the member plane is opened', async () => {
    const call = jest.fn();
    const r = await decide('moderation_severity', { content: 'spam spam' }, { actor_id: 'a', active_role: 'admin', tenant_id: 't1' }, { source: 't', call, env: ENV });
    expect(r).toMatchObject({ outcome: 'denied', reason: 'community_not_enabled' });
    expect(call).not.toHaveBeenCalled();
  });

  test('Community Autopilot may run telemetry decisions only', async () => {
    const autopilot = { actor_id: 'community-autopilot', system: true, system_plane: 'system_autopilot' as const, tenant_id: 't1' };
    const ops = await decide('ops_error_triage', { message: 'x' }, autopilot, { source: 't', call: jest.fn().mockResolvedValue(opsAnswer()), env: ENV });
    expect(ops).toMatchObject({ ok: true, plane: 'system_autopilot' });
    const lead = await decide('lead_score', { lead: 'x' }, autopilot, { source: 't', call: jest.fn(), env: ENV });
    expect(lead).toMatchObject({ outcome: 'denied', reason: 'plane_not_permitted_for_decision' });
  });
});

describe('VTID-04754 resolveJevCaller', () => {
  const req = (identity: any, extra: any = {}) => ({ identity, headers: {}, query: {}, body: {}, ...extra }) as any;
  const user = (over: any = {}) => ({ user_id: 'u1', tenant_id: 't1', exafy_admin: false, ...over });
  const sb = {} as any;

  test('permitted set mirrors get_my_permitted_roles: grants ∪ memberships ∪ community, switcher order', () => {
    expect(computePermittedRoles([{ role: 'developer' }, { role: 'bogus' }], [{ role: 'staff' }])).toEqual(['community', 'staff', 'developer']);
  });

  test('role_preferences wins over user_tenants.active_role (pickEffectiveRole)', async () => {
    Object.assign(repoState, { pref: 'developer', active: 'staff', grants: ['developer', 'staff'] });
    expect(await resolveJevCaller(req(user()), sb)).toMatchObject({ tenant_id: 't1', active_role: 'developer' });
  });

  test('falls back to user_tenants.active_role', async () => {
    Object.assign(repoState, { active: 'staff', grants: ['staff'] });
    expect(await resolveJevCaller(req(user()), sb)).toMatchObject({ active_role: 'staff' });
  });

  test('a role that is not permitted in the tenant is refused', async () => {
    Object.assign(repoState, { pref: 'admin', grants: [] });
    await expect(resolveJevCaller(req(user()), sb)).rejects.toMatchObject({ status: 403, reason: 'effective_role_not_permitted' });
  });

  test('acting role is accepted only when permitted', async () => {
    Object.assign(repoState, { active: 'staff', grants: ['staff', 'backoffice'] });
    expect(await resolveJevCaller(req(user(), { headers: { 'x-jev-acting-role': 'backoffice' } }), sb)).toMatchObject({ active_role: 'backoffice' });
    await expect(resolveJevCaller(req(user(), { body: { acting_role: 'infra' } }), sb)).rejects.toBeInstanceOf(JevCallerError);
  });

  test('no tenant in the JWT → user_tenants primary tenant (requireTenant fallback)', async () => {
    Object.assign(repoState, { primary: 't9', active: 'staff', grants: ['staff'] });
    expect(await resolveJevCaller(req(user({ tenant_id: null })), sb)).toMatchObject({ tenant_id: 't9', active_role: 'staff' });
  });

  test('a Cognito token is reported as an identity gap, not papered over', async () => {
    Object.assign(repoState, { primary: 't9', active: 'staff', grants: ['staff'] });
    const c = await resolveJevCaller(req(user({ tenant_id: null }), { auth_source: 'cognito' }), sb);
    expect(c.identity_gaps).toEqual(['cognito_exafy_admin_unresolved']);
  });

  test('permitted-role read failure fails closed (no role)', async () => {
    Object.assign(repoState, { active: 'staff', grantsError: true });
    const c = await resolveJevCaller(req(user()), sb);
    expect(c.active_role).toBeUndefined();
    expect(c.identity_gaps).toContain('permitted_roles_unavailable');
  });

  test('a normal user cannot name another tenant', async () => {
    Object.assign(repoState, { active: 'staff', grants: ['staff'] });
    await expect(resolveJevCaller(req(user(), { headers: { 'x-jev-tenant': 't2' } }), sb)).rejects.toMatchObject({ reason: 'cross_tenant_not_permitted' });
  });

  test('exafy_admin: no tenant unless named; a named tenant (slug) is resolved and marked cross_tenant', async () => {
    repoState.tenants = { maxina: 'tm' };
    expect(await resolveJevCaller(req(user({ exafy_admin: true })), sb)).toMatchObject({ exafy_admin: true, tenant_id: null });
    expect(await resolveJevCaller(req(user({ exafy_admin: true }), { query: { tenant_id: 'maxina' } }), sb)).toMatchObject({ tenant_id: 'tm', cross_tenant: true });
    await expect(resolveJevCaller(req(user({ exafy_admin: true }), { headers: { 'x-jev-tenant': 'nope' } }), sb)).rejects.toMatchObject({ status: 404, reason: 'unknown_tenant' });
  });
});

describe('VTID-04754 shadow framework', () => {
  test('mode env var name and exact values; anything else is off', () => {
    expect(jevGateEnvName('agent-progress')).toBe('JEV_AGENT_PROGRESS_MODE');
    expect(jevGateMode('agent_progress', { JEV_AGENT_PROGRESS_MODE: 'shadow' })).toBe('shadow');
    expect(jevGateMode('agent_progress', { JEV_AGENT_PROGRESS_MODE: 'enforce' })).toBe('enforce');
    expect(jevGateMode('agent_progress', { JEV_AGENT_PROGRESS_MODE: 'Enforce' })).toBe('off');
    expect(jevGateMode('agent_progress', { JEV_AGENT_PROGRESS_MODE: 'true' })).toBe('off');
    expect(jevGateMode('agent_progress', {})).toBe('off');
  });

  const args = (env: NodeJS.ProcessEnv, call: jest.Mock) => ({
    gate: 'ops_triage',
    decision: 'ops_error_triage',
    input: { message: 'x' },
    caller: { actor_id: 'self-healing', system: true },
    subject: { type: 'incident', ref: 'inc-1' },
    systemAction: 'retry',
    source: 'test',
    env,
    decideOptions: { call },
    sb: {} as any,
  });

  test('off: no call, no row', async () => {
    const call = jest.fn();
    expect(await runJevGate(args(ENV, call))).toEqual({ gate: 'ops_triage', mode: 'off', enforce: false });
    expect(call).not.toHaveBeenCalled();
    expect(repoState.shadow).toHaveLength(0);
  });

  test('shadow: Jev asked, row recorded next to the system action, never enforced', async () => {
    const call = jest.fn().mockResolvedValue(opsAnswer());
    const r = await runJevGate(args({ ...ENV, JEV_OPS_TRIAGE_MODE: 'shadow' }, call));
    expect(r).toMatchObject({ mode: 'shadow', enforce: false, shadow_id: 's1' });
    expect(repoState.shadow[0]).toMatchObject({
      gate: 'ops_triage',
      decision: 'ops_error_triage',
      mode: 'shadow',
      plane: 'internal',
      subject_type: 'incident',
      subject_ref: 'inc-1',
      jev_outcome: 'decided',
      system_action: 'retry',
    });
  });

  test('enforce: enforce=true only on a confident decision', async () => {
    const env = { ...ENV, JEV_OPS_TRIAGE_MODE: 'enforce' };
    expect((await runJevGate(args(env, jest.fn().mockResolvedValue(opsAnswer())))).enforce).toBe(true);
    const failing = jest.fn().mockResolvedValue({ ok: false, reason: 'http_error', status: 500, error: 'x', latency_ms: 1, attempts: 1 });
    const r = await runJevGate(args(env, failing));
    expect(r.enforce).toBe(false);
    expect(repoState.shadow.at(-1)).toMatchObject({ jev_outcome: 'fallback', mode: 'enforce' });
  });
});
