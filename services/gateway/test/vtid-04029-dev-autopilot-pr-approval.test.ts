/**
 * VTID-04029 (W4e, gap analysis §4.6): diff preview + Approve/Reject before
 * the Dev Autopilot agent opens a pull request.
 *
 *  (1) pure: approvalRequired (row flag wins, env fallback, never in fix
 *      mode), boundDiffPreview / buildPendingApproval bounds, result guard;
 *  (2) service against a fake PostgREST: stage (status + merged metadata +
 *      one OASIS event), approve (PR opened with the stored title/body on the
 *      pushed branch, decision merged into metadata, applyExecutionResult
 *      re-entered with pr_url), reject (branch deleted, status cancelled,
 *      metadata.rejected), and the refusals (wrong status, missing preview,
 *      PR-open failure leaves the row waiting);
 *  (3) applyExecutionResult routes an awaiting_approval result to the stage
 *      and a malformed one to the failure path;
 *  (4) routes: GET diff / POST approve / POST reject on the dev-autopilot
 *      router, exafy_admin-gated, actor = verified identity;
 *  (5) wiring guards: migration widens the CHECK, active list + stream
 *      terminal topics know the status, the runner holds before openPullRequest,
 *      the on-ramp stamps require_approval, the Command Hub card has the
 *      Diff / Approve / Reject controls and the diff panel.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { NextFunction, Request, Response } from 'express';

jest.mock('node-fetch');
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
  cicdEvents: {},
  default: { deployRequested: jest.fn(), deployAccepted: jest.fn(), deployFailed: jest.fn() },
}));
jest.mock('../src/services/github-service', () => ({
  createPullRequest: jest.fn(),
  searchCode: jest.fn(), getFileContents: jest.fn(), listOpenPrsWithStatus: jest.fn(), listOpenPrsBare: jest.fn(),
  default: { triggerWorkflow: jest.fn(), getWorkflowRuns: jest.fn().mockResolvedValue({ workflow_runs: [] }) },
}));

// A tiny PostgREST double: rows by id, PATCH merges the body, every call recorded.
type Row = Record<string, any>;
const db: { rows: Map<string, Row>; calls: Array<{ path: string; method: string; body?: any }> } = { rows: new Map(), calls: [] };
function resetDb(rows: Row[]) {
  db.rows = new Map(rows.map((r) => [r.id, { ...r }]));
  db.calls = [];
}
const fakeSupa = jest.fn(async (_s: unknown, p: string, init: any = {}) => {
  const method = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : undefined;
  db.calls.push({ path: p, method, body });
  const m = p.match(/dev_autopilot_executions\?id=eq\.([^&]+)/);
  const id = m ? decodeURIComponent(m[1]) : null;
  const row = id ? db.rows.get(id) : undefined;
  if (method === 'GET') return { ok: true, status: 200, data: row ? [row] : [] };
  if (method === 'PATCH') {
    if (!row) return { ok: true, status: 204 };
    if (/status=eq\.([a-z_]+)/.test(p) && row.status !== p.match(/status=eq\.([a-z_]+)/)![1]) return { ok: true, status: 204 };
    Object.assign(row, body);
    return { ok: true, status: 204 };
  }
  return { ok: true, status: 200, data: [] };
});
const applyExecutionResultMock = jest.fn(async () => undefined);
jest.mock('../src/services/dev-autopilot-execute', () => {
  const actual = jest.requireActual('../src/services/dev-autopilot-execute');
  return {
    ...actual,
    supa: (...args: any[]) => fakeSupa(...(args as [unknown, string, any])),
    getSupabase: () => ({ url: 'http://supa.test', key: 'k' }),
    applyExecutionResult: (...args: any[]) => applyExecutionResultMock(...(args as [])),
  };
});

import { emitOasisEvent } from '../src/services/oasis-event-service';
import { createPullRequest } from '../src/services/github-service';
import {
  approvalRequired, boundDiffPreview, buildPendingApproval, isAwaitingApprovalResult,
  stageExecutionForApproval, approveExecution, rejectExecution, getPendingApproval,
  PENDING_DIFF_MAX_CHARS, PENDING_STAT_MAX_CHARS, PENDING_FILES_MAX,
  type AwaitingApprovalResult,
} from '../src/services/dev-autopilot-approval';

const S = { url: 'http://supa.test', key: 'k' };
const EXEC = '11111111-2222-4333-8444-555555555555';

function awaitingResult(over: Partial<AwaitingApprovalResult> = {}): AwaitingApprovalResult {
  return {
    ok: true, awaiting_approval: true, branch: 'dev-autopilot/11111111', base_sha: 'b'.repeat(40), head_sha: 'h'.repeat(40),
    pr_title: 'feat: thing (VTID-04099)', pr_body: 'VTID: VTID-04099\n\nbody', session_id: 'agent_abc',
    diff: { stat: ' a.ts | 2 +-\n 1 file changed', patch: 'diff --git a/a.ts b/a.ts\n-old\n+new\n', files: ['a.ts'] },
    ...over,
  };
}

// ---------------------------------------------------------------------------
describe('VTID-04029 pure helpers', () => {
  it('approvalRequired: row flag wins over env, env exact-string fallback, never in fix mode', () => {
    expect(approvalRequired({ require_approval: true }, { env: {} as any })).toBe(true);
    expect(approvalRequired({ require_approval: false }, { env: { DEV_AUTOPILOT_PR_APPROVAL_REQUIRED: 'true' } as any })).toBe(false);
    expect(approvalRequired({}, { env: { DEV_AUTOPILOT_PR_APPROVAL_REQUIRED: 'true' } as any })).toBe(true);
    expect(approvalRequired(null, { env: { DEV_AUTOPILOT_PR_APPROVAL_REQUIRED: 'TRUE' } as any })).toBe(false);
    expect(approvalRequired(undefined, { env: {} as any })).toBe(false);
    expect(approvalRequired({ require_approval: true }, { fixMode: true, env: {} as any })).toBe(false);
  });

  it('boundDiffPreview clips the stat, the patch and the file list and reports truncation + totals', () => {
    const small = boundDiffPreview({ stat: 's', patch: 'p', files: ['a'], baseSha: 'b', headSha: 'h' });
    expect(small).toMatchObject({ stat: 's', patch: 'p', files: ['a'], files_total: 1, patch_chars_total: 1, truncated: false, base_sha: 'b', head_sha: 'h' });
    const big = boundDiffPreview({
      stat: 'x'.repeat(PENDING_STAT_MAX_CHARS + 10), patch: 'y'.repeat(PENDING_DIFF_MAX_CHARS + 500),
      files: Array.from({ length: PENDING_FILES_MAX + 5 }, (_, i) => `f${i}`), baseSha: 'b', headSha: 'h',
    });
    expect(big.truncated).toBe(true);
    expect(big.patch.length).toBeLessThan(PENDING_DIFF_MAX_CHARS + 80);
    expect(big.patch).toContain('…[truncated: 500 more chars]');
    expect(big.stat.length).toBeLessThan(PENDING_STAT_MAX_CHARS + 80);
    expect(big.files).toHaveLength(PENDING_FILES_MAX);
    expect(big.files_total).toBe(PENDING_FILES_MAX + 5);
    expect(big.patch_chars_total).toBe(PENDING_DIFF_MAX_CHARS + 500);
  });

  it('buildPendingApproval carries branch/shas/title/body/session + bounded diff with a staged_at timestamp', () => {
    const p = buildPendingApproval(awaitingResult(), () => new Date('2026-09-17T23:00:00Z'));
    expect(p).toMatchObject({ branch: 'dev-autopilot/11111111', pr_title: 'feat: thing (VTID-04099)', session_id: 'agent_abc', staged_at: '2026-09-17T23:00:00.000Z' });
    expect(p.diff.files).toEqual(['a.ts']);
    expect(p.diff.patch).toContain('+new');
  });

  it('isAwaitingApprovalResult accepts only ok+awaiting_approval with branch and head_sha', () => {
    expect(isAwaitingApprovalResult(awaitingResult())).toBe(true);
    expect(isAwaitingApprovalResult({ ok: true, awaiting_approval: true })).toBe(false);
    expect(isAwaitingApprovalResult({ ok: true, pr_url: 'x' })).toBe(false);
    expect(isAwaitingApprovalResult(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('VTID-04029 stage / approve / reject', () => {
  beforeEach(() => {
    (emitOasisEvent as jest.Mock).mockClear();
    (createPullRequest as jest.Mock).mockReset();
    applyExecutionResultMock.mockClear();
    fakeSupa.mockClear();
  });

  it('stageExecutionForApproval sets status awaiting_approval, merges pending_approval into the row metadata, emits one event', async () => {
    resetDb([{ id: EXEC, status: 'running', metadata: { executor: 'agent', claimed_env: 'staging' } }]);
    const r = await stageExecutionForApproval(S as any, EXEC, awaitingResult());
    expect(r.ok).toBe(true);
    const row = db.rows.get(EXEC)!;
    expect(row.status).toBe('awaiting_approval');
    expect(row.branch).toBe('dev-autopilot/11111111');
    expect(row.execution_session_id).toBe('agent_abc');
    expect(row.metadata.executor).toBe('agent');          // merged, not replaced (VTID-04011)
    expect(row.metadata.claimed_env).toBe('staging');
    expect(row.metadata.pending_approval.head_sha).toBe('h'.repeat(40));
    expect(row.metadata.pending_approval.diff.files_total).toBe(1);
    const ev = (emitOasisEvent as jest.Mock).mock.calls[0][0];
    expect(ev.type).toBe('dev_autopilot.execution.awaiting_approval');
    expect(ev.payload).toMatchObject({ execution_id: EXEC, branch: 'dev-autopilot/11111111', files: 1 });
  });

  it('getPendingApproval returns the status and the stored preview', async () => {
    resetDb([{ id: EXEC, status: 'awaiting_approval', metadata: { pending_approval: buildPendingApproval(awaitingResult()) } }]);
    const r = await getPendingApproval(EXEC, S as any);
    expect(r.ok).toBe(true);
    expect(r.status).toBe('awaiting_approval');
    expect(r.pending?.branch).toBe('dev-autopilot/11111111');
    expect((await getPendingApproval('nope', S as any)).ok).toBe(false);
  });

  it('approveExecution opens the PR with the stored title/body on the pushed branch, records the decision, re-enters applyExecutionResult with the PR', async () => {
    resetDb([{ id: EXEC, status: 'awaiting_approval', metadata: { executor: 'agent', pending_approval: buildPendingApproval(awaitingResult()) } }]);
    const openPr = jest.fn(async () => ({ number: 42, html_url: 'https://github.com/exafyltd/vitana-platform/pull/42' }));
    const r = await approveExecution(EXEC, 'owner@example.test', { s: S as any, openPr });
    expect(r).toEqual({ ok: true, pr_url: 'https://github.com/exafyltd/vitana-platform/pull/42', pr_number: 42 });
    expect(openPr).toHaveBeenCalledTimes(1);
    const [title, body, branch] = openPr.mock.calls[0] as unknown as [string, string, string];
    expect(title).toBe('feat: thing (VTID-04099)');
    expect(body).toContain('VTID: VTID-04099');
    expect(body).toContain('Approved by owner@example.test');
    expect(branch).toBe('dev-autopilot/11111111');
    expect(db.rows.get(EXEC)!.metadata.approved).toMatchObject({ by: 'owner@example.test', head_sha: 'h'.repeat(40) });
    expect(db.rows.get(EXEC)!.metadata.executor).toBe('agent');
    expect(applyExecutionResultMock).toHaveBeenCalledWith(S, EXEC, { ok: true, pr_url: 'https://github.com/exafyltd/vitana-platform/pull/42', pr_number: 42, branch: 'dev-autopilot/11111111', session_id: 'agent_abc' });
    const ev = (emitOasisEvent as jest.Mock).mock.calls.find((c) => c[0].type === 'dev_autopilot.execution.approved')[0];
    expect(ev.payload).toMatchObject({ execution_id: EXEC, actor: 'owner@example.test', pr_number: 42 });
  });

  it('approveExecution uses github-service createPullRequest against main by default', async () => {
    resetDb([{ id: EXEC, status: 'awaiting_approval', metadata: { pending_approval: buildPendingApproval(awaitingResult()) } }]);
    (createPullRequest as jest.Mock).mockResolvedValue({ number: 7, html_url: 'https://github.com/exafyltd/vitana-platform/pull/7' });
    const r = await approveExecution(EXEC, 'u', { s: S as any });
    expect(r.ok).toBe(true);
    expect(createPullRequest).toHaveBeenCalledWith('exafyltd/vitana-platform', 'feat: thing (VTID-04099)', expect.stringContaining('Approved by u'), 'dev-autopilot/11111111', 'main');
  });

  it('approveExecution refuses a row that is not awaiting_approval, a row without a preview, and leaves the row waiting when the PR open fails', async () => {
    resetDb([{ id: EXEC, status: 'ci', metadata: {} }]);
    expect((await approveExecution(EXEC, 'u', { s: S as any })).error).toMatch(/is ci, not awaiting_approval/);
    resetDb([{ id: EXEC, status: 'awaiting_approval', metadata: {} }]);
    expect((await approveExecution(EXEC, 'u', { s: S as any })).error).toMatch(/no pending_approval/);
    resetDb([{ id: EXEC, status: 'awaiting_approval', metadata: { pending_approval: buildPendingApproval(awaitingResult()) } }]);
    const r = await approveExecution(EXEC, 'u', { s: S as any, openPr: async () => { throw new Error('422 Validation Failed'); } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/open PR failed: 422/);
    expect(db.rows.get(EXEC)!.status).toBe('awaiting_approval');
    expect(applyExecutionResultMock).not.toHaveBeenCalled();
    expect((await approveExecution('missing', 'u', { s: S as any })).error).toBe('execution not found');
  });

  it('rejectExecution deletes the pushed branch, cancels the row with metadata.rejected, emits the rejected event; a branch-delete failure is recorded, not fatal', async () => {
    resetDb([{ id: EXEC, status: 'awaiting_approval', branch: 'dev-autopilot/11111111', metadata: { executor: 'agent', pending_approval: buildPendingApproval(awaitingResult()) } }]);
    const deleteBranch = jest.fn(async () => ({ ok: true }));
    const r = await rejectExecution(EXEC, 'owner@example.test', '  wrong approach  ', { s: S as any, deleteBranch });
    expect(r).toEqual({ ok: true, branch_deleted: true });
    expect(deleteBranch).toHaveBeenCalledWith('dev-autopilot/11111111');
    const row = db.rows.get(EXEC)!;
    expect(row.status).toBe('cancelled');
    expect(row.completed_at).toBeTruthy();
    expect(row.metadata.rejected).toMatchObject({ by: 'owner@example.test', reason: 'wrong approach', branch: 'dev-autopilot/11111111', branch_deleted: true });
    expect(row.metadata.executor).toBe('agent');
    const ev = (emitOasisEvent as jest.Mock).mock.calls.find((c) => c[0].type === 'dev_autopilot.execution.rejected')[0];
    expect(ev.payload).toMatchObject({ execution_id: EXEC, actor: 'owner@example.test', reason: 'wrong approach', branch_deleted: true });

    resetDb([{ id: EXEC, status: 'awaiting_approval', metadata: { pending_approval: buildPendingApproval(awaitingResult()) } }]);
    const r2 = await rejectExecution(EXEC, 'u', undefined, { s: S as any, deleteBranch: async () => ({ ok: false, error: '403' }) });
    expect(r2).toEqual({ ok: true, branch_deleted: false });
    expect(db.rows.get(EXEC)!.status).toBe('cancelled');
    expect(db.rows.get(EXEC)!.metadata.rejected.delete_error).toBe('403');
  });

  it('rejectExecution refuses a row that is not awaiting_approval', async () => {
    resetDb([{ id: EXEC, status: 'running', metadata: {} }]);
    const r = await rejectExecution(EXEC, 'u', 'x', { s: S as any, deleteBranch: async () => ({ ok: true }) });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/is running/);
    expect(db.rows.get(EXEC)!.status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
describe('VTID-04029 applyExecutionResult routing (real function, staged path mocked)', () => {
  it('routes an awaiting_approval result to stageExecutionForApproval and a malformed one to the failure path', async () => {
    jest.resetModules();
    const stage = jest.fn(async () => ({ ok: true }));
    jest.doMock('../src/services/dev-autopilot-approval', () => {
      const actual = jest.requireActual('../src/services/dev-autopilot-approval');
      return { ...actual, stageExecutionForApproval: stage };
    });
    jest.doMock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }), cicdEvents: {}, default: {} }));
    jest.doMock('../src/services/operator-turn-memory', () => ({ recordExecutionOutcomeMemory: jest.fn().mockResolvedValue(undefined), isTurnMemoryEnabled: () => false }));
    const fetchMock = jest.fn(async (url: string, init: any = {}) => {
      if ((init.method || 'GET') === 'GET') return { ok: true, status: 200, text: async () => '[]', json: async () => [{ metadata: { executor: 'agent' } }] };
      return { ok: true, status: 204, text: async () => '' };
    });
    (global as any).fetch = fetchMock;
    // requireActual: the top-level jest.mock above replaces applyExecutionResult
    // with a spy for the approve test; here the REAL function is under test.
    const mod = jest.requireActual('../src/services/dev-autopilot-execute');
    await mod.applyExecutionResult({ url: 'http://supa.test', key: 'k' }, EXEC, awaitingResult());
    expect(stage).toHaveBeenCalledTimes(1);
    expect(stage.mock.calls[0][1]).toBe(EXEC);

    stage.mockClear();
    await mod.applyExecutionResult({ url: 'http://supa.test', key: 'k' }, EXEC, { ok: true, awaiting_approval: true });
    expect(stage).not.toHaveBeenCalled();
    // failure path PATCHes the row with status failed
    const patch = fetchMock.mock.calls.find((c) => (c[1]?.method === 'PATCH') && String(c[1]?.body).includes('"status":"failed"'));
    expect(patch).toBeTruthy();
    expect(String(patch![1].body)).toContain('missing branch/head_sha');
  });
});

// ---------------------------------------------------------------------------
describe('VTID-04029 routes', () => {
  let optionalAuthImpl: (req: Request, res: Response, next: NextFunction) => void = (_req, _res, next) => next();
  beforeAll(() => {
    jest.resetModules();
    jest.doMock('../src/middleware/auth-supabase-jwt', () => {
      const actual = jest.requireActual('../src/middleware/auth-supabase-jwt');
      return {
        ...actual,
        requireAuth: (req: Request, res: Response, next: NextFunction) => optionalAuthImpl(req, res, next),
        optionalAuth: (req: Request, res: Response, next: NextFunction) => optionalAuthImpl(req, res, next),
      };
    });
  });

  function loadRouter() {
    // Fresh registry per call — otherwise the router keeps the previous
    // call's approve/reject doubles (module cache), not the ones returned here.
    jest.resetModules();
    const approve = jest.fn(async (id: string, actor: string) => ({ ok: true, pr_url: `https://x/pull/9`, pr_number: 9, _id: id, _actor: actor }));
    const reject = jest.fn(async (id: string, actor: string, reason?: string) => ({ ok: true, branch_deleted: true, _id: id, _actor: actor, _reason: reason }));
    const diff = jest.fn(async (id: string) => (id === EXEC ? { ok: true, status: 'awaiting_approval', pending: { branch: 'b' } } : { ok: false, error: 'execution not found' }));
    jest.doMock('../src/services/dev-autopilot-approval', () => ({ approveExecution: approve, rejectExecution: reject, getPendingApproval: diff }));
    const express = require('express');
    const router = require('../src/routes/dev-autopilot').default;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/dev-autopilot', router);
    return { app, approve, reject, diff };
  }

  it('GET /executions/:id/diff → 200 with the preview, 404 when unknown; requires an admin identity', async () => {
    optionalAuthImpl = (req, _res, next) => { (req as any).identity = { user_id: 'u1', email: 'admin@example.test', exafy_admin: true }; next(); };
    const request = require('supertest');
    const { app } = loadRouter();
    const ok = await request(app).get(`/api/v1/dev-autopilot/executions/${EXEC}/diff`).expect(200);
    expect(ok.body.pending.branch).toBe('b');
    await request(app).get('/api/v1/dev-autopilot/executions/other/diff').expect(404);

    optionalAuthImpl = (_req, _res, next) => next(); // no identity
    const { app: app2 } = loadRouter();
    await request(app2).get(`/api/v1/dev-autopilot/executions/${EXEC}/diff`).expect(401);
  });

  it('POST approve / reject pass the verified identity as actor (email first) and the body reason', async () => {
    optionalAuthImpl = (req, _res, next) => { (req as any).identity = { user_id: 'u1', email: 'admin@example.test', exafy_admin: true }; next(); };
    const request = require('supertest');
    const { app, approve, reject } = loadRouter();
    const a = await request(app).post(`/api/v1/dev-autopilot/executions/${EXEC}/approve`).send({}).expect(200);
    expect(a.body.pr_number).toBe(9);
    expect(approve).toHaveBeenCalledWith(EXEC, 'admin@example.test');
    const r = await request(app).post(`/api/v1/dev-autopilot/executions/${EXEC}/reject`).send({ reason: 'nope' }).expect(200);
    expect(r.body.branch_deleted).toBe(true);
    expect(reject).toHaveBeenCalledWith(EXEC, 'admin@example.test', 'nope');
  });
});

// ---------------------------------------------------------------------------
describe('VTID-04029 wiring guards', () => {
  const ROOT = path.join(__dirname, '..');
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

  it('the migration widens the status CHECK with awaiting_approval and keeps every prior status', () => {
    const sql = fs.readFileSync(path.join(ROOT, '../../supabase/migrations/20260918000000_vtid_04029_dev_autopilot_executions_awaiting_approval.sql'), 'utf8');
    for (const s of ['queued', 'cooling', 'cancelled', 'running', 'awaiting_approval', 'ci', 'merging', 'deploying', 'verifying', 'completed', 'failed', 'reverted', 'self_healed', 'failed_escalated', 'auto_archived']) {
      expect(sql).toContain(`'${s}'`);
    }
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS dev_autopilot_executions_status_check');
  });

  it('the agent runner holds before openPullRequest when approval is required, never in fix mode, and records outcome awaiting_approval', () => {
    const src = read('src/services/autopilot-agent/run-agent-execution.ts');
    const hold = src.indexOf("if (approvalRequired(exec.metadata, { fixMode: false })) {");
    const open = src.indexOf('const pr = await openPullRequest(token, branch, contract.title, contract.body);');
    const fix = src.indexOf('if (fixMode) {\n      // Same PR, new head');
    expect(hold).toBeGreaterThan(-1);
    expect(fix).toBeLessThan(hold);
    expect(hold).toBeLessThan(open);
    expect(src).toContain('const diff = await gitDiffAgainstBase(repoDir, baseSha);');
    expect(src).toContain("r.awaiting_approval ? 'awaiting_approval'");
    expect(read('src/services/dev-autopilot-outcomes.ts')).toContain("'awaiting_approval'");
  });

  it('the on-ramp stamps require_approval from OPERATOR_PR_APPROVAL_REQUIRED; .env.example documents both switches', () => {
    expect(read('src/services/operator-execution-onramp.ts')).toContain("process.env.OPERATOR_PR_APPROVAL_REQUIRED === 'true' ? { require_approval: true } : {}");
    const env = read('.env.example');
    expect(env).toContain('OPERATOR_PR_APPROVAL_REQUIRED=false');
    expect(env).toContain('DEV_AUTOPILOT_PR_APPROVAL_REQUIRED=false');
  });

  it('the active list, the same-finding inflight guards and the stream terminal topics know the status', () => {
    const routes = read('src/routes/dev-autopilot.ts');
    expect(routes).toContain("statusClause = 'status=in.(cooling,running,awaiting_approval,ci,merging,deploying,verifying)';");
    expect(routes).toContain("'dev_autopilot.execution.awaiting_approval',");
    expect(routes).toContain("'dev_autopilot.execution.rejected',");
    const exec = read('src/services/dev-autopilot-execute.ts');
    expect(exec.match(/status=in\.\(cooling,running,awaiting_approval,ci,merging,deploying,verifying\)/g)?.length).toBe(2);
    // the concurrency cap deliberately does NOT count a human hold
    expect(exec).toContain('`/rest/v1/dev_autopilot_executions?status=in.(running,ci,merging,deploying,verifying)&select=id`');
  });

  it('the diff API contract and shared expandedDiffExecIds state exist for the Command Hub UI', () => {
    // VTID-04061 deleted renderDevAutopilotExecutionCard()/renderDevAutopilotLiveTrace() —
    // confirmed dead code, its only caller was itself. The Diff/Approve/Reject
    // controls this test used to pin on that function now live exclusively in
    // renderAutopilotLiveView() (asserted below); this test keeps only what is
    // NOT specific to either renderer — the shared API call shapes and state key.
    const app = read('src/frontend/command-hub/app.js');
    expect(app).toContain("devAutopilotApi('/executions/' + execId + '/diff', 'GET')");
    expect(app).toContain("devAutopilotApi('/executions/' + execId + '/approve', 'POST', {})");
    expect(app).toContain("devAutopilotApi('/executions/' + execId + '/reject', 'POST', { reason: reason })");
    expect(app).toContain('expandedDiffExecIds: {},');
  });

  it('the Autopilot Live view (the rows operators actually see) carries the same controls and updates both execution lists', () => {
    const app = read('src/frontend/command-hub/app.js');
    const live = app.slice(app.indexOf('function renderAutopilotLiveView()'), app.indexOf('function renderAutopilotEngineView()'));
    expect(live).toContain("card.id = 'autopilot-live-exec-' + exec.id;");
    expect(live).toContain("exec.status === 'awaiting_approval' ? '#f59e0b'");
    expect(live).toContain("if (exec.status === 'awaiting_approval') {");
    expect(live).toContain('liveApproveBtn.onclick = function () { devAutopilotApproveExecution(exec.id); };');
    expect(live).toContain('liveRejectBtn.onclick = function () { devAutopilotRejectExecution(exec.id); };');
    expect(live).toContain('liveDiffWrap.appendChild(renderExecutionDiffPanel(exec.id));');
    const lists = app.slice(app.indexOf('function devAutopilotExecutionLists()'), app.indexOf('function devAutopilotApproveExecution('));
    expect(lists).toContain('state.devAutopilot.executions');
    expect(lists).toContain('state.autopilot.live.devAutopilotExecutions');
  });
});
