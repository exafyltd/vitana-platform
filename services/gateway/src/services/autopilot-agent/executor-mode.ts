/**
 * VTID-04006: which executor runs a Dev Autopilot execution.
 *
 *   single-shot — the pre-existing path in dev-autopilot-execute.ts: one
 *                 LLM call must emit whole replacement files for ≤8
 *                 pre-fetched files (no reads, no search, no tsc/jest).
 *   agent       — services/gateway/src/services/autopilot-agent/: a real
 *                 clone, a tool loop (read/search/edit/run checks), local
 *                 tsc + jest before the PR, post-hoc scope check.
 *
 * Resolution order (most specific wins):
 *   1. execution row `metadata.executor` ('agent' | 'single-shot')
 *   2. env `DEV_AUTOPILOT_EXECUTOR` on the process running the execution
 *      (the executor task def, or the gateway for in-process runs)
 *   3. 'single-shot' — the default, so deploying this code changes nothing.
 */

export type ExecutorMode = 'single-shot' | 'agent';

export function resolveExecutorMode(
  metadata: Record<string, unknown> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ExecutorMode {
  const fromRow = metadata && typeof metadata.executor === 'string' ? metadata.executor.trim().toLowerCase() : '';
  if (fromRow === 'agent' || fromRow === 'single-shot') return fromRow;
  const fromEnv = (env.DEV_AUTOPILOT_EXECUTOR || '').trim().toLowerCase();
  if (fromEnv === 'agent') return 'agent';
  return 'single-shot';
}
