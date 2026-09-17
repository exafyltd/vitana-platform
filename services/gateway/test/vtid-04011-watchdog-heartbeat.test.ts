/**
 * VTID-04011: the running-watchdog must not clobber row metadata when it
 * reclaims an execution, and a live agent execution must keep its row's
 * updated_at fresh so the watchdog never reclaims it (Test Run #4).
 */

import { buildExecutionFailurePatch, buildWatchdogReclaimPatch } from '../src/services/dev-autopilot-execute';
import { heartbeatIntervalMs, heartbeatRequest, startExecutionHeartbeat } from '../src/services/autopilot-agent/agent-heartbeat';

const NOW = new Date('2026-09-17T19:49:37.000Z');

describe('VTID-04011 buildWatchdogReclaimPatch', () => {
  it('merges the existing metadata and only adds error + reclaim time', () => {
    const existing = {
      source: 'operator-onramp',
      executor: 'agent',
      claimed_env: 'staging',
      llm_on_ramp: 'deepseek',
      llm_on_ramp_override: { provider: 'deepseek', model: 'deepseek-flash' },
    };
    const patch = buildWatchdogReclaimPatch(existing, 20 * 60 * 1000, NOW);
    expect(patch.status).toBe('failed');
    expect(patch.completed_at).toBe(NOW.toISOString());
    expect(patch.metadata).toEqual({
      ...existing,
      error: "watchdog: stuck in 'running' > 20m (container recycled mid-execution)",
      watchdog_reclaimed_at: NOW.toISOString(),
    });
    // the input is not mutated
    expect(existing).not.toHaveProperty('error');
  });

  it('tolerates a missing or non-object metadata', () => {
    expect(buildWatchdogReclaimPatch(null, 20 * 60 * 1000, NOW).metadata).toEqual({
      error: "watchdog: stuck in 'running' > 20m (container recycled mid-execution)",
      watchdog_reclaimed_at: NOW.toISOString(),
    });
    expect(buildWatchdogReclaimPatch(undefined, 5 * 60 * 1000, NOW).metadata.error).toBe(
      "watchdog: stuck in 'running' > 5m (container recycled mid-execution)",
    );
  });
});

describe('VTID-04011 buildExecutionFailurePatch (applyExecutionResult failure path)', () => {
  it('keeps executor / claimed_env / llm_on_ramp_override and adds error + failed_at', () => {
    const existing = { executor: 'agent', claimed_env: 'staging', llm_on_ramp_override: { provider: 'deepseek', model: 'deepseek-flash' } };
    const patch = buildExecutionFailurePatch(existing, 'agent deadline exceeded after 44 turn(s)', NOW);
    expect(patch).toEqual({
      status: 'failed',
      completed_at: NOW.toISOString(),
      metadata: { ...existing, error: 'agent deadline exceeded after 44 turn(s)', failed_at: NOW.toISOString() },
    });
  });

  it('falls back to a generic error and tolerates missing metadata', () => {
    const patch = buildExecutionFailurePatch(null, undefined, NOW);
    expect(patch.metadata).toEqual({ error: 'unknown execution failure', failed_at: NOW.toISOString() });
  });
});

describe('VTID-04011 agent heartbeat', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('defaults to 60s, honours AGENT_HEARTBEAT_MS, and refuses sub-5s values', () => {
    expect(heartbeatIntervalMs({})).toBe(60_000);
    expect(heartbeatIntervalMs({ AGENT_HEARTBEAT_MS: '30000' })).toBe(30_000);
    expect(heartbeatIntervalMs({ AGENT_HEARTBEAT_MS: '100' })).toBe(60_000);
    expect(heartbeatIntervalMs({ AGENT_HEARTBEAT_MS: 'often' })).toBe(60_000);
  });

  it('patches only updated_at, scoped to the still-running row', () => {
    const r = heartbeatRequest('47a4d6eb-abc1-45e8-b9cc-743b17c4df48', NOW);
    expect(r.path).toBe('/rest/v1/dev_autopilot_executions?id=eq.47a4d6eb-abc1-45e8-b9cc-743b17c4df48&status=eq.running');
    expect(r.body).toEqual({ updated_at: NOW.toISOString() });
  });

  it('beats on the interval until stopped, and stop() is idempotent', async () => {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const patch = jest.fn(async (path: string, body: Record<string, unknown>) => { calls.push({ path, body }); });
    const hb = startExecutionHeartbeat({} as never, 'abcdef12-0000-0000-0000-000000000000', { intervalMs: 1000, patch, now: () => NOW });
    expect(hb.beats()).toBe(0);
    jest.advanceTimersByTime(3000);
    await Promise.resolve();
    expect(hb.beats()).toBe(3);
    expect(calls).toHaveLength(3);
    expect(calls[0].path).toContain('id=eq.abcdef12-0000-0000-0000-000000000000&status=eq.running');
    expect(calls[0].body).toEqual({ updated_at: NOW.toISOString() });
    hb.stop();
    hb.stop();
    jest.advanceTimersByTime(5000);
    expect(hb.beats()).toBe(3);
  });

  it('a failing PATCH is logged and never throws into the runner', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const patch = jest.fn(async () => { throw new Error('supabase down'); });
    const hb = startExecutionHeartbeat({} as never, 'abcdef12-0000-0000-0000-000000000000', { intervalMs: 1000, patch });
    jest.advanceTimersByTime(1000);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(hb.beats()).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('heartbeat failed'), 'supabase down');
    hb.stop();
    warn.mockRestore();
  });
});
