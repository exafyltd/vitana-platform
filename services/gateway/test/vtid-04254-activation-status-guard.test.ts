/**
 * VTID-04254 — a confirmed defect in the platform's own Dev Autopilot
 * activation machinery, found live and fixed the same session under the
 * new standing rule (CLAUDE.md, "Autonomous Defect-Fix Authority"): a
 * defect in the self-healing/self-improvement pipeline itself is fixed
 * immediately, never filed as an optional ticket.
 *
 * THE BUG, reproduced live 2026-09-22 against finding 9e1bdb97-d4ec-449d-
 * a00b-5ec70428cada ("CVE: package.json") via the Operator Console:
 *
 *   1. `activate_autopilot_recommendation` RPC flips the finding
 *      new -> activated and allocates VTID-04250.
 *   2. `bridgeActivationToExecution()` (dev-autopilot-execute.ts) then
 *      calls `approveAutoExecute({ finding_id })`, which RE-READS the
 *      finding's status and refused anything but 'new' — rejecting the
 *      write step 1 had JUST made, every single time, on both
 *      human-facing activation paths (the Command Hub button and the
 *      Operator Console's `autopilot_activate_recommendation` tool).
 *      Verbatim error returned live: "finding status is 'activated' —
 *      only 'new' findings can be approved".
 *   3. Both callers additionally gated their ENTIRE bridge attempt on
 *      `!response.already_activated`, so a second "Activate" click on the
 *      now-stranded finding never even retried — it silently reported
 *      "Already activated as VTID-04250." forever.
 *
 * THE FIX:
 *   - `approveAutoExecute()` gains `input.alsoAllowStatus` (mirrors the
 *     existing `allowManualSourceTypes` caller-scoped opt-in shape).
 *     `bridgeActivationToExecution()` is the only caller that sets it, to
 *     'activated' — the exact status its own step 1 just wrote.
 *     `autoApproveTick()` never sets it and is unaffected: it approves
 *     straight from a `status=eq.new` query with no pre-activation step.
 *   - Both human-facing callers now retry the bridge on EVERY call, not
 *     only the first — `bridgeActivationToExecution()`'s own inflight
 *     check (dev_autopilot_executions status in cooling/running/…) already
 *     makes a repeat call a safe no-op once an execution exists, so this
 *     is what actually recovers a stranded finding instead of leaving it
 *     stuck at status='activated' forever.
 */

import fs from 'fs';
import path from 'path';

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../src/services/dev-autopilot-outcomes', () => ({
  recordOutcome: jest.fn().mockResolvedValue(undefined),
  recordExecOutcome: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/dev-autopilot-self-heal-log', () => ({
  writeAutopilotFailure: jest.fn().mockResolvedValue(undefined),
  writeAutopilotSuccess: jest.fn().mockResolvedValue(undefined),
}));

import { approveAutoExecute, bridgeActivationToExecution } from '../src/services/dev-autopilot-execute';

type FetchMock = jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_SUPABASE_URL = process.env.SUPABASE_URL;
const ORIGINAL_SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

const FINDING_ID = '9e1bdb97-d4ec-449d-a00b-5ec70428cada'; // the real finding this reproduces against
const TEST_FILE = 'services/gateway/test/task-title.test.ts';
const OUT_OF_SCOPE_FILE = 'services/gateway/src/utils/task-title.ts';

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

/** A finding at the given status, with everything else needed for approveAutoExecute /
 *  bridgeActivationToExecution to reach the status guard and (if it passes) actually
 *  create an execution row. */
function routeFetch(fetchMock: FetchMock, opts: { status: string; sourceType?: string }) {
  const planFiles = [OUT_OF_SCOPE_FILE, TEST_FILE];
  const planMarkdown = ['## Files to modify', ...planFiles.map((f) => `- ${f}`), ''].join('\n');
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    if (url.includes(`/rest/v1/autopilot_recommendations?id=eq.${FINDING_ID}`) && method === 'GET') {
      return mockResponse([{
        id: FINDING_ID,
        risk_class: 'low',
        source_type: opts.sourceType ?? 'dev_autopilot',
        source_ref: null,
        spec_snapshot: { scanner: 'safety-gap-scanner-v1' },
        status: opts.status,
      }]);
    }
    if (url.includes('/rest/v1/dev_autopilot_executions?finding_id=eq.') && url.includes('status=in.')) {
      return mockResponse([]); // no in-flight / stranded execution
    }
    if (url.includes('/rest/v1/dev_autopilot_plan_versions?finding_id=eq.')) {
      return mockResponse([{ version: 1, files_referenced: planFiles, plan_markdown: planMarkdown }]);
    }
    if (url.includes('/rest/v1/dev_autopilot_config?id=eq.1')) {
      return mockResponse([{
        kill_switch: false,
        daily_budget: 500,
        concurrency_cap: 4,
        max_auto_fix_depth: 2,
        cooldown_minutes: 0,
        allow_scope: ['services/gateway/src/**', 'services/gateway/test/**'],
        deny_scope: ['supabase/migrations/**', '**/auth*'],
      }]);
    }
    if (url.includes('/rest/v1/dev_autopilot_executions?approved_at=gte.')) {
      return mockResponse([]);
    }
    if (url.endsWith('/rest/v1/dev_autopilot_executions') && method === 'POST') {
      return mockResponse([{ id: 'e4444444-4444-4444-4444-444444444444' }], 201);
    }
    if (url.includes('/rest/v1/dev_autopilot_executions?id=eq.') && method === 'PATCH') {
      return mockResponse(null, 204); // the execute_after=now patch
    }
    return mockResponse({ error: `unexpected ${method} ${url}` }, 404);
  });
}

describe('approveAutoExecute — the status guard (VTID-04254)', () => {
  let fetchMock: FetchMock;

  beforeAll(() => {
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE = 'test_service_role_key';
  });

  afterAll(() => {
    if (ORIGINAL_SUPABASE_URL === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = ORIGINAL_SUPABASE_URL;
    if (ORIGINAL_SUPABASE_SERVICE_ROLE === undefined) delete process.env.SUPABASE_SERVICE_ROLE;
    else process.env.SUPABASE_SERVICE_ROLE = ORIGINAL_SUPABASE_SERVICE_ROLE;
    global.fetch = ORIGINAL_FETCH;
  });

  beforeEach(() => {
    fetchMock = jest.fn() as FetchMock;
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('still rejects status="activated" when the caller does not opt in — this is autoApproveTick\'s unchanged behavior', async () => {
    routeFetch(fetchMock, { status: 'activated' });
    const r = await approveAutoExecute({ finding_id: FINDING_ID });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/finding status is 'activated' — only 'new' findings can be approved/);
  });

  it('accepts status="activated" when the caller passes alsoAllowStatus: "activated" — the actual fix', async () => {
    routeFetch(fetchMock, { status: 'activated' });
    const r = await approveAutoExecute({ finding_id: FINDING_ID, alsoAllowStatus: 'activated' });
    expect(r.ok).toBe(true);
    // approveAutoExecute generates its own execution id client-side
    // (randomUUID()) and POSTs with Prefer: return=minimal, so there is no
    // server-assigned id to assert against — only that a real execution
    // row was actually created (a real UUID, not undefined/null/empty).
    expect(r.execution?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const postCall = fetchMock.mock.calls.find(
      ([u, init]) => String(u).endsWith('/rest/v1/dev_autopilot_executions') && (init?.method || '').toUpperCase() === 'POST',
    );
    expect(postCall).toBeDefined();
    const posted = JSON.parse(String((postCall as any)[1].body));
    expect(posted.id).toBe(r.execution?.id);
    expect(posted.finding_id).toBe(FINDING_ID);
  });

  it('alsoAllowStatus does not become a wildcard — a status that is neither "new" nor the passed value is still rejected', async () => {
    routeFetch(fetchMock, { status: 'rejected' });
    const r = await approveAutoExecute({ finding_id: FINDING_ID, alsoAllowStatus: 'activated' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/finding status is 'rejected'/);
  });

  it('status="new" still works with no opt-in at all — the common, unaffected path', async () => {
    routeFetch(fetchMock, { status: 'new' });
    const r = await approveAutoExecute({ finding_id: FINDING_ID });
    expect(r.ok).toBe(true);
  });
});

describe('bridgeActivationToExecution — recovers a finding the RPC already moved to activated (VTID-04254)', () => {
  let fetchMock: FetchMock;

  beforeAll(() => {
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE = 'test_service_role_key';
  });

  afterAll(() => {
    if (ORIGINAL_SUPABASE_URL === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = ORIGINAL_SUPABASE_URL;
    if (ORIGINAL_SUPABASE_SERVICE_ROLE === undefined) delete process.env.SUPABASE_SERVICE_ROLE;
    else process.env.SUPABASE_SERVICE_ROLE = ORIGINAL_SUPABASE_SERVICE_ROLE;
    global.fetch = ORIGINAL_FETCH;
  });

  beforeEach(() => {
    fetchMock = jest.fn() as FetchMock;
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('reproduces and closes the exact live failure: a finding already at status=activated now bridges to a real execution instead of "only new findings can be approved"', async () => {
    routeFetch(fetchMock, { status: 'activated', sourceType: 'dev_autopilot' });
    const r = await bridgeActivationToExecution(FINDING_ID, null);
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    // Same reasoning as the approveAutoExecute test above: the execution id
    // is client-generated (randomUUID()), never echoed back by Supabase —
    // assert a real row was created, not a specific id.
    expect(r.execution_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

// -----------------------------------------------------------------------
// Source contracts — mirrors test/vtid-04108-manual-activation-call-sites
// .test.ts's own extractFunctionBody pattern, same purpose: lock in WHERE
// the fix lives, not just that it behaves correctly under one mock shape.
// -----------------------------------------------------------------------

const EXEC_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../src/services/dev-autopilot-execute.ts'),
  'utf8',
);
const ROUTE_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../src/routes/autopilot-recommendations.ts'),
  'utf8',
);
const OPERATOR_TOOL_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../src/services/operator-recommendation-tools.ts'),
  'utf8',
);

function extractFunctionBody(src: string, name: string): string {
  const re = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b[\\s\\S]*?\\{(?=\\s*\\n)`,
    'm',
  );
  const m = re.exec(src);
  if (!m) throw new Error(`could not locate function ${name} in source`);
  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return src.slice(start, i);
}

describe('bridgeActivationToExecution source contract — passes alsoAllowStatus, and only that value', () => {
  const fn = extractFunctionBody(EXEC_SOURCE, 'bridgeActivationToExecution');

  it("passes alsoAllowStatus: 'activated' to approveAutoExecute, alongside the existing allowManualSourceTypes", () => {
    const approveCallIdx = fn.indexOf('await approveAutoExecute({');
    expect(approveCallIdx).toBeGreaterThan(-1);
    const approveCall = fn.slice(approveCallIdx, fn.indexOf('});', approveCallIdx) + 3);
    expect(approveCall).toContain('allowManualSourceTypes: true');
    expect(approveCall).toContain("alsoAllowStatus: 'activated'");
  });
});

describe('autoApproveTick — never opts into alsoAllowStatus (the invariant this VTID exists to protect)', () => {
  const fn = extractFunctionBody(EXEC_SOURCE, 'autoApproveTick');

  it('its own approveAutoExecute call sites pass no alsoAllowStatus — still gated on status=new only', () => {
    const calls = fn.match(/await approveAutoExecute\(\{[^}]*\}\)/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).not.toContain('alsoAllowStatus');
    }
  });
});

describe('the two human-facing activation callers retry the bridge on every call, not only the first', () => {
  it('routes/autopilot-recommendations.ts no longer gates the bridge attempt on !response.already_activated', () => {
    const bridgeIdx = ROUTE_SOURCE.indexOf('Bridge activations into the executor');
    expect(bridgeIdx).toBeGreaterThan(-1);
    const block = ROUTE_SOURCE.slice(bridgeIdx, ROUTE_SOURCE.indexOf('bridgeActivationToExecution(id, userId || null)', bridgeIdx) + 60);
    expect(block).not.toContain('!response.already_activated && response.vtid');
    expect(block).toMatch(/if \(response\.vtid\) \{/);
  });

  it('the alignment-telemetry and draft-spec side effects in the SAME route stay gated on !already_activated (unchanged — idempotent side effects, not the bridge)', () => {
    const occurrences = (ROUTE_SOURCE.match(/if \(!response\.already_activated && response\.vtid\) \{/g) || []).length;
    // exactly two: alignment telemetry + draft spec creation. The bridge's own copy is gone.
    expect(occurrences).toBe(2);
  });

  it('operator-recommendation-tools.ts no longer gates the bridge attempt on !response.already_activated', () => {
    const bridgeIdx = OPERATOR_TOOL_SOURCE.indexOf('Bridge into a real execution');
    expect(bridgeIdx).toBeGreaterThan(-1);
    const block = OPERATOR_TOOL_SOURCE.slice(bridgeIdx, OPERATOR_TOOL_SOURCE.indexOf('bridgeActivationToExecution)(recommendationId', bridgeIdx) + 80);
    expect(block).not.toContain('!response.already_activated && response.vtid');
    expect(block).toMatch(/if \(response\.vtid\) \{/);
  });

  it('the OASIS activation-event emission in the SAME tool stays gated on !already_activated (unchanged — never re-emitted on a retry)', () => {
    const occurrences = (OPERATOR_TOOL_SOURCE.match(/if \(!response\.already_activated && response\.vtid\) \{/g) || []).length;
    expect(occurrences).toBe(1); // only the OASIS-emit block now; the bridge's own copy is gone
  });
});
