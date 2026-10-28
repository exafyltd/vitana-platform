/**
 * PR-A (VTID-02922): /api/v1/worker/orchestrator/await-autopilot-execution
 *
 * Four-state contract: pr_ready | completed | failed | deferred.
 *
 *   - pr_ready  → autopilot opened a PR; CI/deploy/verify still in flight.
 *                  Worker-runner reports completion w/ files_changed so the
 *                  repair-evidence gate clears, BUT the reconciler — not
 *                  the worker — terminalizes success.
 *   - completed → autopilot reached status='completed' (CI green + deploy +
 *                  live probe). Reconciler will set terminal_outcome='success'.
 *   - failed    → autopilot reached failed/failed_escalated/reverted.
 *   - deferred  → autopilot still running past the worker-runner await
 *                  window. Worker releases the claim; reconciler finishes.
 *
 * Auth:
 *   - 400 when vtid / autopilot_execution_id missing
 *   - 401 when worker_id missing or unregistered
 *   - 403 when caller does not hold the claim on the VTID
 */

import express from 'express';
import request from 'supertest';
import { workerOrchestratorRouter } from '../src/routes/worker-orchestrator';

const ORIGINAL_FETCH = global.fetch;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(workerOrchestratorRouter);
  return app;
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE = 'svc-role';
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

interface FetchHandlers {
  workerExists?: boolean;
  ledgerOwner?: { claimed_by: string; claim_expires_at: string | null } | null;
  executionRows?: Array<{
    id: string;
    status: string;
    pr_url: string | null;
    pr_number: number | null;
    branch: string | null;
    metadata: any;
    completed_at: string | null;
  }>;
  prFiles?: Array<{ filename: string; status: string }>;
}

function mockFetch(h: FetchHandlers) {
  global.fetch = jest.fn().mockImplementation(async (url: string) => {
    // 1. worker_registry presence check
    if (url.includes('/rest/v1/worker_registry')) {
      const data = h.workerExists ? [{ worker_id: 'wk-1' }] : [];
      return { ok: true, status: 200, json: () => Promise.resolve(data) };
    }

    // 2. vtid_ledger claim check
    if (url.includes('/rest/v1/vtid_ledger?vtid=eq.')) {
      const data = h.ledgerOwner ? [h.ledgerOwner] : [];
      return { ok: true, status: 200, json: () => Promise.resolve(data) };
    }

    // 3. dev_autopilot_executions polling
    if (url.includes('/rest/v1/dev_autopilot_executions?id=eq.')) {
      return { ok: true, status: 200, json: () => Promise.resolve(h.executionRows || []) };
    }

    // 4. GitHub PR files
    if (url.includes('api.github.com/repos/') && url.includes('/pulls/') && url.includes('/files')) {
      return { ok: true, status: 200, json: () => Promise.resolve(h.prFiles || []) };
    }

    return { ok: true, status: 200, json: () => Promise.resolve({}) };
  }) as unknown as typeof fetch;
}

describe('POST /api/v1/worker/orchestrator/await-autopilot-execution — auth', () => {
  it('400 when vtid is missing', async () => {
    mockFetch({ workerExists: true });
    const res = await request(buildApp())
      .post('/api/v1/worker/orchestrator/await-autopilot-execution')
      .send({ worker_id: 'wk-1', autopilot_execution_id: 'exec-1' });
    expect(res.status).toBe(400);
  });

  it('400 when autopilot_execution_id is missing', async () => {
    mockFetch({ workerExists: true });
    const res = await request(buildApp())
      .post('/api/v1/worker/orchestrator/await-autopilot-execution')
      .send({ vtid: 'VTID-00001', worker_id: 'wk-1' });
    expect(res.status).toBe(400);
  });

  it('401 when worker_id is missing', async () => {
    mockFetch({ workerExists: true });
    const res = await request(buildApp())
      .post('/api/v1/worker/orchestrator/await-autopilot-execution')
      .send({ vtid: 'VTID-00001', autopilot_execution_id: 'exec-1' });
    expect(res.status).toBe(401);
  });

  it('401 when worker is NOT in worker_registry', async () => {
    mockFetch({ workerExists: false });
    const res = await request(buildApp())
      .post('/api/v1/worker/orchestrator/await-autopilot-execution')
      .send({ vtid: 'VTID-00001', autopilot_execution_id: 'exec-1', worker_id: 'wk-x' });
    expect(res.status).toBe(401);
  });

  it('403 when worker does not hold the claim', async () => {
    mockFetch({
      workerExists: true,
      ledgerOwner: { claimed_by: 'wk-other', claim_expires_at: new Date(Date.now() + 60_000).toISOString() },
    });
    const res = await request(buildApp())
      .post('/api/v1/worker/orchestrator/await-autopilot-execution')
      .send({ vtid: 'VTID-00001', autopilot_execution_id: 'exec-1', worker_id: 'wk-1' });
    expect(res.status).toBe(403);
  });

  it('403 when claim has expired (claim_expires_at in the past)', async () => {
    mockFetch({
      workerExists: true,
      ledgerOwner: { claimed_by: 'wk-1', claim_expires_at: new Date(Date.now() - 60_000).toISOString() },
    });
    const res = await request(buildApp())
      .post('/api/v1/worker/orchestrator/await-autopilot-execution')
      .send({ vtid: 'VTID-00001', autopilot_execution_id: 'exec-1', worker_id: 'wk-1' });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/v1/worker/orchestrator/await-autopilot-execution — four-state contract', () => {
  const validClaim = {
    workerExists: true,
    ledgerOwner: { claimed_by: 'wk-1', claim_expires_at: new Date(Date.now() + 600_000).toISOString() },
  };

  it('returns completed with files_changed from PR diff when status=completed', async () => {
    mockFetch({
      ...validClaim,
      executionRows: [{
        id: 'exec-1',
        status: 'completed',
        pr_url: 'https://github.com/exafyltd/vitana-platform/pull/9999',
        pr_number: 9999,
        branch: 'fix/canary-bug-VTID-99999',
        metadata: {},
        completed_at: new Date().toISOString(),
      }],
      prFiles: [
        { filename: 'services/gateway/src/routes/availability.ts', status: 'modified' },
        { filename: 'services/gateway/src/routes/availability.test.ts', status: 'added' },
      ],
    });
    process.env.GITHUB_SAFE_MERGE_TOKEN = 'gh-token-fake';

    const res = await request(buildApp())
      .post('/api/v1/worker/orchestrator/await-autopilot-execution')
      .send({ vtid: 'VTID-00001', autopilot_execution_id: 'exec-1', worker_id: 'wk-1' });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('completed');
    expect(res.body.pr_number).toBe(9999);
    expect(res.body.files_changed).toEqual(['services/gateway/src/routes/availability.ts']);
    expect(res.body.files_created).toEqual(['services/gateway/src/routes/availability.test.ts']);
  });

  it('returns pr_ready with files when status=ci (PR opened, CI in flight)', async () => {
    mockFetch({
      ...validClaim,
      executionRows: [{
        id: 'exec-1',
        status: 'ci',
        pr_url: 'https://github.com/exafyltd/vitana-platform/pull/9998',
        pr_number: 9998,
        branch: 'fix/canary-bug',
        metadata: {},
        completed_at: null,
      }],
      prFiles: [{ filename: 'services/gateway/src/routes/x.ts', status: 'modified' }],
    });
    process.env.GITHUB_SAFE_MERGE_TOKEN = 'gh-token-fake';

    const res = await request(buildApp())
      .post('/api/v1/worker/orchestrator/await-autopilot-execution')
      .send({ vtid: 'VTID-00002', autopilot_execution_id: 'exec-1', worker_id: 'wk-1' });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('pr_ready');
    expect(res.body.execution_status).toBe('ci');
    expect(res.body.files_changed.length).toBe(1);
  });

  it('returns failed when status=failed', async () => {
    mockFetch({
      ...validClaim,
      executionRows: [{
        id: 'exec-1',
        status: 'failed',
        pr_url: null,
        pr_number: null,
        branch: null,
        metadata: { error: 'plan validation failed' },
        completed_at: new Date().toISOString(),
      }],
    });

    const res = await request(buildApp())
      .post('/api/v1/worker/orchestrator/await-autopilot-execution')
      .send({ vtid: 'VTID-00003', autopilot_execution_id: 'exec-1', worker_id: 'wk-1' });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('failed');
    expect(res.body.error).toContain('plan validation failed');
    expect(res.body.execution_status).toBe('failed');
  });

  it('returns deferred (NOT failed) when timeout elapses while status=running', async () => {
    mockFetch({
      ...validClaim,
      executionRows: [{
        id: 'exec-1',
        status: 'running',
        pr_url: null,
        pr_number: null,
        branch: null,
        metadata: {},
        completed_at: null,
      }],
    });

    // 60_000ms is the minimum cap; use it so the test completes quickly.
    const res = await request(buildApp())
      .post('/api/v1/worker/orchestrator/await-autopilot-execution')
      .send({
        vtid: 'VTID-00004',
        autopilot_execution_id: 'exec-1',
        worker_id: 'wk-1',
        timeout_ms: 60_000,
      });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('deferred');
    expect(res.body.reason).toBe('timeout');
    expect(res.body.execution_status).toBe('running');
  }, 120_000);

  it('returns failed (NOT deferred) when execution row is missing entirely', async () => {
    mockFetch({
      ...validClaim,
      executionRows: [],
    });

    const res = await request(buildApp())
      .post('/api/v1/worker/orchestrator/await-autopilot-execution')
      .send({ vtid: 'VTID-00005', autopilot_execution_id: 'exec-missing', worker_id: 'wk-1' });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('failed');
    expect(res.body.error).toContain('not found');
  });
});
