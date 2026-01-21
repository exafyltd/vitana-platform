/**
 * VTID-01200: Worker Runner Service Tests
 */

import { RunnerConfig } from '../types';

// Mock the gateway client
jest.mock('./gateway-client', () => ({
  registerWorker: jest.fn().mockResolvedValue(true),
  sendHeartbeat: jest.fn().mockResolvedValue(true),
  pollPendingTasks: jest.fn().mockResolvedValue({ tasks: [], count: 0 }),
  claimTask: jest.fn().mockResolvedValue({ ok: true, claimed: true, expires_at: new Date().toISOString() }),
  routeTask: jest.fn().mockResolvedValue({
    ok: true,
    dispatched_to: 'worker-backend',
    run_id: 'run_test123',
    identity: {
      repo: 'vitana-platform',
      project: 'test',
      region: 'us-central1',
      environment: 'test',
      tenant: 'vitana',
    },
  }),
  reportSubagentStart: jest.fn().mockResolvedValue(true),
  reportSubagentComplete: jest.fn().mockResolvedValue({ ok: true }),
  reportOrchestratorComplete: jest.fn().mockResolvedValue({ ok: true }),
  releaseTask: jest.fn().mockResolvedValue(true),
  terminalizeTask: jest.fn().mockResolvedValue({ ok: true }),
  reportProgress: jest.fn().mockResolvedValue(true),
}));

// Mock the execution service
jest.mock('./execution-service', () => ({
  executeTask: jest.fn().mockResolvedValue({
    ok: true,
    files_changed: [],
    files_created: [],
    summary: 'Test execution completed',
    duration_ms: 1000,
    model: 'gemini-2.5-pro',
    provider: 'vertex-ai',
  }),
  getModelInfo: jest.fn().mockReturnValue({
    model: 'gemini-2.5-pro',
    provider: 'vertex-ai',
  }),
}));

// Mock the event emitter
jest.mock('./event-emitter', () => ({
  runnerEvents: {
    registered: jest.fn().mockResolvedValue({ ok: true }),
    heartbeat: jest.fn().mockResolvedValue({ ok: true }),
    polled: jest.fn().mockResolvedValue({ ok: true }),
    claimed: jest.fn().mockResolvedValue({ ok: true }),
    claimFailed: jest.fn().mockResolvedValue({ ok: true }),
    routed: jest.fn().mockResolvedValue({ ok: true }),
    execStarted: jest.fn().mockResolvedValue({ ok: true }),
    execCompleted: jest.fn().mockResolvedValue({ ok: true }),
    terminalized: jest.fn().mockResolvedValue({ ok: true }),
    error: jest.fn().mockResolvedValue({ ok: true }),
    governanceBlocked: jest.fn().mockResolvedValue({ ok: true }),
  },
}));

import { WorkerRunner } from './runner-service';
import { registerWorker, pollPendingTasks, claimTask } from './gateway-client';
import { runnerEvents } from './event-emitter';

describe('WorkerRunner', () => {
  const testConfig: RunnerConfig = {
    workerId: 'test-worker-001',
    gatewayUrl: 'http://localhost:8080',
    supabaseUrl: 'http://localhost:54321',
    supabaseKey: 'test-key',
    pollIntervalMs: 5000,
    autopilotEnabled: true,
    maxConcurrent: 1,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with provided config', () => {
      const runner = new WorkerRunner(testConfig);
      expect(runner).toBeDefined();

      const metrics = runner.getMetrics();
      expect(metrics.state).toBe('idle');
      expect(metrics.tasks_polled).toBe(0);
      expect(metrics.tasks_claimed).toBe(0);
      expect(metrics.tasks_completed).toBe(0);
      expect(metrics.tasks_failed).toBe(0);
    });
  });

  describe('start', () => {
    it('should register worker and start polling', async () => {
      const runner = new WorkerRunner(testConfig);
      const started = await runner.start();

      expect(started).toBe(true);
      expect(registerWorker).toHaveBeenCalledWith(testConfig);
      expect(runnerEvents.registered).toHaveBeenCalled();
      expect(runner.isHealthy()).toBe(true);

      await runner.stop();
    });

    it('should not start if already running', async () => {
      const runner = new WorkerRunner(testConfig);
      await runner.start();

      const secondStart = await runner.start();
      expect(secondStart).toBe(true);

      // registerWorker should only be called once
      expect(registerWorker).toHaveBeenCalledTimes(1);

      await runner.stop();
    });

    it('should fail to start if registration fails', async () => {
      (registerWorker as jest.Mock).mockResolvedValueOnce(false);

      const runner = new WorkerRunner(testConfig);
      const started = await runner.start();

      expect(started).toBe(false);
      expect(runner.isHealthy()).toBe(false);
    });

    it('should emit governance blocked event if autopilot is disabled', async () => {
      const disabledConfig = { ...testConfig, autopilotEnabled: false };
      const runner = new WorkerRunner(disabledConfig);

      await runner.start();

      expect(runnerEvents.governanceBlocked).toHaveBeenCalledWith(
        disabledConfig,
        'AUTOPILOT_LOOP_ENABLED=false'
      );

      await runner.stop();
    });
  });

  describe('stop', () => {
    it('should stop polling and heartbeat', async () => {
      const runner = new WorkerRunner(testConfig);
      await runner.start();

      await runner.stop();

      expect(runner.isHealthy()).toBe(false);
    });
  });

  describe('getMetrics', () => {
    it('should return current metrics', async () => {
      const runner = new WorkerRunner(testConfig);
      await runner.start();

      const metrics = runner.getMetrics();

      expect(metrics).toHaveProperty('registered_at');
      expect(metrics).toHaveProperty('last_heartbeat_at');
      expect(metrics).toHaveProperty('state');
      expect(metrics).toHaveProperty('tasks_polled');
      expect(metrics).toHaveProperty('tasks_claimed');
      expect(metrics).toHaveProperty('tasks_completed');
      expect(metrics).toHaveProperty('tasks_failed');

      await runner.stop();
    });
  });

  describe('task eligibility', () => {
    it('should only process eligible tasks', async () => {
      const mockTasks = [
        {
          vtid: 'VTID-01001',
          title: 'Test task 1',
          status: 'in_progress',
          spec_status: 'approved',
          is_terminal: false,
          claimed_by: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          vtid: 'VTID-01002',
          title: 'Test task 2',
          status: 'scheduled', // Not eligible
          spec_status: 'approved',
          is_terminal: false,
          claimed_by: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          vtid: 'VTID-01003',
          title: 'Test task 3',
          status: 'in_progress',
          spec_status: 'draft', // Not eligible
          is_terminal: false,
          claimed_by: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];

      (pollPendingTasks as jest.Mock).mockResolvedValueOnce({
        tasks: mockTasks,
        count: 3,
      });

      const runner = new WorkerRunner(testConfig);
      await runner.start();

      // Wait for poll to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should have polled with 3 tasks but only 1 eligible
      expect(runnerEvents.polled).toHaveBeenCalled();

      // Should have claimed the eligible task
      expect(claimTask).toHaveBeenCalledWith(testConfig, 'VTID-01001');

      await runner.stop();
    });
  });
});

describe('isTaskEligible', () => {
  // Helper to test eligibility logic
  const checkEligibility = (task: any) => {
    // Replicate the eligibility logic from runner-service
    if (task.status !== 'in_progress') return false;
    if (task.spec_status !== 'approved') return false;
    if (task.is_terminal) return false;
    if (task.claimed_by && task.claimed_by !== 'test-worker') return false;
    return true;
  };

  it('should reject tasks not in_progress', () => {
    expect(checkEligibility({ status: 'scheduled', spec_status: 'approved', is_terminal: false })).toBe(false);
    expect(checkEligibility({ status: 'completed', spec_status: 'approved', is_terminal: false })).toBe(false);
  });

  it('should reject tasks without approved spec', () => {
    expect(checkEligibility({ status: 'in_progress', spec_status: 'draft', is_terminal: false })).toBe(false);
    expect(checkEligibility({ status: 'in_progress', spec_status: 'missing', is_terminal: false })).toBe(false);
  });

  it('should reject terminal tasks', () => {
    expect(checkEligibility({ status: 'in_progress', spec_status: 'approved', is_terminal: true })).toBe(false);
  });

  it('should reject tasks claimed by other workers', () => {
    expect(checkEligibility({
      status: 'in_progress',
      spec_status: 'approved',
      is_terminal: false,
      claimed_by: 'other-worker',
    })).toBe(false);
  });

  it('should accept eligible tasks', () => {
    expect(checkEligibility({
      status: 'in_progress',
      spec_status: 'approved',
      is_terminal: false,
      claimed_by: null,
    })).toBe(true);
  });
});
