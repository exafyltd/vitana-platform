/**
 * VTID-04363: one owner for the Dev Autopilot loop across the shared table.
 *
 * Staging and production are two gateways over ONE `dev_autopilot_executions`
 * table. Both ran the background loop (claim, auto-approve, lazy plan,
 * reapers). A merge to `main` deploys STAGING only, so an execution the
 * production gateway claimed never sees a deploy event for its merge commit:
 * the reconciler reverts it 30 minutes after merging. VTID-04005 stops the
 * other gateway's watchers from touching a claimed row; it does not stop both
 * gateways from claiming, approving and planning in the first place.
 *
 * The loop now runs on exactly one environment:
 *   DEV_AUTOPILOT_LOOP_OWNER_ENV = 'staging' | 'production'
 * Unset, empty, or anything else resolves to 'staging' — the environment the
 * merge actually deploys to, and the only one whose deploy watcher can see
 * the result. Watchers keep running everywhere and keep VTID-04005's
 * ownership filter, so rows the other gateway claimed in the past still
 * finish where they started.
 */

import { VITANA_ENV, type VitanaEnv } from '../env';

export const LOOP_OWNER_ENV_VAR = 'DEV_AUTOPILOT_LOOP_OWNER_ENV';

export function resolveLoopOwnerEnv(
  env: Record<string, string | undefined> = process.env,
): VitanaEnv {
  return env[LOOP_OWNER_ENV_VAR] === 'production' ? 'production' : 'staging';
}

export function isLoopOwner(
  thisEnv: VitanaEnv = VITANA_ENV,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return resolveLoopOwnerEnv(env) === thisEnv;
}

export function describeLoopOwnership(
  thisEnv: VitanaEnv = VITANA_ENV,
  env: Record<string, string | undefined> = process.env,
): { owner_env: VitanaEnv; this_env: VitanaEnv; active_here: boolean } {
  const owner = resolveLoopOwnerEnv(env);
  return { owner_env: owner, this_env: thisEnv, active_here: owner === thisEnv };
}
