/**
 * PR-A (VTID-02922): the self-healing reconciler — NOT the worker-runner —
 * owns final terminal_outcome for self-healing VTIDs that were bridged into
 * the Dev Autopilot execution pipeline. This scan reads
 * dev_autopilot_executions.status for each linked row and:
 *
 *   - status='completed'                              → terminalize 'success'
 *   - status in (failed, failed_escalated, reverted)  → terminalize 'failed'
 *   - any in-flight status (cooling/running/ci/...)    → leave alone
 *
 * Worker-runner's 'pr_ready' completion only clears the repair-evidence
 * gate; this scan is what flips terminal_outcome=success after CI green
 * + deploy + live probe. Verified by inspecting which PATCH bodies hit
 * vtid_ledger / self_healing_log.
 */

import { reconcileAutopilotLinkedSelfHealingVtids } from '../src/services/self-healing-reconciler';

const ORIGINAL_FETCH = global.fetch;

interface MockState {
  ledgerRows: Array<{
    vtid: string;
    metadata: any;
  }>;
  executionRowsById: Record<string, {
    id: string;
    status: string;
    pr_url: string | null;
    pr_number: number | null;
    branch: string | null;
    metadata: any;
    completed_at: string | null;
  }>;
  ledgerPatches: Array<{ vtid: string; body: any }>;
  selfHealingLogPatches: Array<{ vtid: string; body: any }>;
}

function setupFetchMock(state: MockState) {
  global.fetch = jest.fn().mockImplementation(async (url: string, init?: any) => {
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(init.body) : null;

    // 1. Scan for self-healing VTIDs with autopilot_execution_id
    if (url.includes('/rest/v1/vtid_ledger?metadata->>source=eq.self-healing')) {
      return { ok: true, json: () => Promise.resolve(state.ledgerRows) };
    }

    // 2. Per-execution lookup
    const execMatch = url.match(/dev_autopilot_executions\?id=eq\.([^&]+)/);
    if (execMatch && method === 'GET') {
      const id = decodeURIComponent(execMatch[1]);
      const row = state.executionRowsById[id];
      return { ok: true, json: () => Promise.resolve(row ? [row] : []) };
    }

    // 3. vtid_ledger PATCH (terminalize)
    const ledgerPatchMatch = url.match(/vtid_ledger\?vtid=eq\.([^&]+)/);
    if (ledgerPatchMatch && method === 'PATCH') {
      state.ledgerPatches.push({ vtid: decodeURIComponent(ledgerPatchMatch[1]), body });
      return { ok: true, text: () => Promise.resolve('') };
    }

    // 4. self_healing_log PATCH
    const shLogPatchMatch = url.match(/self_healing_log\?vtid=eq\.([^&]+)/);
    if (shLogPatchMatch && method === 'PATCH') {
      state.selfHealingLogPatches.push({ vtid: decodeURIComponent(shLogPatchMatch[1]), body });
      return { ok: true, text: () => Promise.resolve('') };
    }

    return { ok: true, json: () => Promise.resolve([]) };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE = 'svc-role';
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

describe('reconcileAutopilotLinkedSelfHealingVtids', () => {
  it('terminalizes success when execution.status=completed', async () => {
    const state: MockState = {
      ledgerRows: [{
        vtid: 'VTID-90001',
        metadata: { source: 'self-healing', autopilot_execution_id: 'exec-good-001' },
      }],
      executionRowsById: {
        'exec-good-001': {
          id: 'exec-good-001',
          status: 'completed',
          pr_url: 'https://github.com/exafyltd/vitana-platform/pull/9999',
          pr_number: 9999,
          branch: 'fix/canary',
          metadata: { merged_sha: 'abc1234567' },
          completed_at: new Date().toISOString(),
        },
      },
      ledgerPatches: [],
      selfHealingLogPatches: [],
    };
    setupFetchMock(state);

    await reconcileAutopilotLinkedSelfHealingVtids();

    expect(state.ledgerPatches.length).toBe(1);
    const ledger = state.ledgerPatches[0];
    expect(ledger.vtid).toBe('VTID-90001');
    expect(ledger.body.status).toBe('completed');
    expect(ledger.body.is_terminal).toBe(true);
    expect(ledger.body.terminal_outcome).toBe('success');
    expect(ledger.body.metadata.healing_state).toBe('verified_healed');
    expect(ledger.body.metadata.pr_url).toBe('https://github.com/exafyltd/vitana-platform/pull/9999');

    expect(state.selfHealingLogPatches.length).toBe(1);
    expect(state.selfHealingLogPatches[0].body.outcome).toBe('fixed');
  });

  it('terminalizes failed when execution.status=failed', async () => {
    const state: MockState = {
      ledgerRows: [{
        vtid: 'VTID-90002',
        metadata: { source: 'self-healing', autopilot_execution_id: 'exec-bad-002' },
      }],
      executionRowsById: {
        'exec-bad-002': {
          id: 'exec-bad-002',
          status: 'failed',
          pr_url: null,
          pr_number: null,
          branch: null,
          metadata: { error: 'jest validation failed across 3 attempts' },
          completed_at: new Date().toISOString(),
        },
      },
      ledgerPatches: [],
      selfHealingLogPatches: [],
    };
    setupFetchMock(state);

    await reconcileAutopilotLinkedSelfHealingVtids();

    expect(state.ledgerPatches.length).toBe(1);
    const ledger = state.ledgerPatches[0];
    expect(ledger.body.is_terminal).toBe(true);
    expect(ledger.body.terminal_outcome).toBe('failed');
    expect(ledger.body.metadata.healing_state).toBe('execution_failed');
    expect(ledger.body.metadata.execution_failure_error).toContain('jest validation failed');

    expect(state.selfHealingLogPatches[0].body.outcome).toBe('escalated');
  });

  it('terminalizes failed when execution.status=failed_escalated', async () => {
    const state: MockState = {
      ledgerRows: [{
        vtid: 'VTID-90003',
        metadata: { source: 'self-healing', autopilot_execution_id: 'exec-esc-003' },
      }],
      executionRowsById: {
        'exec-esc-003': {
          id: 'exec-esc-003',
          status: 'failed_escalated',
          pr_url: null,
          pr_number: null,
          branch: null,
          metadata: {},
          completed_at: new Date().toISOString(),
        },
      },
      ledgerPatches: [],
      selfHealingLogPatches: [],
    };
    setupFetchMock(state);

    await reconcileAutopilotLinkedSelfHealingVtids();

    expect(state.ledgerPatches.length).toBe(1);
    expect(state.ledgerPatches[0].body.terminal_outcome).toBe('failed');
  });

  it.each([
    ['cooling'], ['queued'], ['running'], ['ci'], ['merging'], ['deploying'], ['verifying'],
  ])('leaves VTID alone when execution.status=%s (still in flight)', async (status) => {
    const state: MockState = {
      ledgerRows: [{
        vtid: 'VTID-90099',
        metadata: { source: 'self-healing', autopilot_execution_id: 'exec-inflight' },
      }],
      executionRowsById: {
        'exec-inflight': {
          id: 'exec-inflight',
          status,
          pr_url: status === 'ci' || status === 'merging' ? 'https://github.com/x/y/pull/1' : null,
          pr_number: status === 'ci' || status === 'merging' ? 1 : null,
          branch: null,
          metadata: {},
          completed_at: null,
        },
      },
      ledgerPatches: [],
      selfHealingLogPatches: [],
    };
    setupFetchMock(state);

    await reconcileAutopilotLinkedSelfHealingVtids();

    expect(state.ledgerPatches.length).toBe(0);
    expect(state.selfHealingLogPatches.length).toBe(0);
  });

  it('handles multiple rows in one scan (success + failure mixed)', async () => {
    const state: MockState = {
      ledgerRows: [
        { vtid: 'VTID-A', metadata: { source: 'self-healing', autopilot_execution_id: 'exec-A' } },
        { vtid: 'VTID-B', metadata: { source: 'self-healing', autopilot_execution_id: 'exec-B' } },
        { vtid: 'VTID-C', metadata: { source: 'self-healing', autopilot_execution_id: 'exec-C' } },
      ],
      executionRowsById: {
        'exec-A': { id: 'exec-A', status: 'completed', pr_url: 'a', pr_number: 1, branch: 'a', metadata: {}, completed_at: null },
        'exec-B': { id: 'exec-B', status: 'running', pr_url: null, pr_number: null, branch: null, metadata: {}, completed_at: null },
        'exec-C': { id: 'exec-C', status: 'reverted', pr_url: null, pr_number: null, branch: null, metadata: {}, completed_at: null },
      },
      ledgerPatches: [],
      selfHealingLogPatches: [],
    };
    setupFetchMock(state);

    await reconcileAutopilotLinkedSelfHealingVtids();

    expect(state.ledgerPatches.map(p => p.vtid).sort()).toEqual(['VTID-A', 'VTID-C']);
    const aPatch = state.ledgerPatches.find(p => p.vtid === 'VTID-A')!;
    expect(aPatch.body.terminal_outcome).toBe('success');
    const cPatch = state.ledgerPatches.find(p => p.vtid === 'VTID-C')!;
    expect(cPatch.body.terminal_outcome).toBe('failed');
  });

  it('no-op when no autopilot-linked self-healing rows exist', async () => {
    const state: MockState = {
      ledgerRows: [],
      executionRowsById: {},
      ledgerPatches: [],
      selfHealingLogPatches: [],
    };
    setupFetchMock(state);

    await reconcileAutopilotLinkedSelfHealingVtids();

    expect(state.ledgerPatches.length).toBe(0);
  });
});
