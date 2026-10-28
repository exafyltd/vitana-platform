/**
 * VTID-04111: the Operator Console can activate a Dev Autopilot
 * recommendation by id from chat.
 *
 * Reported live: an earlier attempt at this exact tool (VTID-04109) stalled
 * inside the automated Dev Autopilot agent executor ("model answered with
 * text 3 times in a row without calling finish") — a tool-call-compliance
 * failure in that pipeline, not a defect in the task. Implemented directly.
 *
 * Pinned here: the tool declaration (registry + operator wire schema +
 * dispatch), both prompt sources under the VTID-03838 drift rule, the
 * VTID-03851 caller gate running before any Supabase read, the two-step
 * activate (RPC `activate_autopilot_recommendation`) + bridge
 * (`bridgeActivationToExecution`, VTID-04108) flow, idempotency on an
 * already-activated recommendation, and that the OASIS event / bridge
 * attempt only fire on a fresh activation.
 */

import * as fs from 'fs';
import * as path from 'path';

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../src/services/dev-autopilot-execute', () => {
  const actual = jest.requireActual('../src/services/dev-autopilot-execute');
  return { ...actual, getSupabase: jest.fn(() => null), supa: jest.fn(), bridgeActivationToExecution: jest.fn() };
});

import { supa, bridgeActivationToExecution } from '../src/services/dev-autopilot-execute';
import { emitOasisEvent } from '../src/services/oasis-event-service';
import { setThreadAuth, clearThreadAuth } from '../src/services/operator-execute-authz';
import { getToolByName } from '../src/services/tool-registry';
import {
  executeActivateRecommendation,
  authorizeActivateRecommendationTool,
} from '../src/services/operator-recommendation-tools';

const mockedSupa = supa as jest.Mock;
const mockedBridge = bridgeActivationToExecution as jest.Mock;
const mockedEmit = emitOasisEvent as jest.Mock;

const SRC = path.resolve(__dirname, '../src/services');
const personality = fs.readFileSync(path.join(SRC, 'ai-personality-service.ts'), 'utf8');
const operator = fs.readFileSync(path.join(SRC, 'gemini-operator.ts'), 'utf8');

const S = { url: 'https://supa.test', key: 'k' };
const REC = '4f7d5ea4-1111-4222-8333-444444444444';
const ADMIN = 't-admin';
const ANON = 't-anon';
const NONADMIN = 't-user';

beforeEach(() => {
  mockedSupa.mockReset();
  mockedBridge.mockReset();
  mockedEmit.mockClear();
  setThreadAuth(ADMIN, { user_id: 'u-admin', exafy_admin: true });
  setThreadAuth(NONADMIN, { user_id: 'u-1', exafy_admin: false });
  clearThreadAuth(ANON);
});

describe('VTID-04111 tool declaration', () => {
  it('registry: requires recommendation_id, correct role/category/vtid', () => {
    const tool = getToolByName('autopilot_activate_recommendation')!;
    expect(tool).toBeDefined();
    expect(tool.parameters_schema.required).toEqual(['recommendation_id']);
    expect(Object.keys(tool.parameters_schema.properties)).toEqual(['recommendation_id']);
    expect(tool.vtid).toBe('VTID-04111');
    expect(tool.category).toBe('autopilot');
    expect(tool.allowed_roles).toEqual(['operator', 'admin', 'developer']);
    expect(tool.description).toMatch(/exafy_admin session required/);
  });

  it('operator wire schema: declared between reject and cancel, dispatched to its handler, imported', () => {
    const start = operator.indexOf("name: 'autopilot_reject_execution'");
    const end = operator.indexOf("name: 'autopilot_cancel_execution'", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = operator.slice(start, end);
    expect(block).toContain("name: 'autopilot_activate_recommendation'");
    expect(block).toMatch(/required: \['recommendation_id'\]/);
    expect(operator).toMatch(/case 'autopilot_activate_recommendation':\s*\n\s*result = await executeActivateRecommendation\(/);
    expect(operator).toMatch(/import \{ executeActivateRecommendation \} from '\.\/operator-recommendation-tools';/);
  });
});

describe('VTID-04111 both operator prompt sources describe the tool (VTID-03838 drift rule)', () => {
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
    it(`${name}: lists the tool, routes an explicit activate request, and forbids guessing the recommendation`, () => {
      expect(text).toMatch(/- autopilot_activate_recommendation: Activate a specific Dev Autopilot recommendation by id/);
      expect(text).toMatch(/An explicit request to activate a specific Dev Autopilot recommendation by id[^\n]*→ call autopilot_activate_recommendation/);
      expect(text).toMatch(/acts on a RECOMMENDATION \(not an execution\)/);
      expect(text).toMatch(/never guess which recommendation they mean/);
    });
  }

  it('the execution-rules block stays byte-identical across both sources (unchanged by this addition)', () => {
    const extract = (text: string) => {
      const start = text.indexOf('**CRITICAL EXECUTION RULES');
      const end = text.indexOf('**CRITICAL TASK CREATION RULES:**', start);
      return text.slice(start, end).trim();
    };
    const inlineFull = operator.slice(operator.indexOf('function getOperatorSystemPrompt()'));
    expect(extract(served)).toBe(extract(inlineFull));
    expect(extract(served)).toContain('autopilot_activate_recommendation is different from all of the above');
  });
});

describe('VTID-04111 caller gate (VTID-03851) runs before any read', () => {
  it('refuses an anonymous thread and a non-admin thread, naming the tool, without touching Supabase', async () => {
    const anon = await executeActivateRecommendation({ recommendation_id: REC }, ANON, { s: S });
    expect(anon.ok).toBe(false);
    expect(anon.error).toMatch(/autopilot_activate_recommendation requires an authenticated session/);
    expect(anon.error).toMatch(/nothing was activated/);

    const user = await executeActivateRecommendation({ recommendation_id: REC }, NONADMIN, { s: S });
    expect(user.error).toMatch(/autopilot_activate_recommendation requires an exafy_admin session/);

    expect(mockedSupa).not.toHaveBeenCalled();
    expect(mockedBridge).not.toHaveBeenCalled();
  });

  it('derives the actor and user id from the verified identity, never from the model', () => {
    const z = authorizeActivateRecommendationTool(ADMIN);
    expect(z).toEqual({ ok: true, actor: 'operator-chat:u-admin', userId: 'u-admin' });
  });

  it('reports an unconfigured Supabase instead of throwing', async () => {
    const r = await executeActivateRecommendation({ recommendation_id: REC }, ADMIN); // deps.s undefined -> getSupabase() mocked to null
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Supabase not configured/);
  });
});

describe('VTID-04111 recommendation_id validation', () => {
  it('refuses a missing or non-UUID id before touching Supabase', async () => {
    const missing = await executeActivateRecommendation({ recommendation_id: '' }, ADMIN, { s: S });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/recommendation_id is required/);

    const bad = await executeActivateRecommendation({ recommendation_id: 'not-a-uuid' }, ADMIN, { s: S });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/is not a UUID/);

    expect(mockedSupa).not.toHaveBeenCalled();
  });
});

describe('VTID-04111 activate — fresh activation', () => {
  it('calls the RPC, emits the OASIS event, and bridges for a manually-bridgeable source_type', async () => {
    mockedSupa.mockImplementation(async (_s: unknown, p: string) => {
      if (p.startsWith('/rest/v1/autopilot_recommendations?id=eq.')) return { ok: true, status: 200, data: [{ source_type: 'community' }] };
      return { ok: false, status: 404, error: `unexpected ${p}` };
    });
    mockedBridge.mockResolvedValue({ ok: true, execution_id: 'e1111111-1111-1111-1111-111111111111' });

    const activateRpc = jest.fn(async () => ({
      ok: true,
      data: { ok: true, vtid: 'VTID-05000', title: 'Do the thing', already_activated: false, activated_at: '2026-09-19T12:00:00Z', status: 'activated' },
    }));

    const r = await executeActivateRecommendation({ recommendation_id: REC }, ADMIN, { s: S, activateRpc });

    expect(activateRpc).toHaveBeenCalledWith(S, REC, 'u-admin');
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({
      recommendation_id: REC,
      vtid: 'VTID-05000',
      title: 'Do the thing',
      already_activated: false,
      execution_id: 'e1111111-1111-1111-1111-111111111111',
    });
    expect((r.data!.message as string)).toMatch(/Activated as VTID-05000/);
    expect((r.data!.message as string)).toMatch(/execution.*has been started/);

    expect(mockedEmit).toHaveBeenCalledTimes(1);
    expect(mockedEmit.mock.calls[0][0]).toMatchObject({
      vtid: 'VTID-05000',
      type: 'autopilot.recommendation.activated',
      source: 'operator-chat',
      payload: expect.objectContaining({ recommendation_id: REC, vtid: 'VTID-05000', user_id: 'u-admin' }),
    });

    expect(mockedBridge).toHaveBeenCalledWith(REC, 'u-admin');
  });

  it('does NOT bridge for a source_type outside the manually-bridgeable allowlist', async () => {
    mockedSupa.mockImplementation(async (_s: unknown, p: string) => {
      if (p.startsWith('/rest/v1/autopilot_recommendations?id=eq.')) return { ok: true, status: 200, data: [{ source_type: 'some_other_source' }] };
      return { ok: false, status: 404, error: `unexpected ${p}` };
    });
    const activateRpc = jest.fn(async () => ({
      ok: true,
      data: { ok: true, vtid: 'VTID-05001', title: 'Something else', already_activated: false, status: 'activated' },
    }));

    const r = await executeActivateRecommendation({ recommendation_id: REC }, ADMIN, { s: S, activateRpc });

    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ execution_id: null });
    expect(mockedBridge).not.toHaveBeenCalled();
    expect((r.data!.message as string)).toBe('Activated as VTID-05001.');
  });

  it('surfaces a bridge failure in the message without failing the overall activation', async () => {
    mockedSupa.mockImplementation(async (_s: unknown, p: string) => {
      if (p.startsWith('/rest/v1/autopilot_recommendations?id=eq.')) return { ok: true, status: 200, data: [{ source_type: 'health' }] };
      return { ok: false, status: 404, error: `unexpected ${p}` };
    });
    mockedBridge.mockResolvedValue({ ok: false, error: 'plan generation failed: boom' });
    const activateRpc = jest.fn(async () => ({
      ok: true,
      data: { ok: true, vtid: 'VTID-05002', title: 'X', already_activated: false, status: 'activated' },
    }));

    const r = await executeActivateRecommendation({ recommendation_id: REC }, ADMIN, { s: S, activateRpc });

    expect(r.ok).toBe(true);
    expect((r.data!.message as string)).toMatch(/Activation succeeded but starting the execution failed: plan generation failed: boom/);
  });
});

describe('VTID-04111 activate — idempotent on an already-activated recommendation', () => {
  it('does not emit an OASIS event and does not attempt to bridge', async () => {
    const activateRpc = jest.fn(async () => ({
      ok: true,
      data: { ok: true, vtid: 'VTID-04999', already_activated: true, activated_at: '2026-09-18T00:00:00Z' },
    }));

    const r = await executeActivateRecommendation({ recommendation_id: REC }, ADMIN, { s: S, activateRpc });

    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ vtid: 'VTID-04999', already_activated: true });
    expect((r.data!.message as string)).toBe('Already activated as VTID-04999.');
    expect(mockedEmit).not.toHaveBeenCalled();
    expect(mockedBridge).not.toHaveBeenCalled();
    // No source_type lookup either — bridging was never attempted.
    expect(mockedSupa).not.toHaveBeenCalled();
  });
});

describe('VTID-04111 activate — failure surfaces', () => {
  it('an RPC transport failure is reported, not thrown', async () => {
    const activateRpc = jest.fn(async () => ({ ok: false, error: '500: db down' }));
    const r = await executeActivateRecommendation({ recommendation_id: REC }, ADMIN, { s: S, activateRpc });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/activate failed: 500: db down/);
  });

  it('an RPC-level rejection (e.g. recommendation not found, wrong status) is reported', async () => {
    const activateRpc = jest.fn(async () => ({ ok: true, data: { ok: false, error: 'Recommendation not found' } }));
    const r = await executeActivateRecommendation({ recommendation_id: REC }, ADMIN, { s: S, activateRpc });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Recommendation not found');
  });
});
