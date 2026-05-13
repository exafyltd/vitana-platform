/**
 * PR-J (VTID-02952): autopilot-controller terminal-write gate.
 *
 * The autopilot run state machine in `autopilot-controller.ts` has its
 * own `markCompleted` path that calls `updateLedgerTerminal` to PATCH
 * `vtid_ledger.terminal_outcome='success'` directly — independently
 * from the `/api/v1/oasis/vtid/terminalize` endpoint (PR-E gate). Its
 * verification trigger fires from `/api/v1/autopilot/controller/runs/
 * :vtid/verify`, which uses a generic /alive probe — NOT the actual
 * self-healed endpoint. So for self-healing VTIDs the controller can
 * mark them success while their repair PR is still in CI, has not
 * merged, and the actual healed endpoint has not been verified.
 *
 * Observed live on VTID-02951 at 00:40:39 UTC 2026-05-13:
 *   - dev_autopilot_executions.status='running' (Cloud Run Job mid-flight)
 *   - PR not yet opened (pr_url=null)
 *   - /health still returning 500 (canary armed)
 *   - vtid_ledger.terminal_outcome flipped to 'success' anyway
 *
 * PR-J adds the same gate as PR-E: refuse to write 'success' for any
 * self-healing VTID unless its linked dev_autopilot_executions row has
 * reached status='completed'. Failed terminations and non-self-healing
 * VTIDs go through unchanged.
 */

import { updateLedgerTerminal } from '../src/services/autopilot-controller';

const ORIGINAL_FETCH = global.fetch;

interface MockState {
  ledgerMetadata: Record<string, unknown> | null;
  executionStatus: string | 'missing' | null;
  patches: any[];
  blockedEvents: any[];
}

function mockFetch(state: MockState) {
  global.fetch = jest.fn().mockImplementation(async (url: string, init?: any) => {
    // SELECT vtid_ledger.metadata for the gate's source check
    if (url.includes('/rest/v1/vtid_ledger') && url.includes('select=metadata')) {
      return {
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            state.ledgerMetadata !== null ? [{ metadata: state.ledgerMetadata }] : [],
          ),
      };
    }
    // SELECT dev_autopilot_executions for the gate's status check
    if (url.includes('/rest/v1/dev_autopilot_executions?id=eq.')) {
      if (state.executionStatus === 'missing' || state.executionStatus === null) {
        return { ok: true, status: 200, json: () => Promise.resolve([]) };
      }
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve([{ status: state.executionStatus }]),
      };
    }
    // PATCH vtid_ledger — this is what we're gating against
    if (url.includes('/rest/v1/vtid_ledger') && init?.method === 'PATCH') {
      state.patches.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: () => Promise.resolve([]) };
    }
    // POST oasis_events — capture only the blocked-by-gate events
    if (url.includes('/rest/v1/oasis_events') && init?.method === 'POST') {
      try {
        const body = JSON.parse(init.body);
        if (body?.topic === 'self-healing.terminalize.blocked') {
          state.blockedEvents.push(body);
        }
      } catch { /* ignore */ }
      return { ok: true, status: 200, json: () => Promise.resolve({}) };
    }
    return { ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE = 'svc-role';
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

describe('autopilot-controller updateLedgerTerminal — PR-J self-healing gate', () => {
  it('BLOCKS success for self-healing VTID when execution.status="running"', async () => {
    const state: MockState = {
      ledgerMetadata: { source: 'self-healing', autopilot_execution_id: 'exec-uuid-running' },
      executionStatus: 'running',
      patches: [],
      blockedEvents: [],
    };
    mockFetch(state);

    await updateLedgerTerminal('VTID-02951', 'success');

    expect(state.patches).toEqual([]);
    expect(state.blockedEvents).toHaveLength(1);
    expect(state.blockedEvents[0].metadata.reason).toBe('autopilot_not_completed');
    expect(state.blockedEvents[0].metadata.autopilot_status).toBe('running');
    expect(state.blockedEvents[0].metadata.governance_vtid).toBe('VTID-02952');
  });

  it('BLOCKS success for self-healing VTID when execution.status="ci" (PR open, CI running)', async () => {
    const state: MockState = {
      ledgerMetadata: { source: 'self-healing', autopilot_execution_id: 'exec-uuid-ci' },
      executionStatus: 'ci',
      patches: [],
      blockedEvents: [],
    };
    mockFetch(state);

    await updateLedgerTerminal('VTID-02951', 'success');

    expect(state.patches).toEqual([]);
    expect(state.blockedEvents).toHaveLength(1);
    expect(state.blockedEvents[0].metadata.autopilot_status).toBe('ci');
  });

  it('BLOCKS success for self-healing VTID when autopilot_execution_id is missing from metadata', async () => {
    const state: MockState = {
      ledgerMetadata: { source: 'self-healing' /* no autopilot_execution_id */ },
      executionStatus: null,
      patches: [],
      blockedEvents: [],
    };
    mockFetch(state);

    await updateLedgerTerminal('VTID-02951', 'success');

    expect(state.patches).toEqual([]);
    expect(state.blockedEvents).toHaveLength(1);
    expect(state.blockedEvents[0].metadata.reason).toBe('missing_autopilot_execution_id');
  });

  it('BLOCKS success for self-healing VTID when linked execution row is gone', async () => {
    const state: MockState = {
      ledgerMetadata: { source: 'self-healing', autopilot_execution_id: 'exec-deleted' },
      executionStatus: 'missing',
      patches: [],
      blockedEvents: [],
    };
    mockFetch(state);

    await updateLedgerTerminal('VTID-02951', 'success');

    expect(state.patches).toEqual([]);
    expect(state.blockedEvents).toHaveLength(1);
    expect(state.blockedEvents[0].metadata.reason).toBe('autopilot_not_completed');
    expect(state.blockedEvents[0].metadata.autopilot_status).toBe('missing');
  });

  it('ALLOWS success for self-healing VTID when execution.status="completed"', async () => {
    const state: MockState = {
      ledgerMetadata: { source: 'self-healing', autopilot_execution_id: 'exec-uuid-done' },
      executionStatus: 'completed',
      patches: [],
      blockedEvents: [],
    };
    mockFetch(state);

    await updateLedgerTerminal('VTID-02951', 'success');

    expect(state.patches).toHaveLength(1);
    expect(state.patches[0].body.terminal_outcome).toBe('success');
    expect(state.patches[0].body.is_terminal).toBe(true);
    expect(state.blockedEvents).toEqual([]);
  });

  it('ALLOWS success for non-self-healing VTID regardless of execution state', async () => {
    const state: MockState = {
      ledgerMetadata: { source: 'autopilot-recommendation' /* not self-healing */ },
      executionStatus: 'running',
      patches: [],
      blockedEvents: [],
    };
    mockFetch(state);

    await updateLedgerTerminal('VTID-02000', 'success');

    expect(state.patches).toHaveLength(1);
    expect(state.patches[0].body.terminal_outcome).toBe('success');
    expect(state.blockedEvents).toEqual([]);
  });

  it('ALLOWS success for VTID with no metadata at all (legacy autopilot run)', async () => {
    const state: MockState = {
      ledgerMetadata: {},
      executionStatus: null,
      patches: [],
      blockedEvents: [],
    };
    mockFetch(state);

    await updateLedgerTerminal('VTID-01999', 'success');

    expect(state.patches).toHaveLength(1);
    expect(state.patches[0].body.terminal_outcome).toBe('success');
  });

  it('ALLOWS failed termination for self-healing VTID without checking execution (failure path is not gated)', async () => {
    const state: MockState = {
      ledgerMetadata: { source: 'self-healing', autopilot_execution_id: 'exec-uuid-running' },
      executionStatus: 'running',
      patches: [],
      blockedEvents: [],
    };
    mockFetch(state);

    await updateLedgerTerminal('VTID-02951', 'failed');

    expect(state.patches).toHaveLength(1);
    expect(state.patches[0].body.terminal_outcome).toBe('failed');
    expect(state.patches[0].body.status).toBe('rejected');
    expect(state.blockedEvents).toEqual([]);
  });
});
