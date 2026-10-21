/**
 * PR-E (VTID-02931, Gap 1): the /api/v1/oasis/vtid/terminalize endpoint
 * must hard-block terminal_outcome='success' for self-healing VTIDs
 * unless their linked dev_autopilot_executions row has reached
 * status='completed'.
 *
 * Healing definition: no PR → not healed; PR opened but CI/deploy/verify
 * in flight → not healed; only execution.status='completed' (CI green +
 * deploy + live probe) counts as healed. The self-healing reconciler is
 * the only authorized writer of success for self-healing VTIDs, and it
 * goes through a direct Supabase PATCH (bypassing this endpoint). Any
 * other caller — including a misbehaving worker-runner — gets blocked
 * here with 400.
 *
 * Non-self-healing VTIDs are unaffected — they continue through the
 * normal VTID-01204 pipeline-integrity gate.
 */

import express from 'express';
import request from 'supertest';
import router from '../src/routes/vtid-terminalize';

const ORIGINAL_FETCH = global.fetch;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE = 'svc-role';
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

interface MockState {
  ledgerTask: any;
  executionStatus: string | 'missing';
  patches: any[];
}

function mockFetch(state: MockState) {
  global.fetch = jest.fn().mockImplementation(async (url: string, init?: any) => {
    if (url.includes('/rest/v1/vtid_ledger') && (!init?.method || init.method === 'GET')) {
      return { ok: true, status: 200, json: () => Promise.resolve(state.ledgerTask ? [state.ledgerTask] : []) };
    }
    if (url.includes('/rest/v1/vtid_ledger') && init?.method === 'PATCH') {
      state.patches.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: () => Promise.resolve([]) };
    }
    if (url.includes('/rest/v1/dev_autopilot_executions?id=eq.')) {
      if (state.executionStatus === 'missing') {
        return { ok: true, status: 200, json: () => Promise.resolve([]) };
      }
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve([{ id: 'exec-1', status: state.executionStatus, pr_url: 'https://x/y/pull/1', pr_number: 1 }]),
      };
    }
    // OASIS event POSTs + Supabase RPC catch-all
    return { ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') };
  }) as unknown as typeof fetch;
}

const baseSelfHealingTask = {
  vtid: 'VTID-00001',
  status: 'in_progress',
  is_terminal: false,
  metadata: {
    source: 'self-healing',
    autopilot_execution_id: 'exec-uuid-1',
  },
};

describe('POST /api/v1/oasis/vtid/terminalize — self-healing gate (PR-E)', () => {
  it('400 when self-healing VTID has NO autopilot_execution_id and outcome=success', async () => {
    const state: MockState = {
      ledgerTask: {
        ...baseSelfHealingTask,
        metadata: { source: 'self-healing' }, // no execution_id
      },
      executionStatus: 'missing',
      patches: [],
    };
    mockFetch(state);

    const res = await request(buildApp())
      .post('/api/v1/oasis/vtid/terminalize')
      .send({ vtid: 'VTID-00001', outcome: 'success', actor: 'autodeploy' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SELF_HEALING_NO_AUTOPILOT_BRIDGE');
    expect(state.patches.length).toBe(0); // no terminal patch happened
  });

  it('400 when self-healing VTID has bridge but execution.status is in flight', async () => {
    const inflightStatuses = ['queued', 'cooling', 'running', 'ci', 'merging', 'deploying', 'verifying'];
    for (const status of inflightStatuses) {
      const state: MockState = {
        ledgerTask: baseSelfHealingTask,
        executionStatus: status,
        patches: [],
      };
      mockFetch(state);

      const res = await request(buildApp())
        .post('/api/v1/oasis/vtid/terminalize')
        .send({ vtid: 'VTID-00001', outcome: 'success', actor: 'autodeploy' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('SELF_HEALING_AUTOPILOT_NOT_COMPLETED');
      expect(res.body.autopilot_status).toBe(status);
      expect(state.patches.length).toBe(0);
    }
  });

  it('400 when self-healing VTID has bridge but execution.status is failed', async () => {
    const state: MockState = {
      ledgerTask: baseSelfHealingTask,
      executionStatus: 'failed',
      patches: [],
    };
    mockFetch(state);

    const res = await request(buildApp())
      .post('/api/v1/oasis/vtid/terminalize')
      .send({ vtid: 'VTID-00001', outcome: 'success', actor: 'autodeploy' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SELF_HEALING_AUTOPILOT_NOT_COMPLETED');
    expect(res.body.autopilot_status).toBe('failed');
  });

  it('allows success when self-healing VTID has bridge AND execution.status=completed', async () => {
    const state: MockState = {
      ledgerTask: baseSelfHealingTask,
      executionStatus: 'completed',
      patches: [],
    };
    mockFetch(state);

    // The endpoint will then go through the existing VTID-01204 pipeline
    // gate, which may also block (no real PR events) — that's fine, we're
    // only asserting OUR gate doesn't fire for execution.status=completed.
    const res = await request(buildApp())
      .post('/api/v1/oasis/vtid/terminalize')
      .send({ vtid: 'VTID-00001', outcome: 'success', actor: 'autodeploy' });

    // The PR-E gate should pass; downstream pipeline-integrity may still
    // reject (it requires PR-created + merged + deploy events too).
    expect(['SELF_HEALING_NO_AUTOPILOT_BRIDGE', 'SELF_HEALING_AUTOPILOT_NOT_COMPLETED'])
      .not.toContain(res.body.error);
  });

  it('allows outcome=failed for self-healing VTID regardless of autopilot status', async () => {
    const state: MockState = {
      ledgerTask: baseSelfHealingTask,
      executionStatus: 'failed',
      patches: [],
    };
    mockFetch(state);

    const res = await request(buildApp())
      .post('/api/v1/oasis/vtid/terminalize')
      .send({ vtid: 'VTID-00001', outcome: 'failed', actor: 'autodeploy' });

    expect(['SELF_HEALING_NO_AUTOPILOT_BRIDGE', 'SELF_HEALING_AUTOPILOT_NOT_COMPLETED'])
      .not.toContain(res.body.error);
  });

  it('does NOT apply the self-healing gate to non-self-healing VTIDs', async () => {
    const state: MockState = {
      ledgerTask: {
        vtid: 'VTID-00002',
        status: 'in_progress',
        is_terminal: false,
        metadata: { source: 'dev_autopilot' }, // not self-healing
      },
      executionStatus: 'missing',
      patches: [],
    };
    mockFetch(state);

    const res = await request(buildApp())
      .post('/api/v1/oasis/vtid/terminalize')
      .send({ vtid: 'VTID-00002', outcome: 'success', actor: 'autodeploy' });

    expect(['SELF_HEALING_NO_AUTOPILOT_BRIDGE', 'SELF_HEALING_AUTOPILOT_NOT_COMPLETED'])
      .not.toContain(res.body.error);
  });

  it('idempotent: already-terminal self-healing VTIDs return 200 without re-running the gate', async () => {
    const state: MockState = {
      ledgerTask: {
        ...baseSelfHealingTask,
        is_terminal: true,
        terminal_outcome: 'success',
        completed_at: '2026-05-11T20:00:00Z',
      },
      executionStatus: 'missing', // wouldn't matter — gate is skipped
      patches: [],
    };
    mockFetch(state);

    const res = await request(buildApp())
      .post('/api/v1/oasis/vtid/terminalize')
      .send({ vtid: 'VTID-00001', outcome: 'success', actor: 'autodeploy' });

    expect(res.status).toBe(200);
    expect(res.body.already_terminal).toBe(true);
  });
});
