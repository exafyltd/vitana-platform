/**
 * VTID-05006: Kiro's write tools — the gates in order, the confirmation's
 * timing (window, cancel, late answer), the push limits, and the wiring.
 * The end-to-end path (real route + fake database + real executor) is in
 * test/vtid-04465-operator-pipeline-regression.test.ts.
 */
import fs from 'fs';
import path from 'path';

jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import { callKiroMcpWrite, checkTargetVtid, kiroMcpWriteTools, KIRO_MCP_WRITE_TOOLS, summarizeWrite } from '../src/services/kiro/kiro-mcp-writes';
import { requestConfirmation, decideConfirmation, setConfirmationStore, type ConfirmationStore } from '../src/services/kiro/kiro-mcp-confirmations';
import { validatePush, pushKiroBranch, kiroBranchPrefix } from '../src/services/kiro/kiro-push-branch';

const U = '0adc6ff6-acb0-4dca-99d0-295211a40e3e';
const caller = { userId: U, tenantId: null, threadId: 'th-1' };
const ON = { KIRO_MCP_WRITE_ENABLED: 'true' } as NodeJS.ProcessEnv;
const open = async () => ({ ok: true as const });
const allow = jest.fn(async () => ({ outcome: 'allowed' as const, id: 'c1' }));

function memoryStore(): ConfirmationStore & { rows: Map<string, any> } {
  const rows = new Map<string, any>();
  let n = 0;
  return {
    rows,
    async insert(r) { const id = `c${++n}`; rows.set(id, { ...r, id, status: 'pending' }); return id; },
    async status(id) { return rows.get(id)?.status ?? null; },
    async settle(id, to, userId) {
      const r = rows.get(id);
      if (!r || r.status !== 'pending' || (userId && r.userId !== userId)) return false;
      r.status = to;
      return true;
    },
    async pending(userId, threadId) { return [...rows.values()].filter((r) => r.userId === userId && r.threadId === threadId && r.status === 'pending'); },
  };
}

describe('the write set', () => {
  it('is the approved list: no deploy, nothing that mints a VTID; every tool needs a vtid', () => {
    const names = kiroMcpWriteTools().map((t) => t.name).sort();
    expect(names).toEqual([...KIRO_MCP_WRITE_TOOLS].sort());
    for (const no of ['dev_deploy_service', 'autopilot_create_task', 'autopilot_run_task', 'autopilot_activate_recommendation']) expect(names).not.toContain(no);
    for (const t of kiroMcpWriteTools()) expect((t.inputSchema as any).required).toContain('vtid');
  });
});

describe('the gates, in order', () => {
  beforeEach(() => allow.mockClear());

  it('switched off: nothing is asked or run', async () => {
    const r = await callKiroMcpWrite(caller, 'dev_merge_pr', { vtid: 'VTID-01234' }, new AbortController().signal, { env: {} as any, confirm: allow, vtidCheck: open, targetCheck: open });
    expect(r.text).toMatch(/switched off/);
    expect(allow).not.toHaveBeenCalled();
  });

  it('autopilot writes respect the autopilot kill switch; other writes do not depend on it', async () => {
    const disarmed = async () => false;
    const exec = jest.fn(async () => ({ ok: true, data: { done: true } }));
    const a = await callKiroMcpWrite(caller, 'autopilot_execute_task', { vtid: 'VTID-01234' }, new AbortController().signal, { env: ON, armed: disarmed, confirm: allow, vtidCheck: open, targetCheck: open, exec: exec as any });
    expect(a.text).toMatch(/disarmed/);
    const b = await callKiroMcpWrite(caller, 'dev_merge_pr', { vtid: 'VTID-01234', pr_number: 3 }, new AbortController().signal, { env: ON, armed: disarmed, confirm: allow, vtidCheck: open, targetCheck: open, exec: exec as any });
    expect(b.ok).toBe(true);
  });

  it('a missing or closed VTID is refused before the user is asked', async () => {
    const closed = async () => ({ ok: false as const, error: 'VTID-01234 is closed' });
    const r = await callKiroMcpWrite(caller, 'dev_merge_pr', { vtid: 'VTID-01234' }, new AbortController().signal, { env: ON, confirm: allow, vtidCheck: closed });
    expect(r.text).toBe('Refused: VTID-01234 is closed. Nothing was done.');
    expect(allow).not.toHaveBeenCalled();
  });

  it('only an Allow runs the tool; a vtid the executor does not take is stripped', async () => {
    const exec = jest.fn(async (_n: string, args: any) => ({ ok: true, data: { args } }));
    const deny = async () => ({ outcome: 'denied' as const, id: 'c1' });
    expect((await callKiroMcpWrite(caller, 'dev_approve_item', { vtid: 'VTID-01234', approval_id: 'a' }, new AbortController().signal, { env: ON, confirm: deny, vtidCheck: open, targetCheck: open, exec: exec as any })).text).toBe('Denied by the user. Nothing was done.');
    expect(exec).not.toHaveBeenCalled();
    const ok = await callKiroMcpWrite(caller, 'dev_approve_item', { vtid: 'VTID-01234', approval_id: 'a' }, new AbortController().signal, { env: ON, confirm: allow, vtidCheck: open, targetCheck: open, exec: exec as any });
    expect(ok.ok).toBe(true);
    expect(exec.mock.calls[0][1]).toEqual({ approval_id: 'a' });
    // dev_merge_pr takes a vtid of its own: it is kept.
    await callKiroMcpWrite(caller, 'dev_merge_pr', { vtid: 'VTID-01234', pr_number: 1 }, new AbortController().signal, { env: ON, confirm: allow, vtidCheck: open, targetCheck: open, exec: exec as any });
    expect(exec.mock.calls[1][1]).toEqual({ vtid: 'VTID-01234', pr_number: 1 });
  });

  it('the target must belong to the gated VTID (Codex review on #3977)', async () => {
    expect(await checkTargetVtid('dev_approve_item', { approval_id: 'appr_VTID-01234_abc' }, 'VTID-01234')).toEqual({ ok: true });
    expect((await checkTargetVtid('dev_reject_item', { approval_id: 'appr_VTID-09999_abc' }, 'VTID-01234')).ok).toBe(false);
    expect((await checkTargetVtid('dev_approve_item', { approval_id: 'whatever' }, 'VTID-01234')).ok).toBe(false);
    expect((await checkTargetVtid('dev_push_kiro_branch', { message: 'fix: no vtid' }, 'VTID-01234')).ok).toBe(false);
    expect(await checkTargetVtid('dev_push_kiro_branch', { message: 'VTID-01234: fix' }, 'VTID-01234')).toEqual({ ok: true });
    expect((await checkTargetVtid('autopilot_approve_execution', {}, 'VTID-01234')).ok).toBe(false);
    expect(await checkTargetVtid('autopilot_cancel_execution', {}, 'VTID-01234')).toEqual({ ok: true }); // listing mode
    // A mismatch refuses before anyone is asked.
    const mismatch = async () => ({ ok: false as const, error: 'approval appr_VTID-09999_x is not for VTID-01234' });
    const r = await callKiroMcpWrite(caller, 'dev_approve_item', { vtid: 'VTID-01234', approval_id: 'appr_VTID-09999_x' }, new AbortController().signal, { env: ON, confirm: allow, vtidCheck: open, targetCheck: mismatch });
    expect(r.text).toBe('Refused: approval appr_VTID-09999_x is not for VTID-01234. Nothing was done.');
    expect(allow).not.toHaveBeenCalled();
  });

  it('the card never shows file contents', () => {
    const s = summarizeWrite('dev_push_kiro_branch', { repo: 'exafyltd/vitana-platform', branch: 'kiro/0adc6ff6/x', files: [{ path: 'a.ts', content: 'SECRET-CONTENT' }] });
    expect(s).toContain('a.ts');
    expect(s).not.toContain('SECRET-CONTENT');
  });
});

describe('the confirmation', () => {
  let store: ReturnType<typeof memoryStore>;
  beforeEach(() => { store = memoryStore(); setConfirmationStore(store); });
  afterAll(() => setConfirmationStore(null));
  const req = { userId: U, threadId: 'th-1', tool: 'dev_merge_pr', vtid: 'VTID-01234', summary: 'merge' };

  it('an Allow from the owner is seen; only once', async () => {
    const p = requestConfirmation(req, new AbortController().signal, { pollMs: 5 });
    await new Promise((r) => setTimeout(r, 10));
    expect(await decideConfirmation('c1', 'someone-else', 'allow')).toBe(false);
    expect(await decideConfirmation('c1', U, 'allow')).toBe(true);
    expect(await decideConfirmation('c1', U, 'deny')).toBe(false);
    expect(await p).toEqual({ outcome: 'allowed', id: 'c1' });
  });

  it('no answer in the window: expired, and a late Allow changes nothing', async () => {
    let t = 0;
    const p = requestConfirmation(req, new AbortController().signal, { pollMs: 1, windowMs: 50, now: () => (t += 10) });
    expect((await p).outcome).toBe('expired');
    expect(await decideConfirmation('c1', U, 'allow')).toBe(false);
    expect(store.rows.get('c1').status).toBe('expired');
  });

  it('the call going away (Kiro gave up, connection closed) expires it at once', async () => {
    const ctl = new AbortController();
    const p = requestConfirmation(req, ctl.signal, { pollMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    ctl.abort();
    expect((await p).outcome).toBe('expired');
    expect(await decideConfirmation('c1', U, 'allow')).toBe(false);
  });
});

describe('dev_push_kiro_branch', () => {
  const good = { repo: 'exafyltd/vitana-platform', branch: `${kiroBranchPrefix(U)}fix-card`, message: 'VTID-01234: fix', files: [{ path: 'services/gateway/src/x.ts', content: 'export {}\n' }] };

  it('only the caller’s own kiro/ branch of vitana-platform (the PR/merge routes accept only that repo)', () => {
    expect(kiroBranchPrefix(U)).toBe('kiro/0adc6ff6/');
    expect(validatePush(good, U).ok).toBe(true);
    expect(validatePush({ ...good, branch: 'main' }, U).ok).toBe(false);
    expect(validatePush({ ...good, branch: 'kiro/11111111/fix-card' }, U).ok).toBe(false);
    expect(validatePush({ ...good, repo: 'someone/else' }, U).ok).toBe(false);
    // VTID-05014 changed this contract on purpose: vitana-v1 is now a push target (its own deny list: test/vtid-05014-*).
    expect(validatePush({ ...good, repo: 'exafyltd/vitana-v1' }, U).ok).toBe(true);
  });

  it('refuses governance, CI, evidence, migrations, ownership and dependency files, and traversal', () => {
    for (const p of ['.github/workflows/x.yml', '.claude/rules/x.md', 'CLAUDE.md', 'services/gateway/CLAUDE.md', 'gov/rules.yaml', 'scripts/ci/guard.js',
      'docs/validation/VTID-1/plan-sparring.md', 'supabase/migrations/1.sql', 'CODEOWNERS', 'docs/CODEOWNERS', 'services/gateway/package.json',
      'package-lock.json', 'a/yarn.lock', '../escape.ts', '/etc/passwd', 'a/../../b.ts']) {
      expect(validatePush({ ...good, files: [{ path: p, content: 'x' }] }, U).ok).toBe(false);
    }
  });

  it('enforces the size, count and text-only limits', () => {
    expect(validatePush({ ...good, files: [{ path: 'a.ts', content: 'x'.repeat(512 * 1024 + 1) }] }, U).ok).toBe(false);
    expect(validatePush({ ...good, files: Array.from({ length: 51 }, (_, i) => ({ path: `f${i}.ts`, content: 'x' })) }, U).ok).toBe(false);
    expect(validatePush({ ...good, files: Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.ts`, content: 'x'.repeat(500 * 1024) })) }, U).ok).toBe(false);
    expect(validatePush({ ...good, files: [{ path: 'a.bin', content: 'a\u0000b' }] }, U).ok).toBe(false);
  });

  it('one commit on a new branch from main, or a fast-forward of the existing one — never force', async () => {
    const calls: Array<[string, string, any]> = [];
    const gh = async (m: string, e: string, b?: any) => {
      calls.push([m, e, b]);
      if (m === 'GET' && e.endsWith(`/heads/${good.branch}`)) return null;
      if (m === 'GET' && e.endsWith('/heads/main')) return { object: { sha: 'main-sha' } };
      if (m === 'GET' && e.includes('/git/commits/')) return { tree: { sha: 'base-tree' } };
      if (e.endsWith('/git/blobs')) return { sha: 'blob-1' };
      if (e.endsWith('/git/trees')) return { sha: 'tree-1' };
      if (e.endsWith('/git/commits')) return { sha: 'commit-1' };
      return {};
    };
    const r = await pushKiroBranch(good, U, gh);
    expect(r).toMatchObject({ ok: true, commit_sha: 'commit-1', created: true, files: 1 });
    expect(calls.find((c) => c[1].endsWith('/git/commits') && c[0] === 'POST')![2].parents).toEqual(['main-sha']);
    expect(calls.find((c) => c[1].endsWith('/git/refs'))![2]).toEqual({ ref: `refs/heads/${good.branch}`, sha: 'commit-1' });
    expect(calls.some((c) => c[2] && c[2].force === true)).toBe(false);
  });
});

describe('wiring (source check)', () => {
  const root = path.join(__dirname, '../../..');
  const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

  it('the confirmation table is service-role only and documented', () => {
    const sql = read('supabase/migrations/20261009180000_vtid_05006_kiro_mcp_confirmations.sql');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('REVOKE ALL ON public.kiro_mcp_confirmations FROM anon, authenticated');
    expect(read('DATABASE_SCHEMA.md')).toContain('kiro_mcp_confirmations');
  });

  it('the decision routes are admin-only and use the caller from the identity', () => {
    const op = read('services/gateway/src/routes/operator.ts');
    expect(op).toContain("router.get('/kiro/confirmations', requireAdminAuth,");
    expect(op).toContain("router.post('/kiro/confirmations/:id', requireAdminAuth,");
    const cicd = read('services/gateway/src/types/cicd.ts');
    for (const t of ['write_tool_called', 'write_confirmed', 'write_denied', 'branch_pushed']) expect(cicd).toContain(`| 'operator.kiro.${t}'`);
  });

  it('writes follow the engine on both environments (owner approved production 2026-10-09); off with no runner', () => {
    expect(read('.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml')).toContain('{name:"KIRO_MCP_WRITE_ENABLED", value:"true"}');
    const prod = read('.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml');
    expect(prod).toContain('{name:"KIRO_MCP_ENABLED", value:"true"},\n                           {name:"KIRO_MCP_WRITE_ENABLED", value:"true"},');
    // No production runner configured: everything Kiro stays off.
    expect(prod).toContain('{name:"KIRO_MCP_ENABLED", value:"false"}, {name:"KIRO_MCP_WRITE_ENABLED", value:"false"} ]');
  });

  // VTID-05067: the poll moved with the Kiro view into kiro-console.js (one owner of the
  // Kiro view); it runs only while a run of the thread runs (behaviour pinned by
  // test/command-hub/vtid-05067-kiro-console.test.ts).
  it('the Command Hub polls only during a Kiro run and answers through the confirmation route', () => {
    const mod = read('services/gateway/src/frontend/command-hub/kiro-console.js');
    expect(mod).toContain('function updateConfirmationPoll(t) {');
    expect(mod).toContain('var want = !!activeRun(t);');
    expect(mod).toContain("'/api/v1/operator/kiro/confirmations?thread_id=' + encodeURIComponent(t.id)");
    expect(mod).toContain("'/api/v1/operator/kiro/confirmations/' + encodeURIComponent(confirmationId)");
    expect(read('services/gateway/src/frontend/command-hub/app.js')).not.toContain('startKiroConfirmationPoll');
  });
});
