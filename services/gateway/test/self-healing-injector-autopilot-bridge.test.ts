/**
 * PR-A (VTID-02922): self-healing injector bridges into Dev Autopilot
 * executions so the proven patch-workspace + real-PR pipeline runs instead
 * of worker-runner's describe-only LLM call. Tests cover:
 *
 *   1. First injection writes both autopilot_recommendations and
 *      dev_autopilot_executions rows and records execution_id on
 *      vtid_ledger.metadata.
 *   2. A second injection with the same dedupe key (endpoint + failure_class
 *      + spec_hash) DOES NOT write a new recommendation/execution — it
 *      reuses the existing in-flight execution_id.
 *   3. Voice synthetic endpoints skip the autopilot bridge entirely (they
 *      have their own Synthetic Voice Probe path).
 */

jest.mock('../src/services/dev-autopilot-execute', () => ({
  bridgeActivationToExecution: jest.fn(),
}));

import { bridgeActivationToExecution } from '../src/services/dev-autopilot-execute';
import { injectIntoAutopilotPipeline } from '../src/services/self-healing-injector-service';
import type { Diagnosis } from '../src/types/self-healing';

const bridgeMock = bridgeActivationToExecution as unknown as jest.Mock;
const ORIGINAL_FETCH = global.fetch;

function makeDiagnosis(overrides: Partial<Diagnosis> = {}): Diagnosis {
  return {
    service_name: 'Availability Health',
    endpoint: '/api/v1/availability/health',
    vtid: 'VTID-99999',
    failure_class: 'route_not_registered' as any,
    confidence: 0.9,
    root_cause: 'Route file missing on disk',
    suggested_fix: 'Add health handler',
    auto_fixable: true,
    evidence: ['handler not found'],
    codebase_analysis: null,
    git_analysis: null,
    dependency_analysis: null,
    workflow_analysis: null,
    files_to_modify: ['services/gateway/src/routes/availability.ts'],
    files_read: [],
    ...overrides,
  };
}

interface MockState {
  existingRecommendations: Array<{ id: string; status: string }>;
  existingActiveExecution: { id: string; status: string } | null;
  recommendationInserts: any[];
  planVersionInserts: any[];
  ledgerPatches: any[];
}

function setupFetchMock(state: MockState): void {
  global.fetch = jest.fn().mockImplementation(async (url: string, init?: any) => {
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(init.body) : null;

    // 1. Dedupe lookup against autopilot_recommendations
    if (url.includes('/rest/v1/autopilot_recommendations?') && url.includes('spec_snapshot->>dedupe_key=eq.')) {
      return {
        ok: true,
        json: () => Promise.resolve(state.existingRecommendations),
      };
    }

    // 2. In-flight execution check for an existing recommendation
    if (url.includes('/rest/v1/dev_autopilot_executions?finding_id=eq.')) {
      return {
        ok: true,
        json: () => Promise.resolve(state.existingActiveExecution ? [state.existingActiveExecution] : []),
      };
    }

    // 3. Recommendation INSERT
    if (url.endsWith('/rest/v1/autopilot_recommendations') && method === 'POST') {
      state.recommendationInserts.push(body);
      return {
        ok: true,
        text: () => Promise.resolve('[{"id":"finding-uuid-001"}]'),
        json: () => Promise.resolve([{ id: 'finding-uuid-001' }]),
      };
    }

    // 4. Plan version INSERT
    if (url.endsWith('/rest/v1/dev_autopilot_plan_versions') && method === 'POST') {
      state.planVersionInserts.push(body);
      return { ok: true, text: () => Promise.resolve(''), json: () => Promise.resolve([]) };
    }

    // 5. vtid_ledger PATCHes (initial + post-bridge metadata write)
    if (url.includes('/rest/v1/vtid_ledger?vtid=eq.') && method === 'PATCH') {
      state.ledgerPatches.push(body);
      return { ok: true, text: () => Promise.resolve(''), json: () => Promise.resolve([]) };
    }

    // 6. self_healing_log insert (best-effort, ignored)
    if (url.endsWith('/rest/v1/self_healing_log') && method === 'POST') {
      return { ok: true, text: () => Promise.resolve(''), json: () => Promise.resolve([]) };
    }

    return { ok: true, text: () => Promise.resolve(''), json: () => Promise.resolve([]) };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE = 'svc-role';
  bridgeMock.mockReset();
  bridgeMock.mockResolvedValue({ ok: true, execution_id: 'exec-uuid-abc12345', skipped: undefined });
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

describe('injectIntoAutopilotPipeline — autopilot bridge', () => {
  it('first injection writes recommendation + plan_version + execution link', async () => {
    const state: MockState = {
      existingRecommendations: [],
      existingActiveExecution: null,
      recommendationInserts: [],
      planVersionInserts: [],
      ledgerPatches: [],
    };
    setupFetchMock(state);
    const diagnosis = makeDiagnosis();

    const result = await injectIntoAutopilotPipeline('VTID-99999', diagnosis, 'spec markdown', 'hash-abc');

    expect(result.success).toBe(true);
    expect(state.recommendationInserts.length).toBe(1);
    expect(state.planVersionInserts.length).toBe(1);
    expect(bridgeMock).toHaveBeenCalledTimes(1);
    expect(bridgeMock.mock.calls[0][0]).toBe('finding-uuid-001');

    // Recommendation carries the self-healing scanner marker.
    const rec = state.recommendationInserts[0];
    expect(rec.source_type).toBe('dev_autopilot');
    expect(rec.spec_snapshot.scanner).toBe('self-healing');
    expect(typeof rec.spec_snapshot.dedupe_key).toBe('string');
    expect(rec.spec_snapshot.dedupe_key.length).toBe(64); // sha256 hex

    // PR-H (VTID-02947): plan markdown is the original spec PLUS a
    // "Required repair deliverables" footer with paired source+test
    // paths. The footer is appended (not replacing the diagnosis).
    expect(state.planVersionInserts[0].plan_markdown).toMatch(/^spec markdown/);
    expect(state.planVersionInserts[0].plan_markdown).toContain('Required repair deliverables');
    // PR-H: files_referenced now includes both source AND derived test path.
    expect(state.planVersionInserts[0].files_referenced).toContain(
      'services/gateway/src/routes/availability.ts',
    );
    expect(state.planVersionInserts[0].files_referenced).toContain(
      'services/gateway/test/availability.test.ts',
    );

    // Ledger is patched twice: once initially (status=scheduled), then post-bridge
    // with autopilot_execution_id in metadata.
    expect(state.ledgerPatches.length).toBeGreaterThanOrEqual(2);
    const lastPatch = state.ledgerPatches[state.ledgerPatches.length - 1];
    expect(lastPatch.metadata.autopilot_execution_id).toBe('exec-uuid-abc12345');
    expect(lastPatch.metadata.autopilot_finding_id).toBe('finding-uuid-001');
    expect(lastPatch.metadata.healing_state).toBe('execution_dispatched');
  });

  it('second injection with same dedupe key reuses the existing execution', async () => {
    const state: MockState = {
      existingRecommendations: [{ id: 'finding-uuid-existing', status: 'new' }],
      existingActiveExecution: { id: 'exec-uuid-existing', status: 'running' },
      recommendationInserts: [],
      planVersionInserts: [],
      ledgerPatches: [],
    };
    setupFetchMock(state);
    const diagnosis = makeDiagnosis();

    const result = await injectIntoAutopilotPipeline('VTID-99999', diagnosis, 'spec markdown', 'hash-abc');

    expect(result.success).toBe(true);
    // No new recommendation / plan_version / execution.
    expect(state.recommendationInserts.length).toBe(0);
    expect(state.planVersionInserts.length).toBe(0);
    expect(bridgeMock).not.toHaveBeenCalled();
    // Ledger should be patched with the existing execution_id.
    const patchedWithExec = state.ledgerPatches.some(
      p => p.metadata?.autopilot_execution_id === 'exec-uuid-existing',
    );
    expect(patchedWithExec).toBe(true);
  });

  it('voice synthetic endpoints skip the autopilot bridge entirely', async () => {
    const state: MockState = {
      existingRecommendations: [],
      existingActiveExecution: null,
      recommendationInserts: [],
      planVersionInserts: [],
      ledgerPatches: [],
    };
    setupFetchMock(state);
    const diagnosis = makeDiagnosis({ endpoint: 'voice-error://no_audio_in' });

    const result = await injectIntoAutopilotPipeline('VTID-99998', diagnosis, 'voice spec', 'hash-voice');

    expect(result.success).toBe(true);
    // Voice still PATCHes vtid_ledger initially but NEVER writes
    // autopilot_recommendations / plan_versions / calls the bridge.
    expect(state.recommendationInserts.length).toBe(0);
    expect(state.planVersionInserts.length).toBe(0);
    expect(bridgeMock).not.toHaveBeenCalled();
    // No PATCH carries autopilot_execution_id.
    const carriesExecId = state.ledgerPatches.some(p => p.metadata?.autopilot_execution_id);
    expect(carriesExecId).toBe(false);
  });

  it('bridge failure does not break the injector (worker-runner gate catches it)', async () => {
    const state: MockState = {
      existingRecommendations: [],
      existingActiveExecution: null,
      recommendationInserts: [],
      planVersionInserts: [],
      ledgerPatches: [],
    };
    setupFetchMock(state);
    bridgeMock.mockResolvedValue({ ok: false, error: 'plan generation failed' });
    const diagnosis = makeDiagnosis();

    const result = await injectIntoAutopilotPipeline('VTID-99997', diagnosis, 'spec', 'hash-fail');

    // Injection itself succeeds (vtid_ledger initial PATCH worked).
    expect(result.success).toBe(true);
    // Bridge was attempted and failed.
    expect(bridgeMock).toHaveBeenCalledTimes(1);
    // No PATCH carried autopilot_execution_id (the bridge failed).
    const carriesExecId = state.ledgerPatches.some(p => p.metadata?.autopilot_execution_id);
    expect(carriesExecId).toBe(false);
  });
});
