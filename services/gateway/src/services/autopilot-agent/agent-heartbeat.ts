/**
 * VTID-04011: liveness heartbeat for an agent execution.
 *
 * The running-watchdog (`backgroundExecutorTick`, step 0b) reclaims any row
 * that has sat in `running` with a stale `updated_at` for STUCK_EXECUTION_MS
 * (20 min) — it was built for a fire-and-forget promise inside a recycled
 * gateway container. An agent execution legitimately runs longer than that
 * (AGENT_DEADLINE_MS defaults to 22 min, a single tsc check can take 2+),
 * and Test Run #4 saw a live ECS task reclaimed mid-loop and a self-heal
 * child spawned against it. While the agent is alive it bumps the row's
 * `updated_at` on a timer, so the watchdog only ever catches a task that
 * actually died. The PATCH is scoped to `status=eq.running`, so a row the
 * watchdog (or anything else) has already moved on is never touched.
 */

import { supa, type SupaConfig } from '../dev-autopilot-execute';

const LOG_PREFIX = '[autopilot-agent]';

export function heartbeatIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.AGENT_HEARTBEAT_MS || '', 10);
  return Number.isFinite(n) && n >= 5_000 ? n : 60_000;
}

export type HeartbeatPatch = (path: string, body: Record<string, unknown>) => Promise<unknown>;

export interface ExecutionHeartbeat {
  /** Stop beating. Idempotent. */
  stop(): void;
  /** Beats attempted so far (for tests/telemetry). */
  beats(): number;
}

/** Path + body of one beat, exported so a test can pin the exact shape. */
export function heartbeatRequest(executionId: string, now: Date = new Date()): { path: string; body: Record<string, unknown> } {
  return {
    path: `/rest/v1/dev_autopilot_executions?id=eq.${executionId}&status=eq.running`,
    body: { updated_at: now.toISOString() },
  };
}

export function startExecutionHeartbeat(
  s: SupaConfig,
  executionId: string,
  opts: { intervalMs?: number; patch?: HeartbeatPatch; now?: () => Date } = {},
): ExecutionHeartbeat {
  const intervalMs = opts.intervalMs ?? heartbeatIntervalMs();
  const now = opts.now ?? (() => new Date());
  const patch: HeartbeatPatch = opts.patch
    ?? ((path, body) => supa(s, path, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(body) }));
  let count = 0;
  let stopped = false;
  const beat = () => {
    if (stopped) return;
    count += 1;
    const { path, body } = heartbeatRequest(executionId, now());
    Promise.resolve()
      .then(() => patch(path, body))
      .catch((err) => console.warn(`${LOG_PREFIX} [${executionId.slice(0, 8)}] heartbeat failed:`, err instanceof Error ? err.message : err));
  };
  const timer = setInterval(beat, intervalMs);
  // never keep the executor process alive for the sake of a heartbeat
  if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
    beats: () => count,
  };
}
