/**
 * VTID-05216 — Project Manager: the two switches that gate it (plan §6).
 *
 *   PM_AGENT_ENABLED  default off  — the whole loop is dormant unless this is 'true'.
 *   PM_MODE           off|dry_run|live, default dry_run — P3 only ever runs
 *                     `dry_run` (decide + report); `live` act is P4.
 *
 * These are read fresh from the environment each call so a staging env flip
 * takes effect without a code change. Nothing here reads a DB.
 */

import { PmMode } from './types';

export function pmAgentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PM_AGENT_ENABLED === 'true';
}

export function pmMode(env: NodeJS.ProcessEnv = process.env): PmMode {
  const raw = (env.PM_MODE ?? 'dry_run').trim().toLowerCase();
  if (raw === 'off' || raw === 'live') return raw;
  return 'dry_run';
}

/** The decide loop interval. 10 minutes (plan §6). */
export function pmTickIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(env.PM_TICK_INTERVAL_MS ?? '600000', 10);
  return Number.isFinite(n) && n > 0 ? n : 600000;
}
