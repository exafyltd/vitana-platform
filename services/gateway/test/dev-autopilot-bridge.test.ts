/**
 * Tests for the Dev Autopilot → Self-Healing bridge.
 *
 * Focuses on:
 *   - Pure decision helper (decideBridgeAction)
 *   - Full bridgeFailureToSelfHealing flow with Supabase + triage mocked
 *   - Auto-revert dry-run behavior per failure stage
 *   - Idempotency (already-bridged executions short-circuit)
 */

import {
  decideBridgeAction,
  CHILD_SPAWN_CONFIDENCE_THRESHOLD,
} from '../src/services/dev-autopilot-bridge';

// =============================================================================
// Mocks
// =============================================================================

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true, event_id: 'test-event' }),
}));

jest.mock('../src/services/self-healing-triage-service', () => ({
  spawnTriageAgent: jest.fn(),
}));

const { spawnTriageAgent } = require('../src/services/self-healing-triage-service');
const { emitOasisEvent } = require('../src/services/oasis-event-service');

// Supabase fetch mock — rigged to return predefined responses per path/method.
const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

const SUPA_URL = 'https://supa.test';
const SUPA_KEY = 'service-role-key';

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SUPABASE_URL = SUPA_URL;
  process.env.SUPABASE_SERVICE_ROLE = SUPA_KEY;
  process.env.DEV_AUTOPILOT_DRY_RUN = 'true';
  fetchMock.mockReset();
});

function jsonRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

function matchUrl(url: string, needle: string): boolean {
  return typeof url === 'string' && url.includes(needle);
}

// =============================================================================
// Pure decision helper
// =============================================================================

describe('decideBridgeAction', () => {
  it('spawns child when confidence high, depth below cap, kill switch off', () => {
    expect(decideBridgeAction({
      confidence_numeric: 0.85,
      auto_fix_depth: 0,
      max_auto_fix_depth: 2,
      kill_switch: false,
    })).toEqual({ action: 'spawn_child' });
  });

  it('escalates when confidence below threshold', () => {
    expect(decideBridgeAction({
      confidence_numeric: 0.4,
      auto_fix_depth: 0,
      max_auto_fix_depth: 2,
      kill_switch: false,
    })).toEqual({ action: 'escalate', reason: 'low_confidence' });
  });

  it('escalates at depth cap even with high confidence', () => {
    expect(decideBridgeAction({
      confidence_numeric: 0.9,
      auto_fix_depth: 2,
      max_auto_fix_depth: 2,
      kill_switch: false,
    })).toEqual({ action: 'escalate', reason: 'depth_cap_reached' });
  });

  it('kill switch always escalates, regardless of confidence/depth', () => {
    expect(decideBridgeAction({
      confidence_numeric: 1,
      auto_fix_depth: 0,
      max_auto_fix_depth: 5,
      kill_switch: true,
    })).toEqual({ action: 'escalate', reason: 'kill_switch_armed' });
  });

  it('threshold is the documented CHILD_SPAWN_CONFIDENCE_THRESHOLD', () => {
    expect(CHILD_SPAWN_CONFIDENCE_THRESHOLD).toBe(0.5);
    // Exactly at threshold → spawn child (>=)
    expect(decideBridgeAction({
      confidence_numeric: 0.5,
      auto_fix_depth: 0,
      max_auto_fix_depth: 2,
      kill_switch: false,
    })).toEqual({ action: 'spawn_child' });
  });
});

// =============================================================================
// bridgeFailureToSelfHealing — full flows
// =============================================================================

function execRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    finding_id: 'f0000000-0000-0000-0000-000000000001',
    plan_version: 1,
    status: 'failed',
    auto_fix_depth: 0,
    branch: 'dev-autopilot/11111111',
    pr_url: 'https://github.com/exafyltd/vitana-platform/pull/9001',
    pr_number: 9001,
    parent_execution_id: null,
    self_healing_vtid: null,
    triage_report: null,
    metadata: {},
    ...overrides,
  };
}

function configRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    max_auto_fix_depth: 2,
    cooldown_minutes: 10,
    kill_switch: false,
    ...overrides,
  };
}

function triageReport(confidence: 'high' | 'medium' | 'low', overrides: Partial<Record<string, unknown>> = {}): any {
  const numeric = confidence === 'high' ? 0.85 : confidence === 'medium' ? 0.65 : 0.4;
  return {
    session_id: 'session_test_123',
    severity: 'warning',
    root_cause_hypothesis: 'test cause',
    affected_component: 'services/gateway/src/routes/test.ts',
    evidence: ['test evidence'],
    recommended_fix: 'test fix',
    confidence,
    confidence_numeric: numeric,
    elapsed_ms: 100,
    mode: 'post_failure',
    raw_output: 'test output',
    ...overrides,
  };
}

describe('bridgeFailureToSelfHealing', () => {
  it('spawns a child execution when triage confidence is high and depth is 0', async () => {
    const { bridgeFailureToSelfHealing } = require('../src/services/dev-autopilot-bridge');
    const exec = execRow({ auto_fix_depth: 0 });

    // supa fetch responses: load exec, load config, spawn child (POST), patch exec
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (matchUrl(url, '/rest/v1/dev_autopilot_executions?id=eq.') && (!init?.method || init.method === 'GET')) {
        return Promise.resolve(jsonRes(200, [exec]));
      }
      if (matchUrl(url, '/rest/v1/dev_autopilot_config?id=eq.1')) {
        return Promise.resolve(jsonRes(200, [configRow()]));
      }
      if (matchUrl(url, '/rest/v1/dev_autopilot_executions') && init?.method === 'POST') {
        return Promise.resolve(jsonRes(201, {}));
      }
      if (matchUrl(url, '/rest/v1/dev_autopilot_executions?id=eq.') && init?.method === 'PATCH') {
        return Promise.resolve(jsonRes(204, null));
      }
      return Promise.resolve(jsonRes(404, {}));
    });

    (spawnTriageAgent as jest.Mock).mockResolvedValue({
      ok: true,
      report: triageReport('high'),
    });

    const result = await bridgeFailureToSelfHealing({
      execution_id: exec.id,
      failure_stage: 'ci',
      error: 'CI failed',
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe('self_heal_injected');
    expect(result.child_execution_id).toBeTruthy();
    expect(result.triage_report?.confidence).toBe('high');
    expect(spawnTriageAgent).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'post_failure',
      failure_class: 'ci',
    }));
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'dev_autopilot.execution.self_heal_injected',
    }));
  });

  it('escalates when auto_fix_depth is at the cap', async () => {
    const { bridgeFailureToSelfHealing } = require('../src/services/dev-autopilot-bridge');
    const exec = execRow({ auto_fix_depth: 2 }); // at cap

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (matchUrl(url, '/rest/v1/dev_autopilot_executions?id=eq.') && (!init?.method || init.method === 'GET')) {
        return Promise.resolve(jsonRes(200, [exec]));
      }
      if (matchUrl(url, '/rest/v1/dev_autopilot_config?id=eq.1')) {
        return Promise.resolve(jsonRes(200, [configRow({ max_auto_fix_depth: 2 })]));
      }
      if (init?.method === 'PATCH') {
        return Promise.resolve(jsonRes(204, null));
      }
      return Promise.resolve(jsonRes(404, {}));
    });

    (spawnTriageAgent as jest.Mock).mockResolvedValue({
      ok: true,
      report: triageReport('high'),
    });

    const result = await bridgeFailureToSelfHealing({
      execution_id: exec.id,
      failure_stage: 'ci',
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe('escalated');
    expect(result.child_execution_id).toBeUndefined();
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'dev_autopilot.execution.escalated',
      payload: expect.objectContaining({ reason: 'depth_cap_reached' }),
    }));
  });

  it('escalates when triage confidence is low', async () => {
    const { bridgeFailureToSelfHealing } = require('../src/services/dev-autopilot-bridge');
    const exec = execRow({ auto_fix_depth: 0 });

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (matchUrl(url, '/rest/v1/dev_autopilot_executions?id=eq.') && (!init?.method || init.method === 'GET')) {
        return Promise.resolve(jsonRes(200, [exec]));
      }
      if (matchUrl(url, '/rest/v1/dev_autopilot_config?id=eq.1')) {
        return Promise.resolve(jsonRes(200, [configRow()]));
      }
      if (init?.method === 'PATCH') {
        return Promise.resolve(jsonRes(204, null));
      }
      return Promise.resolve(jsonRes(404, {}));
    });

    (spawnTriageAgent as jest.Mock).mockResolvedValue({
      ok: true,
      report: triageReport('low'),
    });

    const result = await bridgeFailureToSelfHealing({
      execution_id: exec.id,
      failure_stage: 'ci',
    });

    expect(result.outcome).toBe('escalated');
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'dev_autopilot.execution.escalated',
      payload: expect.objectContaining({ reason: 'low_confidence' }),
    }));
  });

  it('escalates when triage itself fails', async () => {
    const { bridgeFailureToSelfHealing } = require('../src/services/dev-autopilot-bridge');
    const exec = execRow();

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (matchUrl(url, '/rest/v1/dev_autopilot_executions?id=eq.') && (!init?.method || init.method === 'GET')) {
        return Promise.resolve(jsonRes(200, [exec]));
      }
      if (matchUrl(url, '/rest/v1/dev_autopilot_config?id=eq.1')) {
        return Promise.resolve(jsonRes(200, [configRow()]));
      }
      if (init?.method === 'PATCH') {
        return Promise.resolve(jsonRes(204, null));
      }
      return Promise.resolve(jsonRes(404, {}));
    });

    (spawnTriageAgent as jest.Mock).mockResolvedValue({
      ok: false,
      error: 'ANTHROPIC_API_KEY not set',
    });

    const result = await bridgeFailureToSelfHealing({
      execution_id: exec.id,
      failure_stage: 'ci',
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('triage_failed');
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'dev_autopilot.execution.escalated',
    }));
  });

  it('is idempotent — already-bridged execution short-circuits', async () => {
    const { bridgeFailureToSelfHealing } = require('../src/services/dev-autopilot-bridge');
    const exec = execRow({
      triage_report: { session_id: 'prior-session', confidence: 'high' },
      self_healing_vtid: 'VTID-DA-prior',
    });

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (matchUrl(url, '/rest/v1/dev_autopilot_executions?id=eq.') && (!init?.method || init.method === 'GET')) {
        return Promise.resolve(jsonRes(200, [exec]));
      }
      return Promise.resolve(jsonRes(404, {}));
    });

    const result = await bridgeFailureToSelfHealing({
      execution_id: exec.id,
      failure_stage: 'ci',
    });

    expect(result.outcome).toBe('already_bridged');
    expect(result.self_healing_vtid).toBe('VTID-DA-prior');
    expect(spawnTriageAgent).not.toHaveBeenCalled();
  });

  it('returns no_execution when the execution row is missing', async () => {
    const { bridgeFailureToSelfHealing } = require('../src/services/dev-autopilot-bridge');
    fetchMock.mockImplementation(() => Promise.resolve(jsonRes(200, [])));

    const result = await bridgeFailureToSelfHealing({
      execution_id: 'does-not-exist',
      failure_stage: 'ci',
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('no_execution');
    expect(spawnTriageAgent).not.toHaveBeenCalled();
  });

  it('uses verification_failure triage mode for verification stage', async () => {
    const { bridgeFailureToSelfHealing } = require('../src/services/dev-autopilot-bridge');
    const exec = execRow();

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (matchUrl(url, '/rest/v1/dev_autopilot_executions?id=eq.') && (!init?.method || init.method === 'GET')) {
        return Promise.resolve(jsonRes(200, [exec]));
      }
      if (matchUrl(url, '/rest/v1/dev_autopilot_config?id=eq.1')) {
        return Promise.resolve(jsonRes(200, [configRow()]));
      }
      if (init?.method === 'POST') return Promise.resolve(jsonRes(201, {}));
      if (init?.method === 'PATCH') return Promise.resolve(jsonRes(204, null));
      return Promise.resolve(jsonRes(404, {}));
    });

    (spawnTriageAgent as jest.Mock).mockResolvedValue({
      ok: true,
      report: triageReport('high', { mode: 'verification_failure' }),
    });

    await bridgeFailureToSelfHealing({
      execution_id: exec.id,
      failure_stage: 'verification',
      verification_result: { broken_endpoints: ['/api/v1/foo'] },
      blast_radius: { affected: 1 },
    });

    expect(spawnTriageAgent).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'verification_failure',
      failure_class: 'verification',
      verification_result: { broken_endpoints: ['/api/v1/foo'] },
      blast_radius: { affected: 1 },
    }));
  });

  it('kill switch forces escalation even with high confidence', async () => {
    const { bridgeFailureToSelfHealing } = require('../src/services/dev-autopilot-bridge');
    const exec = execRow({ auto_fix_depth: 0 });

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (matchUrl(url, '/rest/v1/dev_autopilot_executions?id=eq.') && (!init?.method || init.method === 'GET')) {
        return Promise.resolve(jsonRes(200, [exec]));
      }
      if (matchUrl(url, '/rest/v1/dev_autopilot_config?id=eq.1')) {
        return Promise.resolve(jsonRes(200, [configRow({ kill_switch: true })]));
      }
      if (init?.method === 'PATCH') return Promise.resolve(jsonRes(204, null));
      return Promise.resolve(jsonRes(404, {}));
    });

    (spawnTriageAgent as jest.Mock).mockResolvedValue({
      ok: true,
      report: triageReport('high'),
    });

    const result = await bridgeFailureToSelfHealing({
      execution_id: exec.id,
      failure_stage: 'ci',
    });

    expect(result.outcome).toBe('escalated');
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'dev_autopilot.execution.escalated',
      payload: expect.objectContaining({ reason: 'kill_switch_armed' }),
    }));
  });
});

// =============================================================================
// revertExecutionPR — DRY_RUN behavior per stage
// =============================================================================

describe('revertExecutionPR (DRY_RUN)', () => {
  it('returns a closed-dry-run marker URL for CI stage failures with a PR', async () => {
    const { revertExecutionPR } = require('../src/services/dev-autopilot-bridge');
    const exec = {
      id: 'abc12345',
      pr_url: 'https://github.com/exafyltd/vitana-platform/pull/123',
      pr_number: 123,
      branch: 'dev-autopilot/abc',
    };
    const r = await revertExecutionPR(exec, 'ci');
    expect(r.ok).toBe(true);
    expect(r.revert_pr_url).toMatch(/closed-dry-run/);
  });

  it('returns a REVERT- marker URL for deploy/verification stage failures', async () => {
    const { revertExecutionPR } = require('../src/services/dev-autopilot-bridge');
    const exec = {
      id: 'abcdef1234567890',
      pr_url: 'https://github.com/exafyltd/vitana-platform/pull/456',
      pr_number: 456,
      branch: 'dev-autopilot/abcdef12',
    };
    const deploy = await revertExecutionPR(exec, 'deploy');
    expect(deploy.ok).toBe(true);
    expect(deploy.revert_pr_url).toMatch(/\/pull\/REVERT-/);

    const verif = await revertExecutionPR(exec, 'verification');
    expect(verif.ok).toBe(true);
    expect(verif.revert_pr_url).toMatch(/\/pull\/REVERT-/);
  });

  it('is a no-op when the execution never produced a PR', async () => {
    const { revertExecutionPR } = require('../src/services/dev-autopilot-bridge');
    const exec = { id: 'abc', pr_url: null };
    const r = await revertExecutionPR(exec, 'ci');
    expect(r.ok).toBe(true);
    expect(r.revert_pr_url).toBeUndefined();
  });
});
