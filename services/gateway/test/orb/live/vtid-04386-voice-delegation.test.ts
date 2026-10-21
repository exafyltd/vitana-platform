/**
 * VTID-04386 — voice delegation through the orchestrator dispatcher
 * (docs/ORCHESTRATOR-REDESIGN-PLAN.md §5 P3 exit criteria).
 *
 * AC-1 the Command Hub voice catalog declares operator_delegate once plus
 *      get_delegation_result and cancel_delegation; community and commerce
 *      catalogs declare none of them.
 * AC-2 operator_delegate answers inside the voice ack window: a slow Operator
 *      turn returns `working` with a job id at once instead of blocking.
 * AC-3 get_delegation_result returns the result on a later turn (by id, or
 *      the latest job with no id); cancel_delegation stops it and the late
 *      result is never reported.
 * AC-4 a result is never readable from another surface or by another user.
 * AC-5 role: an exafy_admin in the Command Hub is the developer role for
 *      policy; a non-admin there is refused by policy; outside the Command
 *      Hub operator_delegate is refused.
 * AC-6 orb-live dispatches all three names to the new module, and the
 *      Command Hub prompt tells the model to fetch and cancel.
 */

import * as fs from 'fs';
import * as path from 'path';

let release: ((v: unknown) => void) | null = null;
jest.mock('../../../src/orb/live/tools/operator-delegate', () => {
  const actual = jest.requireActual('../../../src/orb/live/tools/operator-delegate');
  return {
    ...actual,
    runOperatorDelegate: jest.fn(() => new Promise((res) => { release = (v) => res(v); })),
  };
});

import { buildLiveApiTools } from '../../../src/orb/live/tools/live-tool-catalog';
import {
  callerFromSession,
  runCancelDelegation,
  runGetDelegationResult,
  runOperatorDelegateAsync,
} from '../../../src/orb/live/tools/delegation-tools';
import { resetDelegationJobs, ACK_WINDOW_MS } from '../../../src/services/orchestrator/dispatcher';

const ADMIN = { user_id: 'u-admin', exafy_admin: true, tenant_id: 't' };
const hubSession = (o: Record<string, unknown> = {}) => ({ sessionId: 's1', current_route: '/command-hub/operator', identity: ADMIN, active_role: 'community', ...o });

function names(tools: object[]): string[] {
  return (tools as Array<{ function_declarations?: Array<{ name: string }> }>)
    .flatMap((g) => (g.function_declarations || []).map((d) => d.name));
}

const flush = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  resetDelegationJobs();
  release = null;
});

describe('catalog (AC-1)', () => {
  test('command hub declares the three delegation tools once each', () => {
    const hub = names(buildLiveApiTools('authenticated', '/command-hub/operator', 'developer'));
    for (const n of ['operator_delegate', 'get_delegation_result', 'cancel_delegation']) {
      expect(hub.filter((x) => x === n)).toHaveLength(1);
    }
  });

  test('community and commerce catalogs have none of them', () => {
    for (const route of ['/home', '/business/orders']) {
      const n = names(buildLiveApiTools('authenticated', route, 'community'));
      expect(n).not.toEqual(expect.arrayContaining(['get_delegation_result']));
      expect(n).not.toContain('cancel_delegation');
      expect(n).not.toContain('operator_delegate');
    }
  });
});

describe('async operator_delegate (AC-2, AC-3)', () => {
  test('a slow operator turn returns working at once, result on a later turn', async () => {
    const t0 = Date.now();
    const first = await runOperatorDelegateAsync(hubSession(), { request: 'status of VTID-1' });
    expect(Date.now() - t0).toBeLessThan(ACK_WINDOW_MS.voice + 1000);
    const body = JSON.parse(first.result);
    expect(body).toMatchObject({ status: 'working', job_id: expect.any(String) });

    expect(JSON.parse((await runGetDelegationResult(hubSession(), { job_id: body.job_id })).result)).toMatchObject({ status: 'running' });
    release!({ success: true, result: JSON.stringify({ operator_reply: 'VTID-1 is done' }) });
    await flush();
    const later = JSON.parse((await runGetDelegationResult(hubSession(), {})).result);
    expect(later).toMatchObject({ status: 'succeeded', result: { operator_reply: 'VTID-1 is done' } });
  }, 10000);

  test('cancel_delegation stops it and the late result is never reported', async () => {
    const body = JSON.parse((await runOperatorDelegateAsync(hubSession(), { request: 'fix it' })).result);
    expect(runCancelDelegation(hubSession(), {}).success).toBe(true);
    release!({ success: true, result: '{"operator_reply":"late"}' });
    await flush();
    expect(JSON.parse((await runGetDelegationResult(hubSession(), { job_id: body.job_id })).result)).toMatchObject({ status: 'cancelled', result: null });
  }, 10000);
});

describe('isolation (AC-4)', () => {
  test('another surface or user cannot read the job', async () => {
    const body = JSON.parse((await runOperatorDelegateAsync(hubSession(), { request: 'x' })).result);
    expect((await runGetDelegationResult({ sessionId: 's9', current_route: '/home', identity: ADMIN }, { job_id: body.job_id })).success).toBe(false);
    expect((await runGetDelegationResult(hubSession({ identity: { ...ADMIN, user_id: 'other' } }), { job_id: body.job_id })).success).toBe(false);
    expect(runCancelDelegation({ sessionId: 's9', current_route: '/home', identity: ADMIN }, { job_id: body.job_id }).success).toBe(false);
  }, 10000);
});

describe('role resolution (AC-5)', () => {
  test('exafy_admin in the command hub is the developer role', () => {
    expect(callerFromSession(hubSession())).toMatchObject({ platform_role: 'developer', surface: 'command-hub', channel: 'voice' });
    expect(callerFromSession({ sessionId: 's', current_route: '/home', identity: ADMIN, active_role: 'community' }).platform_role).toBe('community');
  });

  test('a non-admin in the command hub is refused by policy; outside it the tool is refused', async () => {
    const r = await runOperatorDelegateAsync(hubSession({ identity: { user_id: 'u2', exafy_admin: false } }), { request: 'x' });
    expect(r.success).toBe(false);
    const r2 = await runOperatorDelegateAsync({ sessionId: 's', current_route: '/home', identity: ADMIN }, { request: 'x' });
    expect(r2).toMatchObject({ success: false, error: expect.stringMatching(/only available in the Command Hub/) });
  });
});

describe('wiring (AC-6)', () => {
  const orbLive = fs.readFileSync(path.join(__dirname, '../../../src/routes/orb-live.ts'), 'utf8');
  test('orb-live dispatches all three names to the delegation module', () => {
    for (const [name, fn] of [['operator_delegate', 'runOperatorDelegateAsync'], ['get_delegation_result', 'runGetDelegationResult'], ['cancel_delegation', 'runCancelDelegation']]) {
      const at = orbLive.indexOf(`case '${name}':`);
      expect(at).toBeGreaterThan(-1);
      expect(orbLive.slice(at, at + 400)).toContain(fn);
    }
  });

  test('the command hub prompt tells the model to fetch and cancel', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/services/ai-personality-service.ts'), 'utf8');
    expect(src).toContain('call get_delegation_result when the developer asks');
    expect(src).toContain('cancel_delegation if they say to stop it');
  });
});
