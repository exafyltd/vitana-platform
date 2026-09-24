/**
 * VTID-04005: execution ownership across the shared staging/prod table.
 *
 * `dev_autopilot_executions` is ONE table read by TWO gateways (staging and
 * production share the Supabase project). Test Run #2 (VTID-04002 changelog)
 * showed the prod gateway's DRY_RUN watcher picking up a staging execution
 * and synthesising ci_passed → pr_merged → deployed → completed while the
 * real PR was still open. VTID-04004 stopped a dry-run watcher touching real
 * PRs; this module closes the general case: the gateway that CLAIMS an
 * execution stamps its environment on the row, and every watcher/reconciler
 * only touches rows it owns.
 *
 * Legacy rows (claimed before this shipped) carry no stamp and stay visible
 * to every environment, exactly as before — so nothing already in flight is
 * orphaned by the deploy.
 */

import { VITANA_ENV } from '../env';

export const CLAIMED_ENV_KEY = 'claimed_env';

export function currentEnv(): string {
  return VITANA_ENV;
}

/** Metadata to merge onto the row at claim time. */
export function claimStamp(now: Date = new Date()): { claimed_env: string; claimed_at: string } {
  return { claimed_env: currentEnv(), claimed_at: now.toISOString() };
}

/**
 * Does THIS gateway own the execution?
 *   - no stamp  → yes (legacy row; pre-VTID-04005 behaviour)
 *   - stamp === my env → yes
 *   - otherwise → no
 */
export function ownsExecution(
  metadata: Record<string, unknown> | null | undefined,
  myEnv: string = currentEnv(),
): boolean {
  const stamped = metadata && typeof metadata[CLAIMED_ENV_KEY] === 'string' ? (metadata[CLAIMED_ENV_KEY] as string) : null;
  if (!stamped) return true;
  return stamped === myEnv;
}

/**
 * VTID-04497: may THIS gateway claim new executions?
 *
 * An execution ends by merging a PR to `main`, and a push to `main` deploys
 * STAGING only (production moves by PUBLISH). The claiming gateway then waits
 * for a deploy event of its own environment — so a production claim waits for
 * `prod.deploy.completed`, which a merge never produces, times out and REVERTS
 * the merged PR from `main` (593cb4d1 → #3585, 5769e66a → #3594, 2026-09-22).
 * The production gateway claimed ~2/3 of all executions from the shared table.
 *
 *   - staging → yes
 *   - production → only with DEV_AUTOPILOT_PROD_CLAIM_ENABLED=true (exact)
 *
 * Rows the production gateway already owns are still watched and reconciled
 * by it; only NEW claims stop.
 */
export function executorClaimsHere(
  myEnv: string = currentEnv(),
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (myEnv === 'staging') return true;
  return env.DEV_AUTOPILOT_PROD_CLAIM_ENABLED === 'true';
}

/** Filter helper for watcher/reconciler batches. Logs the skips once per tick. */
export function filterOwnedExecutions<T extends { id: string; metadata?: Record<string, unknown> | null }>(
  rows: T[],
  logPrefix: string,
  myEnv: string = currentEnv(),
): T[] {
  const owned: T[] = [];
  const skipped: string[] = [];
  for (const r of rows) {
    if (ownsExecution(r.metadata, myEnv)) owned.push(r);
    else skipped.push(`${r.id.slice(0, 8)}@${String(r.metadata?.[CLAIMED_ENV_KEY])}`);
  }
  if (skipped.length > 0) {
    console.log(`${logPrefix} env=${myEnv}: skipping ${skipped.length} execution(s) owned by another environment: ${skipped.join(', ')}`);
  }
  return owned;
}
