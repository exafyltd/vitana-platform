/**
 * Tests for src/routes/testing.ts — focused on the gateway-jest quick-run
 * path (BOOTSTRAP-TEST-COVERAGE).
 *
 * Context: the Command Hub's "Unit Tests" panel already had a "Gateway
 * Tests (Jest)" button wired to project id 'gateway-jest', but POST /run's
 * validation only recognized Playwright E2E_SUITES entries — the button
 * silently 400'd. This adds real handling: dispatch TEST-SUITE.yml, track
 * a test_runs row, and poll GitHub Actions for completion.
 */
import request from 'supertest';
import express from 'express';

const mockTriggerWorkflow = jest.fn();
const mockGetWorkflowRuns = jest.fn();

jest.mock('../../src/services/github-service', () => ({
  __esModule: true,
  default: {
    triggerWorkflow: (...args: unknown[]) => mockTriggerWorkflow(...args),
    getWorkflowRuns: (...args: unknown[]) => mockGetWorkflowRuns(...args),
    getWorkflowRunJobs: jest.fn(),
  },
}));

const createChain = () => {
  let insertedRow: any = null;
  let updatePayload: any = null;

  const chain: any = {
    insert: jest.fn((row: any) => {
      insertedRow = { id: 'run-1', ...row };
      return chain;
    }),
    update: jest.fn((payload: any) => {
      updatePayload = payload;
      return chain;
    }),
    eq: jest.fn(() => chain),
    select: jest.fn(() => chain),
    single: jest.fn(() => Promise.resolve({ data: insertedRow, error: null })),
    then: jest.fn((resolve: (v: any) => any) => Promise.resolve({ data: null, error: null }).then(resolve)),
    getLastUpdate: () => updatePayload,
  };
  return chain;
};

let tableChain: ReturnType<typeof createChain>;
const mockGetSupabase = jest.fn();

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: (...args: unknown[]) => mockGetSupabase(...args),
}));

import router, { pollGatewayUnitRunCompletion } from '../../src/routes/testing';

const app = express();
app.use(express.json());
app.use('/api/v1/testing', router);

beforeEach(() => {
  jest.clearAllMocks();
  tableChain = createChain();
  mockGetSupabase.mockReturnValue({ from: jest.fn(() => tableChain) });
  mockTriggerWorkflow.mockResolvedValue(undefined);
});

describe('POST /api/v1/testing/run — gateway-jest', () => {
  it('dispatches TEST-SUITE.yml and creates a running test_runs row', async () => {
    const res = await request(app)
      .post('/api/v1/testing/run')
      .send({ type: 'unit', projects: ['gateway-jest'] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, run_id: 'run-1', status: 'running', via: 'github-actions' });
    expect(mockTriggerWorkflow).toHaveBeenCalledWith('exafyltd/vitana-platform', 'TEST-SUITE.yml', 'main');
    expect(tableChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'unit', status: 'running', projects: ['gateway-jest'], triggered_by: 'manual' }),
    );
  });

  it('returns 503 when Supabase is not configured', async () => {
    mockGetSupabase.mockReturnValue(null);
    const res = await request(app)
      .post('/api/v1/testing/run')
      .send({ projects: ['gateway-jest'] });
    expect(res.status).toBe(503);
    expect(mockTriggerWorkflow).not.toHaveBeenCalled();
  });

  it('returns 500 when the GitHub Actions dispatch fails', async () => {
    mockTriggerWorkflow.mockRejectedValue(new Error('dispatch blew up'));
    const res = await request(app)
      .post('/api/v1/testing/run')
      .send({ projects: ['gateway-jest'] });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('dispatch blew up');
  });

  it('returns 500 when the test_runs insert fails', async () => {
    tableChain.single.mockResolvedValueOnce({ data: null, error: { message: 'insert failed' } });
    const res = await request(app)
      .post('/api/v1/testing/run')
      .send({ projects: ['gateway-jest'] });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('insert failed');
  });

  it('does not intercept a plain e2e project request', async () => {
    // Sanity: mixing in a real E2E project without 'gateway-jest' should
    // fall through to the existing E2E validation path untouched.
    const res = await request(app)
      .post('/api/v1/testing/run')
      .send({ projects: ['not-a-real-project'] });
    expect(res.status).toBe(400);
    expect(mockTriggerWorkflow).not.toHaveBeenCalled();
  });
});

describe('pollGatewayUnitRunCompletion', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('updates the run to passed once GitHub reports a successful completed run', async () => {
    const dispatchedAt = new Date('2026-01-01T00:00:00Z');
    mockGetWorkflowRuns.mockResolvedValue({
      workflow_runs: [
        { id: 999, status: 'completed', conclusion: 'success', html_url: 'https://x', created_at: '2026-01-01T00:00:01Z' },
      ],
    });

    const supabase = { from: jest.fn(() => tableChain) } as any;
    const pollPromise = pollGatewayUnitRunCompletion('run-1', dispatchedAt, supabase);
    await jest.advanceTimersByTimeAsync(20_000);
    await pollPromise;

    expect(tableChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'passed', error_message: null }),
    );
  });

  it('marks the run failed when GitHub reports a non-success conclusion', async () => {
    const dispatchedAt = new Date('2026-01-01T00:00:00Z');
    mockGetWorkflowRuns.mockResolvedValue({
      workflow_runs: [
        { id: 999, status: 'completed', conclusion: 'failure', html_url: 'https://x', created_at: '2026-01-01T00:00:01Z' },
      ],
    });

    const supabase = { from: jest.fn(() => tableChain) } as any;
    const pollPromise = pollGatewayUnitRunCompletion('run-1', dispatchedAt, supabase);
    await jest.advanceTimersByTimeAsync(20_000);
    await pollPromise;

    expect(tableChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error_message: expect.stringContaining('failure') }),
    );
  });
});
