/**
 * VTID-02703: Cloud Run Job entry point.
 *
 * This file is the single-shot executable invoked by the Cloud Run Job
 * runtime when the gateway dispatches an autopilot execution that needs
 * to survive container churn (long LLM calls on large files like
 * orb-live.ts).
 *
 * Why a Job and not the gateway service:
 *   - Cloud Run SERVICES recycle containers as part of normal load
 *     balancing. A fire-and-forget runExecutionSession Promise dies
 *     when its container is recycled mid-LLM-call, which is exactly
 *     what was killing every orb-live.ts execution attempt.
 *   - Cloud Run JOBS run a single task to completion with a
 *     configurable timeout (up to 24h). They don't get scaled or
 *     recycled mid-run.
 *
 * Reuses the gateway's existing executor code via direct imports — same
 * Supabase + Vertex/AI Studio routing, same plan-loading, same PR
 * creation. The Job is just a different runtime envelope around the
 * exact same logic.
 *
 * Entry contract:
 *   - Read EXEC_ID from env
 *   - Run executor session
 *   - Exit 0 on success, 1 on failure
 *   - Stdout = structured logs the gateway and operators consume
 *
 * The gateway dispatcher (in dev-autopilot-execute.ts) sets EXEC_ID via
 * `gcloud run jobs execute --update-env-vars EXEC_ID=...`.
 */

import { applyExecutionResult, getSupabase, runExecutionSession } from './services/dev-autopilot-execute';

const LOG_PREFIX = '[autopilot-job]';

async function main(): Promise<number> {
  const execId = (process.env.EXEC_ID || '').trim();
  if (!execId) {
    console.error(`${LOG_PREFIX} EXEC_ID env var required`);
    return 2;
  }

  const s = getSupabase();
  if (!s) {
    console.error(`${LOG_PREFIX} SUPABASE_URL / SUPABASE_SERVICE_ROLE missing — cannot run`);
    return 2;
  }

  console.log(`${LOG_PREFIX} starting exec=${execId.slice(0, 8)}`);
  const startedAt = Date.now();

  try {
    const result = await runExecutionSession(s, execId);
    const elapsedMs = Date.now() - startedAt;
    // Write the outcome back to the DB and emit OASIS events using the
    // shared helper. Identical post-execution state regardless of whether
    // the run was in-process or Job.
    await applyExecutionResult(s, execId, result);
    if (result.ok) {
      console.log(`${LOG_PREFIX} exec=${execId.slice(0, 8)} OK pr=${result.pr_url ?? '-'} branch=${result.branch ?? '-'} elapsed=${elapsedMs}ms`);
      return 0;
    }
    console.error(`${LOG_PREFIX} exec=${execId.slice(0, 8)} FAIL error=${result.error ?? '?'} elapsed=${elapsedMs}ms`);
    return 1;
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} exec=${execId.slice(0, 8)} CRASH ${msg} elapsed=${elapsedMs}ms`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    return 3;
  }
}

main().then((code) => {
  process.exit(code);
}).catch((err) => {
  console.error(`${LOG_PREFIX} unhandled top-level error:`, err);
  process.exit(4);
});
