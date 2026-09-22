/**
 * VTID-04293 — approveAutoExecute refuses a finding that already owns a live
 * execution, awaiting_approval included.
 *
 * Staging 2026-09-22, after VTID-04280 unstuck planning: the impact pass of
 * autoApproveTick has no in-flight check of its own and the partial unique
 * index excludes awaiting_approval, so finding b560c306 was approved at
 * 21:03, 21:09 and 21:24 — three agent runs for one finding.
 */
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async () => ({ ok: true })),
}));

import * as fs from 'fs';
import * as path from 'path';
import { approveAutoExecute } from '../src/services/dev-autopilot-execute';
import {
  INFLIGHT_EXECUTION_STATUSES,
  INFLIGHT_EXECUTION_FILTER,
} from '../src/services/dev-autopilot-pipeline-guards';

const FINDING = 'b560c306-0e05-4698-b909-0a25df8abff2';
const calls: string[] = [];

function mockFetch(inflight: Array<{ id: string; status: string }>, inflightOk = true) {
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
    calls.push(url);
    let body: unknown = [];
    let ok = true;
    if (url.includes('/autopilot_recommendations?id=eq.')) {
      body = [{ id: FINDING, risk_class: 'low', source_type: 'dev_autopilot_impact', source_ref: null, spec_snapshot: {}, status: 'new' }];
    } else if (url.includes('/dev_autopilot_executions?') && url.includes('status=in.(cooling')) {
      body = inflight;
      ok = inflightOk;
    }
    return {
      ok, status: ok ? 200 : 500,
      json: async () => body, text: async () => (ok ? JSON.stringify(body) : 'boom'),
      headers: { get: () => null },
    } as unknown as Response;
  });
}

beforeEach(() => {
  calls.length = 0;
  process.env.SUPABASE_URL = 'https://supa.test';
  process.env.SUPABASE_SERVICE_ROLE = 'svc';
});

describe('VTID-04293 in-flight guard', () => {
  it('covers awaiting_approval and every status the unique index covers', () => {
    expect(INFLIGHT_EXECUTION_STATUSES).toEqual(
      expect.arrayContaining(['cooling', 'running', 'awaiting_approval', 'ci', 'merging', 'deploying', 'verifying']),
    );
    expect(INFLIGHT_EXECUTION_FILTER).toBe('&status=in.(cooling,running,awaiting_approval,ci,merging,deploying,verifying)');
  });

  it('refuses when the finding has an execution awaiting approval', async () => {
    mockFetch([{ id: '257ba366-0000-0000-0000-000000000000', status: 'awaiting_approval' }]);
    const r = await approveAutoExecute({ finding_id: FINDING });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already has execution 257ba366 \(status=awaiting_approval\)/);
    expect(calls.some((u) => u.includes('/dev_autopilot_plan_versions'))).toBe(false);
    expect(calls.some((u) => u.includes('/dev_autopilot_executions') && !u.includes('select=id,status') && !u.includes('pr_url=not.is.null'))).toBe(false);
  });

  it('refuses when the lookup itself fails (never approve blind)', async () => {
    mockFetch([], false);
    const r = await approveAutoExecute({ finding_id: FINDING });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/in-flight execution lookup failed/);
  });

  it('proceeds past the guard when nothing is in flight', async () => {
    mockFetch([]);
    const r = await approveAutoExecute({ finding_id: FINDING });
    // No plan in the mock, so the next gate is the one that answers.
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/plan version required/);
  });
});

describe('VTID-04293 wiring (source contract)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/services/dev-autopilot-execute.ts'), 'utf8');
  it('approveAutoExecute checks in-flight executions before loading the plan', () => {
    const fn = src.slice(src.indexOf('export async function approveAutoExecute('));
    const guard = fn.indexOf('+ INFLIGHT_EXECUTION_FILTER');
    const plan = fn.indexOf('// 2. Load latest plan version');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(plan);
  });
});
