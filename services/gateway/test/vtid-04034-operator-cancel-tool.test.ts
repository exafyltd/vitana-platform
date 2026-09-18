/**
 * VTID-04034 (W4j): the Operator Console cancels a queued or running Dev
 * Autopilot execution from chat.
 *
 * Pinned here: the tool declaration (registry + operator wire schema +
 * dispatch), both prompt sources under the VTID-03838 drift rule, the
 * VTID-03851 caller gate running before any Supabase read, prefix
 * resolution among cooling/running rows only, the no-id listing being
 * read-only, and that the cancel hands the verified actor + trimmed reason
 * to VTID-04032's cancelExecution and reports its outcome honestly.
 */

import * as fs from 'fs';
import * as path from 'path';

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../src/services/dev-autopilot-execute', () => {
  const actual = jest.requireActual('../src/services/dev-autopilot-execute');
  return { ...actual, getSupabase: jest.fn(() => null), supa: jest.fn(), cancelExecution: jest.fn() };
});

import { supa, cancelExecution } from '../src/services/dev-autopilot-execute';
import { setThreadAuth, clearThreadAuth } from '../src/services/operator-execute-authz';
import { getToolByName } from '../src/services/tool-registry';
import {
  executeCancelExecution,
  resolveCancellableExecutionId,
  listCancellable,
  CANCEL_LIST_MAX,
} from '../src/services/operator-cancel-tool';

const mockedSupa = supa as jest.Mock;
const mockedCancel = cancelExecution as jest.Mock;

const SRC = path.resolve(__dirname, '../src/services');
const personality = fs.readFileSync(path.join(SRC, 'ai-personality-service.ts'), 'utf8');
const operator = fs.readFileSync(path.join(SRC, 'gemini-operator.ts'), 'utf8');

const S = { url: 'https://supa.test', key: 'k' };
const EXEC_A = '9a4d2c7e-1111-4222-8333-444444444444';
const EXEC_B = '9a4d2c99-1111-4222-8333-555555555555';
const ADMIN = 't-admin';
const ANON = 't-anon';
const NONADMIN = 't-user';

function row(id: string, status: string, extra: Record<string, unknown> = {}) {
  return { id, status, branch: null, finding_id: `f-${id.slice(0, 8)}`, created_at: '2026-09-18T00:00:00.000Z', updated_at: '2026-09-18T00:05:00.000Z', self_healing_vtid: 'VTID-04008', metadata: { executor: 'agent', claimed_env: 'staging', ecs_task_arn: 'arn:aws:ecs:eu-central-1:1:task/Vitana-ECS-Cluster/abc123' }, ...extra };
}

function wireSupa(rows: unknown[]) {
  mockedSupa.mockImplementation(async (_s: unknown, p: string) => {
    if (p.startsWith('/rest/v1/dev_autopilot_executions?status=in.(cooling,running)')) return { ok: true, status: 200, data: rows };
    return { ok: false, status: 404, error: `unexpected ${p}` };
  });
}

beforeEach(() => {
  mockedSupa.mockReset();
  mockedCancel.mockReset();
  setThreadAuth(ADMIN, { user_id: 'u-admin', exafy_admin: true });
  setThreadAuth(NONADMIN, { user_id: 'u-1', exafy_admin: false });
  clearThreadAuth(ANON);
});

describe('VTID-04034 tool declaration', () => {
  it('registry: optional id + reason, VTID-04034, operator/admin/developer, in the Supabase health list', () => {
    const t = getToolByName('autopilot_cancel_execution')!;
    expect(t).toBeTruthy();
    expect(t.vtid).toBe('VTID-04034');
    expect(t.parameters_schema.required).toEqual([]);
    expect(Object.keys(t.parameters_schema.properties)).toEqual(['execution_id', 'reason']);
    expect(t.allowed_roles).toEqual(['operator', 'admin', 'developer']);
    const registry = fs.readFileSync(path.join(SRC, 'tool-registry.ts'), 'utf8');
    expect(registry).toMatch(/const supabaseTools = \[[^\]]*'autopilot_cancel_execution'/);
  });

  it('operator wire schema: declared after reject, before get_status, and dispatched to executeCancelExecution', () => {
    const start = operator.indexOf("name: 'autopilot_cancel_execution'");
    expect(start).toBeGreaterThan(operator.indexOf("name: 'autopilot_reject_execution'"));
    expect(start).toBeLessThan(operator.indexOf("name: 'autopilot_get_status'"));
    const block = operator.slice(start, operator.indexOf("name: 'autopilot_get_status'"));
    expect(block).toContain('required: []');
    expect(operator).toMatch(/case 'autopilot_cancel_execution':\s*\n\s*result = await executeCancelExecution\(/);
    expect(operator).toMatch(/import \{ executeCancelExecution \} from '\.\/operator-cancel-tool';/);
  });
});

describe('VTID-04034 both operator prompt sources describe the tool (VTID-03838 drift rule)', () => {
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
    it(`${name}: lists the tool, routes stop/cancel requests to it, and forbids cancelling on the model's own judgement`, () => {
      expect(text).toMatch(/- autopilot_cancel_execution: Cancel a queued \(cooling\) or RUNNING execution — the agent is stopped, nothing is pushed or opened/);
      expect(text).toMatch(/A request to stop\/cancel\/abort a queued or running execution[^\n]*→ call autopilot_cancel_execution \(with no id to list, with the id they name to cancel\)/);
      expect(text).toMatch(/autopilot_cancel_execution stops an execution that is still cooling or running \(not a held one — that is reject\)/);
      expect(text).toMatch(/Never cancel on your own judgement, never guess which execution they mean \(list them and ask\)/);
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
    expect(extract(served)).toContain('autopilot_cancel_execution stops an execution that is still cooling or running');
  });
});

describe('VTID-04034 caller gate (VTID-03851) runs before any read', () => {
  it('refuses an anonymous thread and a non-admin thread, naming the tool, without touching Supabase or cancelling', async () => {
    const anon = await executeCancelExecution({}, ANON, { s: S });
    expect(anon.ok).toBe(false);
    expect(anon.error).toMatch(/autopilot_cancel_execution requires an authenticated session/);
    expect(anon.error).toMatch(/nothing was changed/);
    const user = await executeCancelExecution({ execution_id: EXEC_A }, NONADMIN, { s: S });
    expect(user.error).toMatch(/autopilot_cancel_execution requires an exafy_admin session/);
    expect(mockedSupa).not.toHaveBeenCalled();
    expect(mockedCancel).not.toHaveBeenCalled();
  });

  it('an unconfigured Supabase is an error, not a throw', async () => {
    const r = await executeCancelExecution({ execution_id: EXEC_A }, ADMIN, { s: null });
    expect(r).toEqual({ ok: false, error: 'Supabase not configured — cannot cancel.' });
  });
});

describe('VTID-04034 id resolution among cancellable rows only', () => {
  it('a full UUID needs no lookup; a unique prefix resolves; none / ambiguous / too short / non-hex are named refusals', async () => {
    wireSupa([row(EXEC_A, 'running'), row(EXEC_B, 'cooling')]);
    expect(await resolveCancellableExecutionId(S, EXEC_A.toUpperCase())).toEqual({ ok: true, id: EXEC_A });
    expect(mockedSupa).not.toHaveBeenCalled();
    expect(await resolveCancellableExecutionId(S, '9a4d2c7e')).toEqual({ ok: true, id: EXEC_A });
    const none = await resolveCancellableExecutionId(S, 'ffffff');
    expect(none.ok).toBe(false);
    expect((none as { error: string }).error).toMatch(/no cooling\/running execution starts with "ffffff"/);
    const amb = await resolveCancellableExecutionId(S, '9a4d2c');
    expect((amb as { error: string }).error).toMatch(/ambiguous — it matches 2 cancellable executions/);
    const short = await resolveCancellableExecutionId(S, '9a4d');
    expect((short as { error: string }).error).toMatch(/too short to resolve as a prefix/);
    const nonhex = await resolveCancellableExecutionId(S, 'run-1');
    expect(nonhex.ok).toBe(false);
  });

  it('lists only cooling/running rows, newest first, bounded', async () => {
    wireSupa([row(EXEC_A, 'running')]);
    const r = await listCancellable(S);
    expect(r.ok).toBe(true);
    expect(mockedSupa.mock.calls[0][1]).toContain(`status=in.(cooling,running)`);
    expect(mockedSupa.mock.calls[0][1]).toContain(`order=updated_at.desc&limit=${CANCEL_LIST_MAX}`);
  });
});

describe('VTID-04034 executeCancelExecution', () => {
  it('no id → the cancellable list, read-only, and a "nothing to cancel" message when empty', async () => {
    wireSupa([row(EXEC_A, 'running'), row(EXEC_B, 'cooling', { metadata: { executor: 'agent' } })]);
    const r = await executeCancelExecution({}, ADMIN, { s: S });
    expect(r.ok).toBe(true);
    expect(r.data!.count).toBe(2);
    const list = r.data!.cancellable as Array<Record<string, unknown>>;
    expect(list[0]).toMatchObject({ execution_short: '9a4d2c7e', status: 'running', vtid: 'VTID-04008', executor: 'agent', claimed_env: 'staging', ecs_task: 'abc123' });
    expect(list[1]).toMatchObject({ execution_short: '9a4d2c99', status: 'cooling', ecs_task: null });
    expect(String(r.data!.message)).toMatch(/nothing was cancelled/);
    expect(mockedCancel).not.toHaveBeenCalled();

    wireSupa([]);
    const empty = await executeCancelExecution({ execution_id: '   ' }, ADMIN, { s: S });
    expect(empty.ok).toBe(true);
    expect(empty.data!.count).toBe(0);
    expect(String(empty.data!.message)).toMatch(/no execution to cancel/);
  });

  it('with an id: hands the resolved id, the verified actor and the trimmed reason to cancelExecution and reports a stopped running run', async () => {
    wireSupa([row(EXEC_A, 'running')]);
    mockedCancel.mockResolvedValue({ ok: true, was: 'running', ecs_task_stopped: true });
    const r = await executeCancelExecution({ execution_id: '9a4d2c7e', reason: '  wrong file  ' + 'x'.repeat(600) }, ADMIN, { s: S });
    expect(mockedCancel).toHaveBeenCalledTimes(1);
    const [id, opts] = mockedCancel.mock.calls[0];
    expect(id).toBe(EXEC_A);
    expect(opts.actor).toBe('operator-chat:u-admin');
    expect(opts.reason).toHaveLength(500);
    expect(opts.reason.startsWith('wrong file')).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ execution_id: EXEC_A, status: 'cancelled', was: 'running', ecs_task_stopped: true, cancelled_by: 'operator-chat:u-admin' });
    expect(String(r.data!.message)).toMatch(/Its ECS task was stopped/);
  });

  it('a refused StopTask is reported, not hidden; a cooling cancel carries no task note; no reason → undefined', async () => {
    mockedCancel.mockResolvedValueOnce({ ok: true, was: 'running', ecs_task_stopped: false, ecs_task_error: 'AccessDeniedException: ecs:StopTask' });
    const r1 = await executeCancelExecution({ execution_id: EXEC_A, reason: '' }, ADMIN, { s: S });
    expect(mockedCancel.mock.calls[0][1].reason).toBeUndefined();
    expect(String(r1.data!.message)).toMatch(/Stopping its ECS task was refused \(AccessDeniedException: ecs:StopTask\); the agent stops itself at its next turn boundary/);
    expect(r1.data!.ecs_task_error).toBe('AccessDeniedException: ecs:StopTask');

    mockedCancel.mockResolvedValueOnce({ ok: true, was: 'cooling' });
    const r2 = await executeCancelExecution({ execution_id: EXEC_B }, ADMIN, { s: S });
    expect(String(r2.data!.message)).toBe(`Cancelled — execution 9a4d2c99 (was cooling). Nothing will be pushed or opened for it.`);
    expect(mockedSupa).not.toHaveBeenCalled(); // full UUIDs never list
  });

  it('a refusal from cancelExecution (wrong status, missing row) is passed through as an error, never success', async () => {
    mockedCancel.mockResolvedValueOnce({ ok: false, error: 'execution is ci, only cooling/running can be cancelled' });
    const r = await executeCancelExecution({ execution_id: EXEC_A }, ADMIN, { s: S });
    expect(r).toEqual({ ok: false, error: 'cancel failed: execution is ci, only cooling/running can be cancelled' });
    mockedCancel.mockResolvedValueOnce({ ok: false, error: 'execution not found' });
    const r2 = await executeCancelExecution({ execution_id: EXEC_B }, ADMIN, { s: S });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/execution not found/);
  });
});
