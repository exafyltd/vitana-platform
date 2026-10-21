/**
 * VTID-04400 — the business ORB's commerce onboarding specialist, the third
 * `delegate_to_agent` target (docs/ORCHESTRATOR-REDESIGN-PLAN.md §5 P3).
 *
 * AC-1 Off by default: without ORCHESTRATOR_COMMERCE_SPECIALIST_ENABLED='true'
 *      nothing registers, nothing is declared, the commerce catalog is the
 *      navigation-only set it was.
 * AC-2 On: the commerce catalog declares ask_commerce_specialist and the two
 *      async companions once each; member, command-hub and anonymous
 *      catalogs do not get it; the budget priority list names it.
 * AC-3 Commerce authority comes from organization membership: the org roles
 *      partner_organization_members really stores (org_admin/staff/
 *      professional) now resolve to a ceiling, and the dispatcher passes the
 *      caller's memberships to the policy — none → refused.
 * AC-4 Reads are the caller's own: every tool is pinned to the caller's
 *      memberships, an organization is picked only among them, pending
 *      invites are shown to an org_admin only; the run is on the triage
 *      stage and returns bounded findings, never a script.
 * AC-5 Through the tool: a member of an organization on the commerce route
 *      gets the findings; a caller with no membership is refused; orb-live
 *      dispatches the tool name.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  buildCommerceExecutor,
  COMMERCE_SPECIALIST_ENABLED_ENV,
  COMMERCE_SPECIALIST_SERVICE,
  COMMERCE_SPECIALIST_STAGE,
  COMMERCE_TARGET,
  COMMERCE_TOOLS,
  isCommerceSpecialistEnabled,
  membershipsToOrgContext,
  pickMembership,
  runCommerceSpecialist,
  type CommerceDeps,
  type CommerceMembership,
} from '../../../src/services/orchestrator/commerce-specialist';
import {
  clearDelegationTargets,
  delegateToAgent,
  listDelegationTargets,
  registerDelegationTarget,
  resetDelegationJobs,
  type DelegationCaller,
} from '../../../src/services/orchestrator/dispatcher';
import { registerDefaultDelegationTargets, resetDefaultRegistration } from '../../../src/services/orchestrator/delegation-targets';
import { evaluatePolicy, roleCeiling } from '../../../src/services/orchestrator/policy';
import { commerceDelegationTools, runAskCommerceSpecialist } from '../../../src/orb/live/tools/delegation-tools';
import { buildLiveApiTools } from '../../../src/orb/live/tools/live-tool-catalog';
import { FLAG_GATED_PRIORITY_TOOLS } from '../../../src/orb/live/tools/vertex-tool-catalog-budget';
import type { StageToolLoopResult } from '../../../src/services/llm-stage-tool-loop';

const names = (tools: object[]): string[] =>
  (tools as Array<{ function_declarations?: Array<{ name: string }> }>).flatMap((g) =>
    Array.isArray(g.function_declarations) ? g.function_declarations.map((d) => d.name) : []);

const COMMERCE_NAMES = ['ask_commerce_specialist', 'get_delegation_result', 'cancel_delegation'];

const ACME: CommerceMembership = {
  org_id: 'o-1', org_key: 'acme-lab', display_name: 'Acme Lab', org_type: 'lab_partner',
  status: 'pending_review', commerce_vertical: 'health', role: 'org_admin', created_at: '2026-09-20T10:00:00Z',
};
const SHOP: CommerceMembership = {
  org_id: 'o-2', org_key: 'green-shop', display_name: 'Green Shop', org_type: 'commerce',
  status: 'active', commerce_vertical: 'general', role: 'staff', created_at: '2026-09-01T10:00:00Z',
};

const bizCaller: DelegationCaller = {
  user_id: 'u-1', tenant_id: 't', platform_role: 'community', exafy_admin: false,
  surface: 'commerce', channel: 'voice', session_id: 's1',
  orgs: membershipsToOrgContext([ACME]),
};

function loopResult(o: Partial<StageToolLoopResult>): StageToolLoopResult {
  return {
    ok: true, text: 'findings', fallbackUsed: false, usage: { inputTokens: 0, outputTokens: 0 },
    turns: 1, toolCalls: 0, toolNames: [], history: [], steps: [], budgetExhausted: false, ...o,
  };
}

function deps(rows: CommerceMembership[], over: Partial<CommerceDeps> = {}): CommerceDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    listMemberships: async (uid) => { calls.push(`list:${uid}`); return rows; },
    getOrgDetail: async (m) => {
      calls.push(`detail:${m.org_id}`);
      return { member_count: 3, pending_invites: m.role === 'org_admin' ? 2 : null, orders_connected: m.commerce_vertical === 'health' ? false : null };
    },
    searchKnowledge: async (q) => { calls.push(`kb:${q}`); return [{ title: 'Partner review', snippet: 'The Vitana team reviews new organizations.', source: 'kb/partners.md' }]; },
    runLoop: jest.fn(async () => loopResult({})),
    ...over,
  };
}

const saved = process.env[COMMERCE_SPECIALIST_ENABLED_ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[COMMERCE_SPECIALIST_ENABLED_ENV];
  else process.env[COMMERCE_SPECIALIST_ENABLED_ENV] = saved;
  resetDelegationJobs();
  clearDelegationTargets();
  resetDefaultRegistration();
});

describe('AC-1 off by default', () => {
  test('only the exact string true enables it', () => {
    expect(isCommerceSpecialistEnabled({})).toBe(false);
    expect(isCommerceSpecialistEnabled({ [COMMERCE_SPECIALIST_ENABLED_ENV]: 'TRUE' })).toBe(false);
    expect(isCommerceSpecialistEnabled({ [COMMERCE_SPECIALIST_ENABLED_ENV]: 'true' })).toBe(true);
  });

  test('off: no target, no tools, commerce catalog unchanged, the tool refuses', async () => {
    delete process.env[COMMERCE_SPECIALIST_ENABLED_ENV];
    registerDefaultDelegationTargets();
    expect(listDelegationTargets('commerce')).toEqual([]);
    expect(commerceDelegationTools({})).toEqual([]);
    const cat = names(buildLiveApiTools('authenticated', '/commerce', 'community', 'commerce'));
    for (const n of COMMERCE_NAMES) expect(cat).not.toContain(n);
    const r = await runAskCommerceSpecialist({ sessionId: 's1', current_route: '/commerce', identity: { user_id: 'u-1' } }, { question: 'Is my lab approved?' }, async () => [ACME]);
    expect(r).toMatchObject({ success: false, error: expect.stringMatching(/not enabled/) });
  });
});

describe('AC-2 catalog when on', () => {
  beforeEach(() => { process.env[COMMERCE_SPECIALIST_ENABLED_ENV] = 'true'; });

  test('commerce catalog declares the three tools exactly once, beside navigation', () => {
    const off = (() => { delete process.env[COMMERCE_SPECIALIST_ENABLED_ENV]; const c = names(buildLiveApiTools('authenticated', '/commerce', 'community', 'commerce')); process.env[COMMERCE_SPECIALIST_ENABLED_ENV] = 'true'; return c; })();
    const cat = names(buildLiveApiTools('authenticated', '/commerce', 'community', 'commerce'));
    for (const n of COMMERCE_NAMES) expect(cat.filter((x) => x === n)).toHaveLength(1);
    expect(cat.filter((n) => !COMMERCE_NAMES.includes(n)).sort()).toEqual([...off].sort());
  });

  test('member, command-hub and anonymous catalogs do not get the commerce specialist', () => {
    expect(names(buildLiveApiTools('authenticated', '/community', 'community'))).not.toContain('ask_commerce_specialist');
    expect(names(buildLiveApiTools('authenticated', '/command-hub/operator', 'developer'))).not.toContain('ask_commerce_specialist');
    expect(names(buildLiveApiTools('anonymous', '/commerce', undefined, 'commerce'))).not.toContain('ask_commerce_specialist');
  });

  test('the budget priority list ranks it with the other flag-gated tools', () => {
    expect(FLAG_GATED_PRIORITY_TOOLS).toContain('ask_commerce_specialist');
  });
});

describe('AC-3 commerce authority from membership', () => {
  test('stored org roles resolve to a ceiling; no membership is none', () => {
    const org = (org_role: string) => ({ platform_role: 'community', orgs: [{ org_id: 'o', org_key: null, org_role, commerce_vertical: null }] });
    expect(roleCeiling(org('org_admin'), 'commerce')).toBe('commit');
    expect(roleCeiling(org('staff'), 'commerce')).toBe('draft');
    expect(roleCeiling(org('professional'), 'commerce')).toBe('draft');
    expect(roleCeiling({ platform_role: 'admin', orgs: [] }, 'commerce')).toBe('none');
    expect(evaluatePolicy({ platform_role: 'community', orgs: [], channel: 'voice' }, 'commerce', 'read').decision).toBe('deny');
  });

  test('the dispatcher passes the caller memberships to the policy', async () => {
    registerDelegationTarget({ ...COMMERCE_TARGET, run: async () => ({ ok: true, result: { findings: 'ok' } }) });
    const withOrg = await delegateToAgent('commerce', 'status?', bizCaller);
    expect(withOrg).toMatchObject({ status: 'done', result: { findings: 'ok' } });
    const noOrg = await delegateToAgent('commerce', 'status?', { ...bizCaller, orgs: undefined });
    expect(noOrg.status).toBe('refused');
  });

  test('target is commerce/read on the commerce surface only', () => {
    expect(COMMERCE_TARGET).toMatchObject({ agent_id: 'commerce', domain: 'commerce', tier: 'read', surfaces: ['commerce'] });
  });
});

describe('AC-4 reads are the caller’s own', () => {
  test('pickMembership resolves only among the caller’s memberships', () => {
    expect(pickMembership([ACME], undefined).membership).toBe(ACME);
    expect(pickMembership([ACME, SHOP], '').membership).toBeNull();
    expect(pickMembership([ACME, SHOP], 'green shop').membership).toBe(SHOP);
    expect(pickMembership([ACME, SHOP], 'acme').membership).toBe(ACME);
    expect(pickMembership([ACME, SHOP], 'Other Corp').error).toMatch(/No organization of this user matches/);
    expect(pickMembership([], 'x').error).toMatch(/no business organization/);
  });

  test('every read is pinned to the caller; invites only for an org_admin', async () => {
    const d = deps([ACME, SHOP]);
    const exec = buildCommerceExecutor('u-1', d);
    const list = await exec('list_my_organizations', {});
    expect(list.result).toContain('Acme Lab | lab_partner | pending_review | vertical health | role org_admin');
    const admin = await exec('get_organization_status', { organization: 'Acme Lab' });
    expect(admin.result).toContain('pending invites: 2');
    expect(admin.result).toContain('connected to receive health orders: no');
    const staff = await exec('get_organization_status', { organization: 'green-shop' });
    expect(staff.result).not.toContain('pending invites');
    expect(staff.result).not.toContain('health orders');
    expect(d.calls.filter((c) => c.startsWith('list:'))).toEqual(['list:u-1']);
    const foreign = await exec('get_organization_status', { organization: 'Someone Else Ltd' });
    expect(foreign.result).toMatch(/No organization of this user matches/);
    expect(d.calls).not.toContain('detail:o-3');
  });

  test('errors and cancellation come back as tool errors, never throws', async () => {
    const exec = buildCommerceExecutor('u-1', deps([], { listMemberships: async () => { throw new Error('db down'); } }));
    expect(await exec('list_my_organizations', {})).toMatchObject({ isError: true, result: expect.stringMatching(/db down/) });
    expect(await exec('drop_table', {})).toMatchObject({ isError: true });
    const ctl = new AbortController(); ctl.abort();
    expect(await buildCommerceExecutor('u-1', deps([ACME]), ctl.signal)('list_my_organizations', {})).toMatchObject({ isError: true, result: 'cancelled' });
  });

  test('the run uses the triage stage and three read tools and bounds the findings', async () => {
    const d = deps([ACME], { runLoop: jest.fn(async () => loopResult({ text: 'x'.repeat(5000), toolNames: ['get_organization_status'] })) });
    const out = await runCommerceSpecialist('Is my lab approved?', bizCaller, new AbortController().signal, d);
    const opts = (d.runLoop as jest.Mock).mock.calls[0][0];
    expect(opts).toMatchObject({ stage: COMMERCE_SPECIALIST_STAGE, service: COMMERCE_SPECIALIST_SERVICE });
    expect(opts.tools.map((t: { name: string }) => t.name)).toEqual(COMMERCE_TOOLS.map((t) => t.name));
    expect(out.ok).toBe(true);
    expect((out.result as { findings: string }).findings.length).toBeLessThanOrEqual(1501);
    const failed = await runCommerceSpecialist('q', bizCaller, new AbortController().signal, deps([ACME], { runLoop: jest.fn(async () => loopResult({ ok: false, text: '', error: 'both providers refused' })) }));
    expect(failed).toMatchObject({ ok: false, error: 'both providers refused' });
  });
});

describe('AC-5 through the tool', () => {
  const session = { sessionId: 's1', current_route: '/commerce/team', identity: { user_id: 'u-1' }, active_role: 'community' };

  test('a member of an organization gets the findings', async () => {
    process.env[COMMERCE_SPECIALIST_ENABLED_ENV] = 'true';
    registerDefaultDelegationTargets();
    registerDelegationTarget({ ...COMMERCE_TARGET, run: async (_q, caller) => ({ ok: true, result: { findings: `orgs=${caller.orgs?.length}` } }) });
    const r = await runAskCommerceSpecialist(session, { question: 'Is Acme Lab approved yet?' }, async () => [ACME]);
    expect(r.success).toBe(true);
    expect(JSON.parse(r.result)).toEqual({ findings: 'orgs=1' });
  });

  test('a caller with no organization is refused by policy; a load failure surfaces', async () => {
    process.env[COMMERCE_SPECIALIST_ENABLED_ENV] = 'true';
    registerDefaultDelegationTargets();
    const none = await runAskCommerceSpecialist(session, { question: 'status?' }, async () => []);
    expect(none.success).toBe(false);
    const broken = await runAskCommerceSpecialist(session, { question: 'status?' }, async () => { throw new Error('db down'); });
    expect(broken).toMatchObject({ success: false, error: expect.stringMatching(/db down/) });
  });

  test('orb-live dispatches ask_commerce_specialist to the delegation module', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/routes/orb-live.ts'), 'utf8');
    const i = src.indexOf("case 'ask_commerce_specialist'");
    expect(i).toBeGreaterThan(0);
    expect(src.slice(i, i + 300)).toContain('runAskCommerceSpecialist(session');
  });
});
