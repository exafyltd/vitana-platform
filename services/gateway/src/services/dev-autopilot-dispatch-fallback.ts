/**
 * VTID-04467: what to do with a claimed execution when the executor task
 * (ECS RunTask) could not be started.
 *
 * Until now the dispatch loop always fell back to running the execution
 * inside the gateway process. That is fine for the single-shot executor (one
 * LLM call, no toolchain). It is wrong for the agent executor: the agent
 * clones the repo and runs `tsc` and jest, and the gateway image is built
 * with production dependencies only, so every in-process agent run died at
 * the runner's own check with
 *   `tsc failed after 3 fix round(s): spawn …/node_modules/.bin/tsc ENOENT`
 * after spending its whole LLM budget first (live 2026-09-22 22:08 and 22:22
 * UTC, while the AWS account block refused every RunTask).
 *
 * Rule:
 *   - single-shot, or an agent run on a process that HAS the toolchain
 *     → in-process, as before;
 *   - agent run, no toolchain, fewer than MAX_DISPATCH_ATTEMPTS failures
 *     → put the row back to `cooling` with a growing delay (requeue);
 *   - agent run, no toolchain, attempts exhausted
 *     → fail the row with a reason that names the dispatch error. The
 *       failure text matches the retry breaker's outage pattern, so it
 *       never counts against the finding and halts claiming while it lasts.
 */

import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';

export type DispatchFallbackDecision = 'in_process' | 'requeue' | 'fail';

export const MAX_DISPATCH_ATTEMPTS = 3;
export const REQUEUE_BASE_DELAY_MS = 2 * 60_000;

export function resolveMaxDispatchAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.DEV_AUTOPILOT_MAX_DISPATCH_ATTEMPTS || '', 10);
  return Number.isFinite(n) && n >= 1 && n <= 20 ? n : MAX_DISPATCH_ATTEMPTS;
}

export function decideDispatchFallback(input: {
  mode: 'agent' | 'single-shot';
  toolchainPresent: boolean;
  priorDispatchFailures: number;
  maxAttempts?: number;
}): DispatchFallbackDecision {
  if (input.mode !== 'agent') return 'in_process';
  if (input.toolchainPresent) return 'in_process';
  const max = input.maxAttempts ?? MAX_DISPATCH_ATTEMPTS;
  // This failure is attempt number priorDispatchFailures + 1.
  return input.priorDispatchFailures + 1 >= max ? 'fail' : 'requeue';
}

/** Delay before the next claim: 2, 4, 8 … minutes, capped at 30. */
export function requeueDelayMs(failuresSoFar: number): number {
  const n = Math.max(1, failuresSoFar);
  return Math.min(30 * 60_000, REQUEUE_BASE_DELAY_MS * 2 ** (n - 1));
}

export function priorDispatchFailures(metadata: Record<string, unknown> | null | undefined): number {
  const v = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).dispatch_failures : undefined;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** Failure text; must match PROVIDER_OUTAGE_RE (dev-autopilot-retry-breaker.ts). */
export function dispatchFailureError(attempts: number, dispatchError: string): string {
  return `executor task could not be started after ${attempts} attempt(s): ${dispatchError.slice(0, 300)} — `
    + 'agent runs need the executor image (git, tsc, jest) and are never run inside the gateway process';
}

let cachedToolchain: boolean | null = null;

/**
 * True when this process can run the agent's checks itself: a tsc binary in
 * the dependency tree the agent links into its clone, and a git binary.
 */
export function agentToolchainPresent(
  nodeModulesSource: string = process.env.AGENT_NODE_MODULES_SOURCE || '/app/node_modules',
): boolean {
  if (cachedToolchain !== null) return cachedToolchain;
  let ok = false;
  try {
    ok = existsSync(path.join(nodeModulesSource, '.bin', 'tsc'))
      && spawnSync('git', ['--version'], { stdio: 'ignore', timeout: 5000 }).status === 0;
  } catch {
    ok = false;
  }
  cachedToolchain = ok;
  return ok;
}

/** Test seam. */
export function resetToolchainCache(): void { cachedToolchain = null; }
