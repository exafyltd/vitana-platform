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
    model: 'gemini-3.1-pro-preview',
    provider: 'vertex-ai',
  }),
  getModelInfo: jest.fn().mockReturnValue({
    model: 'gemini-3.1-pro-preview',
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
import {
  registerWorker,
  pollPendingTasks,
  claimTask,
  routeTask,
  reportSubagentComplete,
  reportOrchestratorComplete,
  releaseTask,
  terminalizeTask,
} from './gateway-client';
import { executeTask } from './execution-service';
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

      // polled event is no longer emitted (telemetry, not state change)
      // Only state-change events (claimed, completed, etc.) go to OASIS

      // Should have claimed the eligible task
      expect(claimTask).toHaveBeenCalledWith(testConfig, 'VTID-01001');

      await runner.stop();
    });
  });

  describe('self-healing completion gates', () => {
    const selfHealingTask = {
      vtid: 'VTID-02001',
      title: 'SELF-HEAL: repair ORB health endpoint',
      status: 'scheduled',
      spec_status: 'approved',
      is_terminal: false,
      claimed_by: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: { source: 'self-healing', endpoint: '/api/v1/orb/health' },
      task_domain: 'backend' as const,
      target_paths: ['services/gateway/src/routes/orb-live.ts'],
    };

    it('fails closed when a self-healing task has no hydrated spec content', async () => {
      (pollPendingTasks as jest.Mock).mockResolvedValueOnce({
        tasks: [selfHealingTask],
        count: 1,
      });

      const runner = new WorkerRunner(testConfig);
      await runner.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(executeTask).not.toHaveBeenCalled();
      expect(reportSubagentComplete).toHaveBeenCalledWith(
        testConfig,
        'VTID-02001',
        'backend',
        expect.any(String),
        expect.objectContaining({
          ok: false,
          error: expect.stringContaining('no hydrated spec_content'),
        }),
      );
      expect(terminalizeTask).toHaveBeenCalledWith(
        testConfig,
        'VTID-02001',
        'failed',
        expect.any(String),
      );
      expect(terminalizeTask).not.toHaveBeenCalledWith(
        testConfig,
        'VTID-02001',
        'success',
        expect.any(String),
      );
      expect(releaseTask).toHaveBeenCalledWith(testConfig, 'VTID-02001', 'failed');

      await runner.stop();
    });

    it('does not terminalize success when gateway verification rejects completion', async () => {
      (pollPendingTasks as jest.Mock).mockResolvedValueOnce({
        tasks: [{ ...selfHealingTask, spec_content: 'Fix the ORB health route and run tests.' }],
        count: 1,
      });
      (executeTask as jest.Mock).mockResolvedValueOnce({
        ok: true,
        files_changed: ['services/gateway/src/routes/orb-live.ts'],
        files_created: [],
        summary: 'Patched ORB health route and verified health check.',
        duration_ms: 1000,
        model: 'test-model',
        provider: 'test-provider',
      });
      (reportSubagentComplete as jest.Mock).mockResolvedValueOnce({
        ok: false,
        reason: 'skip_verification not allowed',
      });
      (reportOrchestratorComplete as jest.Mock).mockResolvedValueOnce({ ok: true });

      const runner = new WorkerRunner(testConfig);
      await runner.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(reportSubagentComplete).toHaveBeenCalledWith(
        testConfig,
        'VTID-02001',
        'backend',
        'run_test123',
        expect.objectContaining({
          ok: true,
          files_changed: ['services/gateway/src/routes/orb-live.ts'],
        }),
      );
      expect(reportOrchestratorComplete).toHaveBeenCalledWith(
        testConfig,
        'VTID-02001',
        'run_test123',
        'backend',
        false,
        expect.stringContaining('completion rejected'),
        expect.stringContaining('skip_verification not allowed'),
        expect.objectContaining({
          ok: false,
        }),
      );
      expect(terminalizeTask).toHaveBeenCalledWith(
        testConfig,
        'VTID-02001',
        'failed',
        'run_test123',
      );
      expect(terminalizeTask).not.toHaveBeenCalledWith(
        testConfig,
        'VTID-02001',
        'success',
        'run_test123',
      );
      expect(releaseTask).toHaveBeenCalledWith(testConfig, 'VTID-02001', 'failed');

      await runner.stop();
    });

    it('runs a synthetic self-healing task through the local success path with repair evidence', async () => {
      (pollPendingTasks as jest.Mock).mockResolvedValueOnce({
        tasks: [{ ...selfHealingTask, spec_content: 'Fix the ORB health route and run tests.' }],
        count: 1,
      });
      (executeTask as jest.Mock).mockResolvedValueOnce({
        ok: true,
        files_changed: ['services/gateway/src/routes/orb-live.ts'],
        files_created: [],
        summary: 'Patched ORB health route and verified health check.',
        duration_ms: 1000,
        model: 'test-model',
        provider: 'test-provider',
      });
      (reportSubagentComplete as jest.Mock).mockResolvedValueOnce({
        ok: true,
        verified: true,
      });
      (reportOrchestratorComplete as jest.Mock).mockResolvedValueOnce({
        ok: true,
        verified: true,
      });

      const runner = new WorkerRunner(testConfig);
      await runner.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(executeTask).toHaveBeenCalledWith(
        testConfig,
        expect.objectContaining({
          vtid: 'VTID-02001',
          spec_content: 'Fix the ORB health route and run tests.',
        }),
        expect.objectContaining({ ok: true }),
        'backend',
      );
      expect(routeTask).toHaveBeenCalledWith(
        testConfig,
        'VTID-02001',
        'SELF-HEAL: repair ORB health endpoint',
        'backend',
        'Fix the ORB health route and run tests.',
        ['services/gateway/src/routes/orb-live.ts'],
      );
      expect(reportSubagentComplete).toHaveBeenCalledWith(
        testConfig,
        'VTID-02001',
        'backend',
        'run_test123',
        expect.objectContaining({
          ok: true,
          files_changed: ['services/gateway/src/routes/orb-live.ts'],
          summary: 'Patched ORB health route and verified health check.',
        }),
      );
      expect(reportOrchestratorComplete).toHaveBeenCalledWith(
        testConfig,
        'VTID-02001',
        'run_test123',
        'backend',
        true,
        'Patched ORB health route and verified health check.',
        undefined,
        expect.objectContaining({
          ok: true,
          files_changed: ['services/gateway/src/routes/orb-live.ts'],
        }),
      );
      expect(terminalizeTask).toHaveBeenCalledWith(
        testConfig,
        'VTID-02001',
        'success',
        'run_test123',
      );
      expect(releaseTask).toHaveBeenCalledWith(testConfig, 'VTID-02001', 'completed');

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
