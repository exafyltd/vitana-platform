/**
 * VTID-04397 — the member ORB's support specialist, the second
 * `delegate_to_agent` target (docs/ORCHESTRATOR-REDESIGN-PLAN.md §5 P3).
 *
 * AC-1 Off by default: without ORCHESTRATOR_SUPPORT_SPECIALIST_ENABLED='true'
 *      nothing registers, nothing is declared, the member catalog is unchanged.
 * AC-2 On: the member (vitanaland) catalog declares ask_support_specialist and
 *      the two async companions once each; anonymous, command-hub and commerce
 *      catalogs do not get it; the Nova budget keeps them and every existing
 *      priority tool.
 * AC-3 Every read is pinned to the caller's own user id; the draft answer and
 *      the dev spec are never selected; a spoken ticket number normalises to
 *      the stored FB-YYYY-MM-NNNNNN shape.
 * AC-4 The specialist runs on the triage stage with its three read tools and
 *      returns findings (bounded), never a spoken script; failures surface.
 * AC-5 Through the dispatcher: a community member on voice gets the findings
 *      (or `working` + job id); a signed-out caller and the command-hub
 *      surface are refused; orb-live dispatches the tool name.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  buildSupportExecutor,
  isSupportSpecialistEnabled,
  normalizeTicketNumber,
  runSupportSpecialist,
  SUPPORT_SPECIALIST_ENABLED_ENV,
  SUPPORT_SPECIALIST_SERVICE,
  SUPPORT_SPECIALIST_STAGE,
  SUPPORT_TARGET,
  SUPPORT_TOOLS,
  type SupportDeps,
} from '../../../src/services/orchestrator/support-specialist';
import {
  clearDelegationTargets,
  delegateToAgent,
  listDelegationTargets,
  registerDelegationTarget,
  resetDelegationJobs,
  type DelegationCaller,
} from '../../../src/services/orchestrator/dispatcher';
import { registerDefaultDelegationTargets, resetDefaultRegistration } from '../../../src/services/orchestrator/delegation-targets';
import { memberDelegationTools, runAskSupportSpecialist, runGetDelegationResult } from '../../../src/orb/live/tools/delegation-tools';
import { buildLiveApiTools } from '../../../src/orb/live/tools/live-tool-catalog';
import {
  enforceToolCatalogBudget,
  FLAG_GATED_PRIORITY_TOOLS,
  NOVA_TOOL_CATALOG_BYTE_BUDGET_DEFAULT,
  VERTEX_BRIDGE_PRIORITY_TOOLS,
} from '../../../src/orb/live/tools/vertex-tool-catalog-budget';
import type { StageToolLoopResult } from '../../../src/services/llm-stage-tool-loop';

const names = (tools: object[]): string[] =>
  (tools as Array<{ function_declarations?: Array<{ name: string }> }>).flatMap((g) =>
    Array.isArray(g.function_declarations) ? g.function_declarations.map((d) => d.name) : []);

const ON = { [SUPPORT_SPECIALIST_ENABLED_ENV]: 'true' };
const SUPPORT_NAMES = ['ask_support_specialist', 'get_delegation_result', 'cancel_delegation'];

const member: DelegationCaller = {
  user_id: 'u-1', tenant_id: 't', platform_role: 'community', exafy_admin: false,
  surface: 'vitanaland', channel: 'voice', session_id: 's1',
};

function loopResult(o: Partial<StageToolLoopResult>): StageToolLoopResult {
  return {
    ok: true, text: 'findings', fallbackUsed: false, usage: { inputTokens: 0, outputTokens: 0 },
    turns: 1, toolCalls: 0, toolNames: [], history: [], steps: [], budgetExhausted: false, ...o,
  };
}

function deps(over: Partial<SupportDeps> = {}): SupportDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    listOpenTickets: async (uid) => { calls.push(`list:${uid}`); return [{ ticket_number: 'FB-2026-07-000137', kind: 'bug', status: 'in_progress', created_at: '2026-07-02T10:00:00Z' }]; },
    getOwnTicket: async (uid, n) => { calls.push(`get:${uid}:${n}`); return n === 'FB-2026-07-000137' ? { ticket_number: n, kind: 'bug', status: 'resolved', created_at: '2026-07-02T10:00:00Z', resolved_at: '2026-07-05T10:00:00Z', resolution_md: 'Fixed in the diary save flow.', linked_vtid: 'VTID-04100' } : null; },
    searchKnowledge: async (q) => { calls.push(`kb:${q}`); return [{ title: 'Changing your email', snippet: 'Settings > Account > Email.', source: 'kb/account.md' }]; },
    runLoop: jest.fn(async () => loopResult({})),
    ...over,
  };
}

const saved = process.env[SUPPORT_SPECIALIST_ENABLED_ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[SUPPORT_SPECIALIST_ENABLED_ENV];
  else process.env[SUPPORT_SPECIALIST_ENABLED_ENV] = saved;
  resetDelegationJobs();
  clearDelegationTargets();
  resetDefaultRegistration();
});

describe('AC-1 off by default', () => {
  test('only the exact string true enables it', () => {
    expect(isSupportSpecialistEnabled({})).toBe(false);
    expect(isSupportSpecialistEnabled({ [SUPPORT_SPECIALIST_ENABLED_ENV]: 'TRUE' })).toBe(false);
    expect(isSupportSpecialistEnabled({ [SUPPORT_SPECIALIST_ENABLED_ENV]: '1' })).toBe(false);
    expect(isSupportSpecialistEnabled(ON)).toBe(true);
  });

  test('off: no target registered, no tools declared, member catalog unchanged', async () => {
    delete process.env[SUPPORT_SPECIALIST_ENABLED_ENV];
    registerDefaultDelegationTargets();
    expect(listDelegationTargets().map((t) => t.agent_id)).toEqual(['operator']);
    expect(memberDelegationTools({})).toEqual([]);
    const cat = names(buildLiveApiTools('authenticated', '/community', 'community'));
    for (const n of SUPPORT_NAMES) expect(cat).not.toContain(n);
    const r = await runAskSupportSpecialist({ sessionId: 's1', current_route: '/community', identity: { user_id: 'u-1' }, active_role: 'community' }, { question: 'where is my ticket?' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not enabled/);
  });
});

describe('AC-2 catalog when on', () => {
  beforeEach(() => { process.env[SUPPORT_SPECIALIST_ENABLED_ENV] = 'true'; });

  test('member catalog declares the three tools exactly once', () => {
    const cat = names(buildLiveApiTools('authenticated', '/community', 'community'));
    for (const n of SUPPORT_NAMES) expect(cat.filter((x) => x === n)).toHaveLength(1);
  });

  test('anonymous, command-hub and commerce catalogs do not get the support specialist', () => {
    expect(names(buildLiveApiTools('anonymous', '/maxina'))).not.toContain('ask_support_specialist');
    expect(names(buildLiveApiTools('authenticated', '/command-hub/operator', 'developer'))).not.toContain('ask_support_specialist');
    expect(names(buildLiveApiTools('authenticated', '/commerce', 'community', 'commerce'))).not.toContain('ask_support_specialist');
  });

  test('the Nova budget keeps the support tools and every existing priority tool', () => {
    const tools = buildLiveApiTools('authenticated', '/community', 'community');
    const before = names(tools);
    const r = enforceToolCatalogBudget(tools, NOVA_TOOL_CATALOG_BYTE_BUDGET_DEFAULT);
    const kept = names(r.tools);
    for (const n of [...VERTEX_BRIDGE_PRIORITY_TOOLS, ...FLAG_GATED_PRIORITY_TOOLS]) {
      if (before.includes(n)) expect(kept).toContain(n);
    }
    for (const n of SUPPORT_NAMES) expect(kept).toContain(n);
  });
});

describe('AC-3 reads are the caller’s own', () => {
  test('ticket numbers normalise to the stored shape', () => {
    expect(normalizeTicketNumber('fb 2026 07 137')).toBe('FB-2026-07-000137');
    expect(normalizeTicketNumber('FB-2026-07-000137')).toBe('FB-2026-07-000137');
    expect(normalizeTicketNumber('fb202607137')).toBe('FB-2026-07-000137');
    expect(normalizeTicketNumber('137')).toBe('137');
    expect(normalizeTicketNumber('#000137')).toBe('137');
  });

  test('every tool call is pinned to the caller user id', async () => {
    const d = deps();
    const exec = buildSupportExecutor('u-1', d);
    const list = await exec('list_my_tickets', {});
    expect(list.result).toContain('FB-2026-07-000137 | bug | in_progress');
    const one = await exec('get_my_ticket', { ticket_number: 'fb 2026 07 137' });
    expect(one.result).toContain('resolution: Fixed in the diary save flow.');
    expect(one.result).toContain('VTID-04100');
    const miss = await exec('get_my_ticket', { ticket_number: 'FB-2026-01-000001' });
    expect(miss.result).toMatch(/No ticket .* belongs to this member/);
    await exec('search_knowledge', { query: 'change email' });
    expect(d.calls).toEqual(['list:u-1', 'get:u-1:FB-2026-07-000137', 'get:u-1:FB-2026-01-000001', 'kb:change email']);
  });

  test('bad input, unknown tools, failures and cancellation never throw', async () => {
    const ctl = new AbortController();
    const exec = buildSupportExecutor('u-1', deps({ searchKnowledge: async () => { throw new Error('kb down'); } }), ctl.signal);
    expect((await exec('get_my_ticket', {})).isError).toBe(true);
    expect((await exec('search_knowledge', { query: '' })).isError).toBe(true);
    expect((await exec('search_knowledge', { query: 'x' })).result).toContain('kb down');
    expect((await exec('send_chat_message', {})).result).toMatch(/unknown tool/);
    ctl.abort();
    expect(await exec('list_my_tickets', {})).toEqual({ result: 'cancelled', isError: true });
  });

  test('the repository lookup filters by user_id and never selects the draft answer or spec', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/services/orb-tools/feedback-settings-tools-repository.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export async function fetchOwnFeedbackTicketByNumber'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain(".eq('user_id', userId)");
    expect(body).not.toMatch(/draft_answer_md|spec_md|raw_transcript|supervisor_notes/);
  });
});

describe('AC-4 the specialist run', () => {
  test('runs on the triage stage with its three read tools and returns bounded findings', async () => {
    const d = deps({ runLoop: jest.fn(async () => loopResult({ text: 'x'.repeat(5000), toolNames: ['list_my_tickets'] })) });
    const out = await runSupportSpecialist('Is my diary bug fixed?', member, new AbortController().signal, d);
    expect(out.ok).toBe(true);
    const r = out.result as { findings: string; tools_used: string[]; note: string };
    expect(r.findings.length).toBeLessThanOrEqual(1501);
    expect(r.tools_used).toEqual(['list_my_tickets']);
    expect(r.note).toMatch(/not a script/);
    const opts = (d.runLoop as jest.Mock).mock.calls[0][0];
    expect(opts.stage).toBe(SUPPORT_SPECIALIST_STAGE);
    expect(opts.stage).toBe('triage');
    expect(opts.service).toBe(SUPPORT_SPECIALIST_SERVICE);
    expect(opts.tools.map((t: { name: string }) => t.name)).toEqual(SUPPORT_TOOLS.map((t) => t.name));
    expect(opts.systemPrompt).toMatch(/FINDINGS for Vitana — not a message to the member/);
  });

  test('a loop failure or an empty answer is a failed job; a signed-out caller never runs', async () => {
    const d = deps({ runLoop: jest.fn(async () => loopResult({ ok: false, text: undefined, error: 'bedrock refused' })) });
    expect(await runSupportSpecialist('q', member, new AbortController().signal, d)).toEqual({ ok: false, result: null, error: 'bedrock refused' });
    const d2 = deps();
    const out = await runSupportSpecialist('q', { ...member, user_id: null }, new AbortController().signal, d2);
    expect(out.ok).toBe(false);
    expect(d2.runLoop).not.toHaveBeenCalled();
  });
});

describe('AC-5 through the dispatcher', () => {
  const stubbed = (run: typeof SUPPORT_TARGET.run) => registerDelegationTarget({ ...SUPPORT_TARGET, run });

  test('target is community/read on the member surface only', () => {
    expect(SUPPORT_TARGET).toMatchObject({ agent_id: 'support', domain: 'community', tier: 'read', surfaces: ['vitanaland'] });
  });

  test('on: registers next to the operator', () => {
    process.env[SUPPORT_SPECIALIST_ENABLED_ENV] = 'true';
    registerDefaultDelegationTargets();
    expect(listDelegationTargets('vitanaland').map((t) => t.agent_id)).toEqual(['support']);
    expect(listDelegationTargets('command-hub').map((t) => t.agent_id)).toEqual(['operator']);
  });

  test('a community member on voice gets the findings inside the ack window', async () => {
    process.env[SUPPORT_SPECIALIST_ENABLED_ENV] = 'true';
    registerDefaultDelegationTargets();
    stubbed(async () => ({ ok: true, result: { findings: 'FB-2026-07-000137 is resolved.' } }));
    const r = await runAskSupportSpecialist({ sessionId: 's1', current_route: '/community', identity: { user_id: 'u-1' }, active_role: 'community' }, { question: 'Is my ticket fixed?' });
    expect(r.success).toBe(true);
    expect(JSON.parse(r.result)).toEqual({ findings: 'FB-2026-07-000137 is resolved.' });
  });

  test('a slow lookup acks with working + job id, and the result is fetchable later', async () => {
    process.env[SUPPORT_SPECIALIST_ENABLED_ENV] = 'true';
    registerDefaultDelegationTargets();
    let release: (v: unknown) => void = () => undefined;
    stubbed(() => new Promise((res) => { release = res as (v: unknown) => void; }));
    const session = { sessionId: 's1', current_route: '/community', identity: { user_id: 'u-1' }, active_role: 'community' };
    jest.useFakeTimers();
    try {
      const pending = runAskSupportSpecialist(session, { question: 'Where is my report?' });
      await jest.advanceTimersByTimeAsync(1_600);
      const r = await pending;
      const body = JSON.parse(r.result);
      expect(body.status).toBe('working');
      release({ ok: true, result: { findings: 'still open' } });
      await jest.advanceTimersByTimeAsync(1);
      const later = JSON.parse(runGetDelegationResult(session, { job_id: body.job_id }).result);
      expect(later).toMatchObject({ status: 'succeeded', result: { findings: 'still open' } });
    } finally {
      jest.useRealTimers();
    }
  });

  test('signed-out callers and other surfaces are refused', async () => {
    registerDelegationTarget(SUPPORT_TARGET);
    const anon = await delegateToAgent('support', 'q', { ...member, user_id: null });
    expect(anon.status).toBe('refused');
    const hub = await delegateToAgent('support', 'q', { ...member, surface: 'command-hub' });
    expect(hub).toMatchObject({ status: 'refused', error: expect.stringMatching(/not available on the command-hub surface/) });
  });

  test('orb-live dispatches ask_support_specialist to the delegation module', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/routes/orb-live.ts'), 'utf8');
    const i = src.indexOf("case 'ask_support_specialist'");
    expect(i).toBeGreaterThan(0);
    expect(src.slice(i, i + 300)).toContain('runAskSupportSpecialist(session');
  });
});
