/**
 * VTID-04007 (W2): open-ended intake — `autopilot_run_task(request)`.
 *
 * A free-text request with no VTID and no file list becomes a governed,
 * agent-mode execution: the on-ramp self-allocates the VTID (VTID-04005,
 * still behind OPERATOR_VTID_SELF_ALLOCATE_ENABLED), pins the agent
 * executor on the row (only the agent can discover files), and the agent
 * runner's post-hoc scope/coverage checks (VTID-04006) apply to the real
 * diff. Pinned here: the on-ramp semantics, the tool's declarations on the
 * wire and in the registry, both prompt sources, the handler's wiring, and
 * the agent's discovery-mode task prompt.
 */

import * as fs from 'fs';
import * as path from 'path';

jest.mock('../src/services/dev-autopilot-execute', () => {
  const actual = jest.requireActual('../src/services/dev-autopilot-execute');
  return { ...actual, getSupabase: jest.fn(), supa: jest.fn(), approveAutoExecute: jest.fn() };
});
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

import { triggerOperatorExecution } from '../src/services/operator-execution-onramp';
import { getSupabase, supa, approveAutoExecute } from '../src/services/dev-autopilot-execute';
import { emitOasisEvent } from '../src/services/oasis-event-service';
import { buildAgentTaskPrompt } from '../src/services/autopilot-agent/agent-prompt';
import { getToolByName } from '../src/services/tool-registry';

const mockedGetSupabase = getSupabase as jest.Mock;
const mockedSupa = supa as jest.Mock;
const mockedApprove = approveAutoExecute as jest.Mock;

const SRC = path.resolve(__dirname, '../src/services');
const personality = fs.readFileSync(path.join(SRC, 'ai-personality-service.ts'), 'utf8');
const operator = fs.readFileSync(path.join(SRC, 'gemini-operator.ts'), 'utf8');

function jsonRes(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body } as any;
}

const REQUEST = 'The CI failure reason should name the checks that failed instead of saying branch protection blocked.';
const OPEN_ENDED = { planMarkdown: REQUEST, filesReferenced: [], openEnded: true, requestedBy: 'operator-chat:thread-w2' };

describe('VTID-04007 triggerOperatorExecution open-ended path', () => {
  const ORIGINAL_ENV = process.env;
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;
  let patches: Array<{ path: string; body: any }>;

  function wireHappyPath() {
    fetchMock.mockImplementation((url: string, init?: { body?: string }) => {
      if (url.endsWith('/rest/v1/rpc/allocate_global_vtid')) return jsonRes(200, [{ vtid: 'VTID-04100', num: 4100, id: 'row-1' }]);
      if (url.endsWith('/rest/v1/autopilot_recommendations')) {
        expect(JSON.parse(init!.body!).spec_snapshot).toMatchObject({ intake: 'open_ended', files_referenced: [], spec_markdown: REQUEST });
        return jsonRes(201, [{ id: 'finding-1' }]);
      }
      if (url.endsWith('/rest/v1/dev_autopilot_plan_versions')) {
        expect(JSON.parse(init!.body!).files_referenced).toEqual([]);
        return jsonRes(201, null);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    mockedSupa.mockImplementation(async (_s: unknown, p: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'PATCH') { patches.push({ path: p, body: JSON.parse(init.body || '{}') }); return { ok: true, data: null }; }
      if (p.includes('vtid_ledger') && p.includes('select=spec_status')) return { ok: true, data: [{ spec_status: 'approved', is_terminal: false }] };
      if (p.includes('vtid_ledger') && p.includes('select=metadata')) return { ok: true, data: [{ metadata: { source: 'operator-onramp' } }] };
      return { ok: true, data: [] };
    });
    mockedApprove.mockResolvedValue({ ok: true, execution: { id: 'exec-open-1' } });
  }

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, OPERATOR_EXECUTION_ONRAMP_ENABLED: 'true' };
    delete process.env.OPERATOR_VTID_SELF_ALLOCATE_ENABLED;
    delete process.env.OPERATOR_ONRAMP_EXECUTOR;
    mockedGetSupabase.mockReset().mockReturnValue({ url: 'https://test.supabase.co', key: 'k' });
    mockedSupa.mockReset();
    mockedApprove.mockReset();
    (emitOasisEvent as jest.Mock).mockClear();
    patches = [];
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterAll(() => { process.env = ORIGINAL_ENV; global.fetch = originalFetch; });

  it('is still refused when the on-ramp kill switch is off', async () => {
    process.env.OPERATOR_EXECUTION_ONRAMP_ENABLED = 'false';
    const r = await triggerOperatorExecution(OPEN_ENDED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/operator_execution_onramp_disabled/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is refused without the self-allocate flag — an open-ended request has no VTID to fall back on', async () => {
    const r = await triggerOperatorExecution(OPEN_ENDED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/OPERATOR_VTID_SELF_ALLOCATE_ENABLED/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockedApprove).not.toHaveBeenCalled();
  });

  it('a non-open-ended call with no files is still rejected exactly as before', async () => {
    process.env.OPERATOR_VTID_SELF_ALLOCATE_ENABLED = 'true';
    const r = await triggerOperatorExecution({ ...OPEN_ENDED, openEnded: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/filesReferenced is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with the flag on: allocates the VTID, records intake=open_ended, pins the AGENT executor on the row regardless of OPERATOR_ONRAMP_EXECUTOR', async () => {
    process.env.OPERATOR_VTID_SELF_ALLOCATE_ENABLED = 'true';
    wireHappyPath();
    const r = await triggerOperatorExecution(OPEN_ENDED);
    expect(r).toEqual({ ok: true, execution_id: 'exec-open-1', finding_id: 'finding-1', vtid: 'VTID-04100', vtid_allocated: true });
    // ledger registration carries the intake
    const ledger = patches.find((p) => p.path.includes('vtid_ledger?vtid=eq.VTID-04100') && p.body.status === 'in_progress')!;
    expect(ledger.body).toMatchObject({ spec_status: 'approved', title: expect.stringMatching(/^Operator: The CI failure reason/), metadata: expect.objectContaining({ intake: 'open_ended' }) });
    // execution row: agent executor pinned even though the env var is unset
    const execPatch = patches.find((p) => p.path.includes('dev_autopilot_executions?id=eq.exec-open-1'))!;
    expect(execPatch.body.metadata).toMatchObject({ executor: 'agent', intake: 'open_ended', llm_on_ramp_override: { provider: 'deepseek', model: 'deepseek-flash' } });
    expect(mockedApprove).toHaveBeenCalledWith({ finding_id: 'finding-1', interactive: true });
    const evt = (emitOasisEvent as jest.Mock).mock.calls.find((c) => c[0].type === 'operator.execution_onramp.triggered')![0];
    expect(evt.vtid).toBe('VTID-04100');
    expect(evt.payload).toMatchObject({ intake: 'open_ended', vtid_allocated: true });
  });

  it('an explicit title wins over the derived one', async () => {
    process.env.OPERATOR_VTID_SELF_ALLOCATE_ENABLED = 'true';
    wireHappyPath();
    await triggerOperatorExecution({ ...OPEN_ENDED, title: 'Name failing checks' });
    const ledger = patches.find((p) => p.path.includes('vtid_ledger?vtid=eq.VTID-04100') && p.body.status === 'in_progress')!;
    expect(ledger.body.title).toBe('Operator: Name failing checks');
  });

  it('a pre-listed plan is untouched by this VTID: executor is only pinned by the env var, intake=plan', async () => {
    process.env.OPERATOR_VTID_SELF_ALLOCATE_ENABLED = 'true';
    wireHappyPath();
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/rest/v1/rpc/allocate_global_vtid')) return jsonRes(200, [{ vtid: 'VTID-04100' }]);
      if (url.endsWith('/rest/v1/autopilot_recommendations')) return jsonRes(201, [{ id: 'finding-2' }]);
      if (url.endsWith('/rest/v1/dev_autopilot_plan_versions')) return jsonRes(201, null);
      throw new Error(`unexpected fetch ${url}`);
    });
    await triggerOperatorExecution({ planMarkdown: '# plan', filesReferenced: ['services/gateway/test/a.test.ts'], requestedBy: 'x' });
    const execPatch = patches.find((p) => p.path.includes('dev_autopilot_executions?id=eq.exec-open-1'))!;
    expect(execPatch.body.metadata.executor).toBeUndefined();
    expect(execPatch.body.metadata.intake).toBeUndefined();
  });
});

describe('VTID-04007 tool declarations', () => {
  it('is in the registry with request required and title optional, gated on both flags', () => {
    const t = getToolByName('autopilot_run_task')!;
    expect(t).toBeDefined();
    expect(t.parameters_schema.required).toEqual(['request']);
    expect(Object.keys(t.parameters_schema.properties)).toEqual(['request', 'title']);
    expect(t.description).toMatch(/OPERATOR_EXECUTION_ONRAMP_ENABLED and OPERATOR_VTID_SELF_ALLOCATE_ENABLED/);
    expect(t.allowed_roles).toEqual(['operator', 'admin', 'developer']);
    expect(t.vtid).toBe('VTID-04007');
  });

  it('is on the operator wire schema with the same shape, and dispatched to executeRunTask', () => {
    const start = operator.indexOf("name: 'autopilot_run_task'");
    expect(start).toBeGreaterThan(-1);
    const block = operator.slice(start, operator.indexOf("name: 'autopilot_get_status'", start));
    expect(block).toMatch(/required: \['request'\]/);
    expect(block).toMatch(/names NO VTID/);
    expect(operator).toMatch(/case 'autopilot_run_task':\s*\n\s*result = await executeRunTask\(/);
  });

  it('executeRunTask refuses before governance when the thread is not a verified exafy_admin, and never lists files', () => {
    const start = operator.indexOf('async function executeRunTask(');
    const body = operator.slice(start, operator.indexOf('async function executeGetStatus(', start));
    const authzIdx = body.indexOf('isExecuteTaskAuthorized(getThreadAuth(threadId))');
    const govIdx = body.indexOf("evaluateGovernance('operator.autopilot.run_task'");
    expect(authzIdx).toBeGreaterThan(-1);
    expect(govIdx).toBeGreaterThan(authzIdx);
    expect(body).toMatch(/filesReferenced: \[\],\s*\n\s*openEnded: true/);
    expect(body).toMatch(/status: 'queued'/);
    expect(body).toMatch(/executor: 'agent'/);
  });
});

describe('VTID-04007 both operator prompt sources describe the tool (VTID-03838 drift rule)', () => {
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
    it(`${name}: lists the tool, routes open-ended requests to it, and keeps it apart from create/execute`, () => {
      expect(text).toMatch(/- autopilot_run_task: Turn a free-text development request into a governed agent-mode execution/);
      expect(text).toMatch(/Open-ended development requests that name NO VTID .* → call autopilot_run_task/);
      expect(text).toMatch(/pass their request verbatim in request/);
      expect(text).toMatch(/never invent requirements/);
      expect(text).toMatch(/do not call autopilot_create_task first for the same request and never pair it with autopilot_execute_task/);
      expect(text).toMatch(/A question about code is not a request to change it/);
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
    expect(extract(served)).toContain('autopilot_run_task is for a code change the user asks to be made NOW');
  });
});

describe('VTID-04007 agent task prompt in discovery mode', () => {
  it('open-ended: the request is the whole spec, no file list, discovery instructions, ambiguity rule', () => {
    const p = buildAgentTaskPrompt({ vtid: 'VTID-04100', planMarkdown: REQUEST, filesReferenced: [], openEnded: true });
    expect(p).toContain("## Request (the user's own words — this is the whole specification)");
    expect(p).toContain(REQUEST);
    expect(p).toContain('## No files were pre-selected — discover them');
    expect(p).toMatch(/search_text \/ find_files/);
    expect(p).toMatch(/Do not add features, refactors or requirements the request did not ask for/);
    expect(p).toMatch(/say which reading you took/);
    expect(p).not.toContain('## Files the plan names');
    expect(p).toMatch(/Begin by searching/);
  });

  it('plan mode is unchanged, including the prior-failure block', () => {
    const p = buildAgentTaskPrompt({ vtid: 'VTID-1', planMarkdown: '# plan', filesReferenced: ['a.ts'], priorFailure: 'CI said no' });
    expect(p).toContain('## Files the plan names (start here; read them first)');
    expect(p).toContain('- a.ts');
    expect(p).toContain('## A previous attempt failed — evidence');
    expect(p).toMatch(/Begin by reading the named files/);
    const open = buildAgentTaskPrompt({ vtid: 'VTID-1', planMarkdown: 'req', filesReferenced: [], openEnded: true, priorFailure: 'CI said no' });
    expect(open).toContain('## A previous attempt failed — evidence');
  });
});
