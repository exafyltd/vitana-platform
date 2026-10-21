/**
 * VTID-04030 (W4f): the Operator Console reviews / approves / rejects a
 * held Dev Autopilot execution from chat.
 *
 * Pinned here: the three tool declarations (registry + operator wire
 * schema + dispatch), both prompt sources under the VTID-03838 drift rule,
 * the VTID-03851 caller gate running before any Supabase read, prefix
 * resolution among awaiting rows only, the bounded review payload, and
 * that approve/reject hand the verified actor to the VTID-04029 functions.
 */

import * as fs from 'fs';
import * as path from 'path';

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../src/services/dev-autopilot-execute', () => {
  const actual = jest.requireActual('../src/services/dev-autopilot-execute');
  return { ...actual, getSupabase: jest.fn(() => null), supa: jest.fn() };
});

import { supa } from '../src/services/dev-autopilot-execute';
import { setThreadAuth, clearThreadAuth } from '../src/services/operator-execute-authz';
import { getToolByName } from '../src/services/tool-registry';
import {
  executeReviewExecution,
  executeApproveExecution,
  executeRejectExecution,
  resolveExecutionId,
  authorizeApprovalTool,
  REVIEW_PATCH_MAX_CHARS,
  REVIEW_FILES_MAX,
  EXECUTION_ID_MIN_PREFIX,
} from '../src/services/operator-approval-tools';

const mockedSupa = supa as jest.Mock;

const SRC = path.resolve(__dirname, '../src/services');
const personality = fs.readFileSync(path.join(SRC, 'ai-personality-service.ts'), 'utf8');
const operator = fs.readFileSync(path.join(SRC, 'gemini-operator.ts'), 'utf8');

const S = { url: 'https://supa.test', key: 'k' };
const EXEC_A = '4f7d5ea4-1111-4222-8333-444444444444';
const EXEC_B = '4f7d5eb9-1111-4222-8333-555555555555';
const ADMIN = 't-admin';
const ANON = 't-anon';
const NONADMIN = 't-user';

const PENDING = {
  branch: 'dev-autopilot/4f7d5ea4',
  base_sha: 'b'.repeat(40),
  head_sha: 'h'.repeat(40),
  pr_title: 'fix: x (VTID-04100)',
  pr_body: 'body '.repeat(600),
  session_id: 'sess-1',
  staged_at: '2026-09-17T23:00:00.000Z',
  diff: {
    base_sha: 'b'.repeat(40),
    head_sha: 'h'.repeat(40),
    files: Array.from({ length: 70 }, (_, i) => `services/gateway/src/f${i}.ts`),
    files_total: 70,
    stat: ' 70 files changed',
    patch: 'x'.repeat(REVIEW_PATCH_MAX_CHARS + 500),
    patch_chars_total: REVIEW_PATCH_MAX_CHARS + 500,
    truncated: false,
  },
};

function row(id: string, extra: Record<string, unknown> = {}) {
  return { id, status: 'awaiting_approval', branch: null, finding_id: `f-${id.slice(0, 8)}`, updated_at: '2026-09-17T23:00:00.000Z', metadata: { pending_approval: PENDING }, ...extra };
}

function wireSupa(rows: unknown[], recs: Array<{ id: string; activated_vtid: string | null }> = []) {
  mockedSupa.mockImplementation(async (_s: unknown, p: string) => {
    if (p.startsWith('/rest/v1/dev_autopilot_executions?status=eq.awaiting_approval')) return { ok: true, status: 200, data: rows };
    if (p.startsWith('/rest/v1/autopilot_recommendations?id=in.')) return { ok: true, status: 200, data: recs };
    return { ok: false, status: 404, error: `unexpected ${p}` };
  });
}

beforeEach(() => {
  mockedSupa.mockReset();
  setThreadAuth(ADMIN, { user_id: 'u-admin', exafy_admin: true });
  setThreadAuth(NONADMIN, { user_id: 'u-1', exafy_admin: false });
  clearThreadAuth(ANON);
});

describe('VTID-04030 tool declarations', () => {
  it('registry: three tools, review takes an optional id, approve/reject require it, all VTID-04030', () => {
    const review = getToolByName('autopilot_review_execution')!;
    const approve = getToolByName('autopilot_approve_execution')!;
    const reject = getToolByName('autopilot_reject_execution')!;
    expect(review.parameters_schema.required).toEqual([]);
    expect(Object.keys(review.parameters_schema.properties)).toEqual(['execution_id']);
    expect(approve.parameters_schema.required).toEqual(['execution_id']);
    expect(reject.parameters_schema.required).toEqual(['execution_id']);
    expect(Object.keys(reject.parameters_schema.properties)).toEqual(['execution_id', 'reason']);
    for (const t of [review, approve, reject]) {
      expect(t.vtid).toBe('VTID-04030');
      expect(t.category).toBe('autopilot');
      expect(t.allowed_roles).toEqual(['operator', 'admin', 'developer']);
      expect(t.description).toMatch(/exafy_admin session required/);
    }
    expect(review.description).toMatch(/Read-only/);
  });

  it('operator wire schema: same shapes, in order, and each dispatched to its handler', () => {
    const start = operator.indexOf("name: 'autopilot_review_execution'");
    const end = operator.indexOf("name: 'autopilot_get_status'", start);
    expect(start).toBeGreaterThan(-1);
    const block = operator.slice(start, end);
    expect(block).toContain("name: 'autopilot_approve_execution'");
    expect(block).toContain("name: 'autopilot_reject_execution'");
    expect(block.indexOf("name: 'autopilot_approve_execution'")).toBeLessThan(block.indexOf("name: 'autopilot_reject_execution'"));
    expect(block).toMatch(/required: \[\]\s*\n\s*\}\s*\n\s*\},\s*\n\s*\{\s*\n\s*name: 'autopilot_approve_execution'/);
    expect((block.match(/required: \['execution_id'\]/g) || []).length).toBe(2);
    expect(operator).toMatch(/case 'autopilot_review_execution':\s*\n\s*result = await executeReviewExecution\(/);
    expect(operator).toMatch(/case 'autopilot_approve_execution':\s*\n\s*result = await executeApproveExecution\(/);
    expect(operator).toMatch(/case 'autopilot_reject_execution':\s*\n\s*result = await executeRejectExecution\(/);
    expect(operator).toMatch(/import \{ executeReviewExecution, executeApproveExecution, executeRejectExecution \} from '\.\/operator-approval-tools';/);
  });
});

describe('VTID-04030 both operator prompt sources describe the tools (VTID-03838 drift rule)', () => {
  const served = (() => {
    const start = personality.indexOf('operator_chat: {');
    const end = personality.indexOf('calculation_directive:', start);
    return personality.slice(start, end).replace(/\\n/g, '\n').replace(/\\'/g, "'");
  })();
  const inline = (() => {
    const start = operator.indexOf('function getOperatorSystemPrompt()');
    const end = operator.indexOf('**CRITICAL TASK CREATION RULES:**', start);
    return operator.slice(start, end);
  })();

  for (const [name, text] of [['served PERSONALITY_DEFAULTS', served], ['inline fallback', inline]] as const) {
    it(`${name}: lists the three tools, routes review vs decision, and forbids deciding on the model's own judgement`, () => {
      expect(text).toMatch(/- autopilot_review_execution: Show a Dev Autopilot execution that is held for approval/);
      expect(text).toMatch(/- autopilot_approve_execution: Approve a held execution — opens the real pull request/);
      expect(text).toMatch(/- autopilot_reject_execution: Reject a held execution — deletes the pushed branch/);
      expect(text).toMatch(/what is waiting for my approval\?[^\n]*→ call autopilot_review_execution/);
      expect(text).toMatch(/An explicit decision on a held execution the user names[^\n]*→ call autopilot_approve_execution or autopilot_reject_execution/);
      expect(text).toMatch(/they never start work/);
      expect(text).toMatch(/Never approve or reject on your own judgement of the diff, never guess which execution they mean \(list them and ask\)/);
    });
  }

  it('the execution-rules block is still byte-identical across both sources', () => {
    const extract = (text: string) => {
      const start = text.indexOf('**CRITICAL EXECUTION RULES');
      const end = text.indexOf('**CRITICAL TASK CREATION RULES:**', start);
      return text.slice(start, end).trim();
    };
    const inlineFull = operator.slice(operator.indexOf('function getOperatorSystemPrompt()'));
    expect(extract(served)).toBe(extract(inlineFull));
    expect(extract(served)).toContain('autopilot_review_execution / autopilot_approve_execution / autopilot_reject_execution act on executions the agent has already run and HELD');
  });
});

describe('VTID-04030 caller gate (VTID-03851) runs before any read', () => {
  it('refuses an anonymous thread and a non-admin thread, naming the tool, without touching Supabase', async () => {
    const anon = await executeReviewExecution({}, ANON, { s: S });
    expect(anon.ok).toBe(false);
    expect(anon.error).toMatch(/autopilot_review_execution requires an authenticated session/);
    expect(anon.error).toMatch(/nothing was changed/);
    const user = await executeApproveExecution({ execution_id: EXEC_A }, NONADMIN, { s: S });
    expect(user.error).toMatch(/autopilot_approve_execution requires an exafy_admin session/);
    const rej = await executeRejectExecution({ execution_id: EXEC_A }, ANON, { s: S });
    expect(rej.error).toMatch(/autopilot_reject_execution requires an authenticated session/);
    expect(mockedSupa).not.toHaveBeenCalled();
  });

  it('derives the actor from the verified identity, never from the model', () => {
    const z = authorizeApprovalTool('autopilot_approve_execution', ADMIN);
    expect(z).toEqual({ ok: true, actor: 'operator-chat:u-admin' });
  });

  it('reports an unconfigured Supabase instead of throwing', async () => {
    const r = await executeReviewExecution({}, ADMIN); // deps.s undefined → getSupabase() mocked to null
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Supabase not configured/);
  });
});

describe('VTID-04030 resolveExecutionId', () => {
  it('accepts a full UUID without a lookup, resolves a unique prefix among awaiting rows only, refuses none/ambiguous/short', async () => {
    expect(await resolveExecutionId(S, EXEC_A.toUpperCase())).toEqual({ ok: true, id: EXEC_A });
    expect(mockedSupa).not.toHaveBeenCalled();

    wireSupa([row(EXEC_A), row(EXEC_B)]);
    expect(await resolveExecutionId(S, '4f7d5ea4')).toEqual({ ok: true, id: EXEC_A });
    expect(mockedSupa.mock.calls[0][1]).toMatch(/status=eq\.awaiting_approval/);

    const amb = await resolveExecutionId(S, '4f7d5e');
    expect(amb.ok).toBe(false);
    expect((amb as { error: string }).error).toMatch(/ambiguous — it matches 2 executions/);

    const none = await resolveExecutionId(S, 'deadbeef');
    expect((none as { error: string }).error).toMatch(/no execution awaiting approval starts with "deadbeef"/);

    const short = await resolveExecutionId(S, '4f7d');
    expect((short as { error: string }).error).toMatch(new RegExp(`at least ${EXECUTION_ID_MIN_PREFIX} hex characters`));
    expect((await resolveExecutionId(S, '')).ok).toBe(false);
    expect((await resolveExecutionId(S, 'not hex!')).ok).toBe(false);
  });
});

describe('VTID-04030 review', () => {
  it('with no id lists what is waiting, with the VTID resolved through the finding and the preview summarised', async () => {
    wireSupa([row(EXEC_A), row(EXEC_B, { metadata: null })], [{ id: `f-${EXEC_A.slice(0, 8)}`, activated_vtid: 'VTID-04100' }]);
    const r = await executeReviewExecution({}, ADMIN, { s: S });
    expect(r.ok).toBe(true);
    const d = r.data as { count: number; waiting: Array<Record<string, unknown>>; message: string };
    expect(d.count).toBe(2);
    expect(d.waiting[0]).toMatchObject({ execution_id: EXEC_A, execution_short: '4f7d5ea4', vtid: 'VTID-04100', branch: PENDING.branch, pr_title: PENDING.pr_title, files_total: 70 });
    expect(d.waiting[1]).toMatchObject({ execution_id: EXEC_B, vtid: null, branch: null, pr_title: null });
    expect(d.message).toMatch(/2 execution\(s\) waiting/);
    expect(mockedSupa.mock.calls[1][1]).toMatch(/autopilot_recommendations\?id=in\.\(/);
  });

  it('with no id and nothing waiting says so', async () => {
    wireSupa([]);
    const r = await executeReviewExecution({ execution_id: '   ' }, ADMIN, { s: S });
    expect(r.data).toMatchObject({ count: 0, waiting: [], message: expect.stringMatching(/No Dev Autopilot execution is waiting/) });
  });

  it('with an id returns the stored preview bounded for the model (patch, body, file list)', async () => {
    const getPending = jest.fn(async () => ({ ok: true, status: 'awaiting_approval', pending: PENDING }));
    const r = await executeReviewExecution({ execution_id: EXEC_A }, ADMIN, { s: S, getPending });
    expect(getPending).toHaveBeenCalledWith(EXEC_A, S);
    expect(r.ok).toBe(true);
    const d = r.data as Record<string, any>;
    expect(d).toMatchObject({ execution_id: EXEC_A, awaiting_approval: true, branch: PENDING.branch, pr_title: PENDING.pr_title, files_total: 70, patch_chars_total: REVIEW_PATCH_MAX_CHARS + 500, patch_truncated: true, pr_body_truncated: true });
    expect(d.patch.length).toBe(REVIEW_PATCH_MAX_CHARS);
    expect(d.files.length).toBe(REVIEW_FILES_MAX);
    expect(d.message).toMatch(/only on the user's explicit decision/);
  });

  it('with an id that is no longer held reports the status instead of a preview; a missing row is an error', async () => {
    const getPending = jest.fn(async () => ({ ok: true, status: 'ci', pending: PENDING }));
    const r = await executeReviewExecution({ execution_id: EXEC_A }, ADMIN, { s: S, getPending });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ status: 'ci', awaiting_approval: false, message: expect.stringMatching(/is ci, not awaiting_approval/) });
    const missing = await executeReviewExecution({ execution_id: EXEC_A }, ADMIN, { s: S, getPending: jest.fn(async () => ({ ok: false, error: 'execution not found' })) });
    expect(missing).toEqual({ ok: false, error: 'execution not found' });
  });
});

describe('VTID-04030 approve / reject', () => {
  it('approve resolves the prefix, hands the verified actor to approveExecution and reports the PR', async () => {
    wireSupa([row(EXEC_A)]);
    const approve = jest.fn(async () => ({ ok: true, pr_url: 'https://github.com/exafyltd/vitana-platform/pull/3400', pr_number: 3400 }));
    const r = await executeApproveExecution({ execution_id: '4f7d5ea4' }, ADMIN, { s: S, approve });
    expect(approve).toHaveBeenCalledWith(EXEC_A, 'operator-chat:u-admin');
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ execution_id: EXEC_A, status: 'ci', pr_number: 3400, approved_by: 'operator-chat:u-admin', message: expect.stringMatching(/PR #3400 opened/) });
  });

  it('approve passes the VTID-04029 refusal through and never claims success', async () => {
    const approve = jest.fn(async () => ({ ok: false, error: 'execution is ci, not awaiting_approval' }));
    const r = await executeApproveExecution({ execution_id: EXEC_A }, ADMIN, { s: S, approve });
    expect(r).toEqual({ ok: false, error: 'approve failed: execution is ci, not awaiting_approval' });
    expect((await executeApproveExecution({ execution_id: '' }, ADMIN, { s: S, approve })).error).toMatch(/execution_id is required/);
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it('reject hands actor + trimmed reason (≤ 500 chars) to rejectExecution and reports the branch outcome', async () => {
    const reject = jest.fn(async () => ({ ok: true, branch_deleted: true }));
    const long = 'wrong approach '.repeat(60);
    const r = await executeRejectExecution({ execution_id: EXEC_A, reason: `  ${long}  ` }, ADMIN, { s: S, reject });
    expect(reject).toHaveBeenCalledWith(EXEC_A, 'operator-chat:u-admin', long.trim().slice(0, 500));
    expect(r.data).toMatchObject({ status: 'cancelled', branch_deleted: true, rejected_by: 'operator-chat:u-admin', message: expect.stringMatching(/its branch was deleted/) });

    const reject2 = jest.fn(async () => ({ ok: true, branch_deleted: false }));
    const r2 = await executeRejectExecution({ execution_id: EXEC_A }, ADMIN, { s: S, reject: reject2 });
    expect(reject2).toHaveBeenCalledWith(EXEC_A, 'operator-chat:u-admin', undefined);
    expect((r2.data as { reason: unknown; message: string }).reason).toBeNull();
    expect((r2.data as { message: string }).message).toMatch(/branch deletion did not succeed/);

    const r3 = await executeRejectExecution({ execution_id: EXEC_A }, ADMIN, { s: S, reject: jest.fn(async () => ({ ok: false, error: 'execution not found' })) });
    expect(r3).toEqual({ ok: false, error: 'reject failed: execution not found' });
  });
});
