/**
 * VTID-05177 — builds the GET /api/v1/app-config answer: the checked-in
 * defaults with every armed, unexpired `native_app.kill.*` control applied.
 *
 * A kill can only switch a flag OFF. It never turns a flag on and never
 * changes a version. `all` applies to both platforms; an unknown platform or
 * flag in a key is ignored. Staging and production read the same
 * system_controls rows, so a kill applies to both — intended, since it only
 * ever disables.
 *
 * The kill read sits behind a 10 s in-process cache (the system_controls TTL).
 * Only successful reads are cached; a failed read is reported, never papered
 * over with defaults.
 */

import {
  APP_CONFIG_DEFAULTS,
  APP_CONFIG_FLAGS,
  APP_CONFIG_PLATFORMS,
  APP_CONFIG_SCHEMA_VERSION,
  APP_CONFIG_TTL_SECONDS,
  type AppConfigFlag,
  type AppConfigPlatform,
  type PlatformConfig,
} from './defaults';
import { NATIVE_APP_KILL_PREFIX, type FetchKillRows, type KillControlRow } from './app-config-repository';

export const KILL_CACHE_TTL_MS = 10_000;

export interface AppConfigBody {
  ok: true;
  schema_version: number;
  generated_at: string;
  ttl_seconds: number;
  platforms: Record<AppConfigPlatform, PlatformConfig>;
}

export type AppConfigResult = { ok: true; body: AppConfigBody } | { ok: false; error: string };

function isArmed(row: KillControlRow, now: Date): boolean {
  if (row.enabled !== true) return false;
  if (row.expires_at) {
    const t = Date.parse(row.expires_at);
    if (!Number.isNaN(t) && t <= now.getTime()) return false;
  }
  return true;
}

/**
 * Pure merge: defaults + kills → platforms. `base` defaults to the checked-in
 * file; tests pass an all-on base to prove a kill only ever switches off.
 */
export function applyKills(
  rows: KillControlRow[],
  now: Date,
  base: Readonly<Record<AppConfigPlatform, PlatformConfig>> = APP_CONFIG_DEFAULTS,
): Record<AppConfigPlatform, PlatformConfig> {
  const platforms = JSON.parse(JSON.stringify(base)) as Record<AppConfigPlatform, PlatformConfig>;
  for (const row of rows) {
    if (typeof row?.key !== 'string' || !row.key.startsWith(NATIVE_APP_KILL_PREFIX)) continue;
    if (!isArmed(row, now)) continue;
    const [scope, flag, ...rest] = row.key.slice(NATIVE_APP_KILL_PREFIX.length).split('.');
    if (rest.length || !(APP_CONFIG_FLAGS as readonly string[]).includes(flag)) continue;
    const targets: AppConfigPlatform[] =
      scope === 'all'
        ? [...APP_CONFIG_PLATFORMS]
        : (APP_CONFIG_PLATFORMS as readonly string[]).includes(scope)
          ? [scope as AppConfigPlatform]
          : [];
    for (const p of targets) platforms[p].flags[flag as AppConfigFlag] = false;
  }
  return platforms;
}

export function createAppConfigReader(fetchKillRows: FetchKillRows, clock: () => Date = () => new Date()) {
  let cache: { rows: KillControlRow[]; at: number } | null = null;

  return async function readAppConfig(): Promise<AppConfigResult> {
    const now = clock();
    let rows: KillControlRow[];
    if (cache && now.getTime() - cache.at < KILL_CACHE_TTL_MS) {
      rows = cache.rows;
    } else {
      const res = await fetchKillRows();
      if ('error' in res) return { ok: false, error: res.error };
      rows = res.rows;
      cache = { rows, at: now.getTime() };
    }
    return {
      ok: true,
      body: {
        ok: true,
        schema_version: APP_CONFIG_SCHEMA_VERSION,
        generated_at: now.toISOString(),
        ttl_seconds: APP_CONFIG_TTL_SECONDS,
        platforms: applyKills(rows, now),
      },
    };
  };
}
