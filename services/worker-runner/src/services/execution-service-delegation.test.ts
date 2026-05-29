/**
 * PR-A (VTID-02922): worker-runner delegation contract.
 *
 * Self-healing tasks bridged to a Dev Autopilot execution have
 * `metadata.source === 'self-healing'` AND `metadata.autopilot_execution_id`
 * set. The worker-runner MUST skip its own describe-only LLM call for these
 * tasks and instead poll the gateway's /await-autopilot-execution endpoint.
 *
 * The four-state contract maps to ExecutionResult flavors:
 *   - 'pr_ready'  → ok=true, healing_state='patched_pending_deploy',
 *                   real files_changed (clears the repair-evidence gate at
 *                   /complete, but the VTID is NOT yet terminalized — the
 *                   reconciler owns that)
 *   - 'completed' → ok=true, healing_state='verified_healed'
 *   - 'failed'    → ok=false, healing_state='execution_failed'
 *   - 'deferred'  → ok=true, defer=true (runner releases the claim without
 *                   calling /complete or /terminalize; the reconciler
 *                   finishes the VTID lifecycle when the autopilot
 *                   execution reaches a terminal state)
 *
 * Non-self-healing tasks fall through to the existing Claude/DeepSeek path.
 */

// Mock the gateway-client call the delegation path uses BEFORE importing the
// execution service so the inner reference is replaced.
jest.mock('./gateway-client', () => ({
  awaitAutopilotExecution: jest.fn(),
}));

import { awaitAutopilotExecution } from './gateway-client';
import { executeTask } from './execution-service';
import type { PendingTask, RoutingResult, RunnerConfig } from '../types';

const mockAwait = awaitAutopilotExecution as unknown as jest.Mock;

const baseConfig: RunnerConfig = {
  workerId: 'test-worker-001',
  gatewayUrl: 'http://gateway.test',
  supabaseUrl: 'http://supabase.test',
  supabaseKey: 'svc-role',
  pollIntervalMs: 5000,
  autopilotEnabled: true,
  maxConcurrent: 1,
};

const baseRouting: RoutingResult = {
  ok: true,
  dispatched_to: 'worker-backend',
  run_id: 'run-abc',
  identity: {
    repo: 'vitana-platform',
    project: 'test',
    region: 'us-central1',
    environment: 'test',
    tenant: 'vitana',
  },
};

function selfHealingTask(extra: Partial<PendingTask> = {}): PendingTask {
  return {
    vtid: 'VTID-99999',
    title: 'SELF-HEAL test',
    status: 'in_progress',
    spec_status: 'approved',
    spec_content: 'spec md',
    task_domain: 'backend',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    is_terminal: false,
    metadata: {
      source: 'self-healing',
      autopilot_execution_id: 'exec-uuid-123',
    },
    ...extra,
  };
}

beforeEach(() => {
  mockAwait.mockReset();
});

describe('executeTask — self-healing delegation', () => {
  it('skips local LLM call and returns pr_ready as patched_pending_deploy', async () => {
    mockAwait.mockResolvedValue({
      ok: true,
      result: {
        state: 'pr_ready',
        pr_url: 'https://github.com/exafyltd/vitana-platform/pull/9999',
        pr_number: 9999,
        branch: 'fix/canary',
        files_changed: ['services/gateway/src/routes/availability.ts'],
        files_created: [],
        execution_status: 'ci',
      },
    });

    const result = await executeTask(baseConfig, selfHealingTask(), baseRouting, 'backend');

    expect(mockAwait).toHaveBeenCalledTimes(1);
    expect(mockAwait.mock.calls[0][1]).toBe('VTID-99999');
    expect(mockAwait.mock.calls[0][2]).toBe('exec-uuid-123');
    expect(result.ok).toBe(true);
    expect(result.healing_state).toBe('patched_pending_deploy');
    expect(result.files_changed).toEqual(['services/gateway/src/routes/availability.ts']);
    expect(result.pr_url).toBe('https://github.com/exafyltd/vitana-platform/pull/9999');
    expect(result.defer).toBeUndefined();
  });

  it('returns completed as verified_healed', async () => {
    mockAwait.mockResolvedValue({
      ok: true,
      result: {
        state: 'completed',
        pr_url: 'https://github.com/exafyltd/vitana-platform/pull/9998',
        pr_number: 9998,
        branch: 'fix/canary',
        files_changed: ['x.ts'],
        files_created: ['y.ts'],
        execution_status: 'completed',
      },
    });

    const result = await executeTask(baseConfig, selfHealingTask(), baseRouting, 'backend');

    expect(result.ok).toBe(true);
    expect(result.healing_state).toBe('verified_healed');
    expect(result.files_changed).toEqual(['x.ts']);
    expect(result.files_created).toEqual(['y.ts']);
  });

  it('returns failed with healing_state=execution_failed', async () => {
    mockAwait.mockResolvedValue({
      ok: true,
      result: {
        state: 'failed',
        error: 'plan validation exhausted 3 attempts',
        execution_status: 'failed',
      },
    });

    const result = await executeTask(baseConfig, selfHealingTask(), baseRouting, 'backend');

    expect(result.ok).toBe(false);
    expect(result.healing_state).toBe('execution_failed');
    expect(result.error).toContain('plan validation exhausted');
  });

  it('returns deferred with defer=true on timeout', async () => {
    mockAwait.mockResolvedValue({
      ok: true,
      result: { state: 'deferred', reason: 'timeout', execution_status: 'running' },
    });

    const result = await executeTask(baseConfig, selfHealingTask(), baseRouting, 'backend');

    expect(result.ok).toBe(true);
    expect(result.defer).toBe(true);
    expect(result.healing_state).toBeUndefined();
    expect(result.files_changed).toBeUndefined();
  });

  it('falls back to the local LLM path when task.metadata.source is NOT self-healing', async () => {
    // Without a self-healing marker, the runner should NOT call await-autopilot;
    // it should attempt the normal Anthropic path. Force initClaude to fail
    // by leaving ANTHROPIC_API_KEY unset so we can verify the call path.
    delete process.env.ANTHROPIC_API_KEY;
    const nonHealingTask: PendingTask = {
      ...selfHealingTask(),
      metadata: { source: 'dev_autopilot' },
    };

    const result = await executeTask(baseConfig, nonHealingTask, baseRouting, 'backend');

    expect(mockAwait).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ANTHROPIC_API_KEY');
  });

  // PR-E (VTID-02931, Gap 1): self-healing tasks without an autopilot
  // bridge MUST NOT fall back to the local LLM path. The repair-evidence
  // gate from PR #2045 was a weak check — Claude can hallucinate file
  // paths in its describe-only output and slip past `files_changed.length
  // > 0`. The worker-runner now refuses the fallback entirely.
  it('REFUSES local LLM fallback when self-healing flag set but execution_id missing (Gap 1)', async () => {
    process.env.ANTHROPIC_API_KEY = 'fake-key-that-should-NEVER-be-used';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const partialTask: PendingTask = {
      ...selfHealingTask(),
      metadata: { source: 'self-healing' }, // no autopilot_execution_id
    };

    const result = await executeTask(baseConfig, partialTask, baseRouting, 'backend');

    expect(mockAwait).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('refusing legacy LLM fallback');
    expect(result.healing_state).toBe('execution_failed');
    expect(result.provider).toBe('self-healing-guard');
    // The model field must NOT be claude-* — confirms no Claude call.
    expect(result.model).toBe('none');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Refusing legacy LLM fallback'));
    warnSpy.mockRestore();
  });

  it('surfaces gateway errors instead of silently treating as success', async () => {
    mockAwait.mockResolvedValue({ ok: false, error: 'gateway 502' });

    const result = await executeTask(baseConfig, selfHealingTask(), baseRouting, 'backend');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('gateway 502');
    expect(result.autopilot_execution_id).toBe('exec-uuid-123');
  });
});
