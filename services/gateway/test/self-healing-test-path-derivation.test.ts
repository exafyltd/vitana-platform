/**
 * PR-H (VTID-02947): the injector must augment self-healing plans with
 * paired test-file paths before bridging to Dev Autopilot.
 *
 * The autopilot safety gate (services/gateway/src/services/dev-autopilot-
 * safety.ts:221) refuses any plan with non-deletion edits and no test
 * file. Self-healing diagnoses never propose tests on their own — so
 * every self-healing plan was being blocked at the safety gate, which
 * surfaced live as "bridgeActivationToExecution failed: safety gate
 * blocked approval" on VTID-02928 / VTID-02939 / VTID-02942 / VTID-02945.
 *
 * Contract enforced by these tests:
 *
 *   1. For source paths under services/gateway/src/**, derive a paired
 *      test path. Existence-aware: prefer the actual existing test file
 *      (flat / mirror-routes / mirror-services), fall back to flat for
 *      not-yet-existing tests.
 *   2. Source paths the deriver can't handle (services/gateway/src/index.ts,
 *      anything outside services/gateway/src/, files without an
 *      extension we recognize) → REFUSE to bridge with reason
 *      SELF_HEALING_TEST_PATH_UNDERIVED. Never feed Dev Autopilot a
 *      plan we know will fail the safety gate.
 *   3. The plan_markdown gets a "Required deliverables" footer with
 *      explicit source+test pairs and create-vs-modify verbs.
 *   4. files_referenced (passed to the autopilot safety gate as
 *      files_to_modify) includes both the source files AND the test
 *      files — the gate's hasTestFile check passes.
 */

jest.mock('../src/services/dev-autopilot-execute', () => ({
  bridgeActivationToExecution: jest.fn(),
}));

jest.mock('../src/services/self-healing-diagnosis-service', () => ({
  loadSourceFile: jest.fn(),
}));

import { bridgeActivationToExecution } from '../src/services/dev-autopilot-execute';
import { loadSourceFile } from '../src/services/self-healing-diagnosis-service';
import { injectIntoAutopilotPipeline } from '../src/services/self-healing-injector-service';
import type { Diagnosis } from '../src/types/self-healing';

const bridgeMock = bridgeActivationToExecution as unknown as jest.Mock;
const loadSourceMock = loadSourceFile as unknown as jest.Mock;
const ORIGINAL_FETCH = global.fetch;

function makeDiagnosis(filesToModify: string[], overrides: Partial<Diagnosis> = {}): Diagnosis {
  return {
    service_name: 'Test Service',
    endpoint: '/api/v1/test/health',
    vtid: 'VTID-99999',
    failure_class: 'route_not_registered' as any,
    confidence: 0.9,
    root_cause: 'route file is missing the health handler',
    suggested_fix: 'add a GET /health route',
    auto_fixable: true,
    evidence: ['handler not found'],
    codebase_analysis: null,
    git_analysis: null,
    dependency_analysis: null,
    workflow_analysis: null,
    files_to_modify: filesToModify,
    files_read: [],
    ...overrides,
  };
}

interface InjectorCalls {
  recommendationInserts: any[];
  planVersionInserts: any[];
  ledgerPatches: any[];
  oasisEvents: any[];
}

function setupGatewayMocks(state: InjectorCalls) {
  global.fetch = jest.fn().mockImplementation(async (url: string, init?: any) => {
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(init.body) : null;

    // Dedupe lookup → no existing recommendations (so each test sees fresh insert path).
    if (url.includes('/rest/v1/autopilot_recommendations?') && url.includes('spec_snapshot->>dedupe_key=eq.')) {
      return { ok: true, json: () => Promise.resolve([]) };
    }
    if (url.includes('/rest/v1/dev_autopilot_executions?finding_id=eq.')) {
      return { ok: true, json: () => Promise.resolve([]) };
    }
    if (url.endsWith('/rest/v1/autopilot_recommendations') && method === 'POST') {
      state.recommendationInserts.push(body);
      return {
        ok: true,
        text: () => Promise.resolve('[{"id":"finding-uuid"}]'),
        json: () => Promise.resolve([{ id: 'finding-uuid' }]),
      };
    }
    if (url.endsWith('/rest/v1/dev_autopilot_plan_versions') && method === 'POST') {
      state.planVersionInserts.push(body);
      return { ok: true, text: () => Promise.resolve(''), json: () => Promise.resolve([]) };
    }
    if (url.includes('/rest/v1/vtid_ledger?vtid=eq.') && method === 'PATCH') {
      state.ledgerPatches.push(body);
      return { ok: true, text: () => Promise.resolve(''), json: () => Promise.resolve([]) };
    }
    if (url.endsWith('/rest/v1/self_healing_log') && method === 'POST') {
      return { ok: true, text: () => Promise.resolve(''), json: () => Promise.resolve([]) };
    }
    if (url.endsWith('/rest/v1/oasis_events') && method === 'POST') {
      state.oasisEvents.push(body);
      return { ok: true, text: () => Promise.resolve(''), json: () => Promise.resolve([]) };
    }
    return { ok: true, text: () => Promise.resolve(''), json: () => Promise.resolve([]) };
  }) as any;
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE = 'svc-role';
  bridgeMock.mockReset();
  bridgeMock.mockResolvedValue({ ok: true, execution_id: 'exec-uuid', skipped: undefined });
  loadSourceMock.mockReset();
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

describe('PR-H — test-path derivation in self-healing injector', () => {
  it('uses an existing test file when one is present (flat default)', async () => {
    // Diagnosis proposes a route file. Test exists at the flat path.
    loadSourceMock.mockImplementation(async (path: string) => {
      if (path === 'services/gateway/test/availability.test.ts') {
        return { found: true, content: '// existing', source: 'fs' };
      }
      return { found: false, source: 'fs' };
    });
    const state: InjectorCalls = { recommendationInserts: [], planVersionInserts: [], ledgerPatches: [], oasisEvents: [] };
    setupGatewayMocks(state);

    await injectIntoAutopilotPipeline(
      'VTID-99999',
      makeDiagnosis(['services/gateway/src/routes/availability.ts']),
      'spec body',
      'hash-flat',
    );

    expect(bridgeMock).toHaveBeenCalledTimes(1);
    expect(state.planVersionInserts.length).toBe(1);
    const plan = state.planVersionInserts[0];
    // Both source AND test in files_referenced.
    expect(plan.files_referenced).toEqual([
      'services/gateway/src/routes/availability.ts',
      'services/gateway/test/availability.test.ts',
    ]);
    // Footer was appended; LLM is told to MODIFY the existing test.
    expect(plan.plan_markdown).toContain('Required repair deliverables');
    expect(plan.plan_markdown).toContain('services/gateway/test/availability.test.ts (modify)');
  });

  it('prefers test/routes/<name>.test.ts when that mirror path exists', async () => {
    loadSourceMock.mockImplementation(async (path: string) => {
      // Flat doesn't exist; mirror does.
      if (path === 'services/gateway/test/routes/admin-autopilot.test.ts') {
        return { found: true, content: '// existing mirror', source: 'fs' };
      }
      return { found: false, source: 'fs' };
    });
    const state: InjectorCalls = { recommendationInserts: [], planVersionInserts: [], ledgerPatches: [], oasisEvents: [] };
    setupGatewayMocks(state);

    await injectIntoAutopilotPipeline(
      'VTID-99999',
      makeDiagnosis(['services/gateway/src/routes/admin-autopilot.ts']),
      'spec body',
      'hash-mirror-routes',
    );

    const plan = state.planVersionInserts[0];
    expect(plan.files_referenced).toContain('services/gateway/test/routes/admin-autopilot.test.ts');
    expect(plan.files_referenced).not.toContain('services/gateway/test/admin-autopilot.test.ts');
    expect(plan.plan_markdown).toContain('test/routes/admin-autopilot.test.ts (modify)');
  });

  it('falls back to the flat test path with create verb when no test exists', async () => {
    loadSourceMock.mockResolvedValue({ found: false, source: 'fs' });
    const state: InjectorCalls = { recommendationInserts: [], planVersionInserts: [], ledgerPatches: [], oasisEvents: [] };
    setupGatewayMocks(state);

    await injectIntoAutopilotPipeline(
      'VTID-99999',
      makeDiagnosis(['services/gateway/src/services/new-helper.ts']),
      'spec body',
      'hash-create',
    );

    const plan = state.planVersionInserts[0];
    expect(plan.files_referenced).toEqual([
      'services/gateway/src/services/new-helper.ts',
      'services/gateway/test/new-helper.test.ts',
    ]);
    expect(plan.plan_markdown).toContain('test/new-helper.test.ts (create)');
  });

  it('REFUSES the bridge when source is services/gateway/src/index.ts', async () => {
    loadSourceMock.mockResolvedValue({ found: false, source: 'fs' });
    const state: InjectorCalls = { recommendationInserts: [], planVersionInserts: [], ledgerPatches: [], oasisEvents: [] };
    setupGatewayMocks(state);

    await injectIntoAutopilotPipeline(
      'VTID-99999',
      makeDiagnosis(['services/gateway/src/index.ts']),
      'spec body',
      'hash-index',
    );

    expect(bridgeMock).not.toHaveBeenCalled();
    expect(state.recommendationInserts.length).toBe(0);
    expect(state.planVersionInserts.length).toBe(0);
    const refusalEvent = state.oasisEvents.find(e =>
      e.topic === 'self-healing.execution.bridge_failed' &&
      String(e.metadata?.reason_code || '').includes('SELF_HEALING_TEST_PATH_UNDERIVED')
    );
    expect(refusalEvent).toBeDefined();
    expect(String(refusalEvent.metadata.underived_sources)).toContain('services/gateway/src/index.ts');
  });

  it('REFUSES the bridge for paths outside services/gateway/src/**', async () => {
    loadSourceMock.mockResolvedValue({ found: false, source: 'fs' });
    const state: InjectorCalls = { recommendationInserts: [], planVersionInserts: [], ledgerPatches: [], oasisEvents: [] };
    setupGatewayMocks(state);

    await injectIntoAutopilotPipeline(
      'VTID-99999',
      makeDiagnosis(['services/agents/orb-agent/src/whatever.py']),
      'spec body',
      'hash-outside',
    );

    expect(bridgeMock).not.toHaveBeenCalled();
    const refusalEvent = state.oasisEvents.find(e =>
      e.topic === 'self-healing.execution.bridge_failed' &&
      String(e.metadata?.reason_code || '').includes('SELF_HEALING_TEST_PATH_UNDERIVED')
    );
    expect(refusalEvent).toBeDefined();
  });

  it('REFUSES the bridge if any one of multiple sources is underived', async () => {
    loadSourceMock.mockResolvedValue({ found: false, source: 'fs' });
    const state: InjectorCalls = { recommendationInserts: [], planVersionInserts: [], ledgerPatches: [], oasisEvents: [] };
    setupGatewayMocks(state);

    await injectIntoAutopilotPipeline(
      'VTID-99999',
      makeDiagnosis([
        'services/gateway/src/routes/good.ts',
        'services/gateway/src/index.ts', // underived
      ]),
      'spec body',
      'hash-mixed',
    );

    expect(bridgeMock).not.toHaveBeenCalled();
    expect(state.planVersionInserts.length).toBe(0);
  });

  it('handles two sources mapping to the same test path without duplicating', async () => {
    loadSourceMock.mockResolvedValue({ found: false, source: 'fs' });
    const state: InjectorCalls = { recommendationInserts: [], planVersionInserts: [], ledgerPatches: [], oasisEvents: [] };
    setupGatewayMocks(state);

    await injectIntoAutopilotPipeline(
      'VTID-99999',
      makeDiagnosis([
        'services/gateway/src/routes/foo.ts',
        'services/gateway/src/services/foo.ts', // same basename → same flat test path
      ]),
      'spec body',
      'hash-dedupe',
    );

    const plan = state.planVersionInserts[0];
    // Two source files, one test file (deduped).
    expect(plan.files_referenced.length).toBe(3);
    expect(plan.files_referenced).toContain('services/gateway/src/routes/foo.ts');
    expect(plan.files_referenced).toContain('services/gateway/src/services/foo.ts');
    expect(plan.files_referenced).toContain('services/gateway/test/foo.test.ts');
  });
});
