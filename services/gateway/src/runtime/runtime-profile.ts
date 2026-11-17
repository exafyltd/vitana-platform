/**
 * Runtime profile: the one switch that decides whether this process starts background work.
 *
 * - `full` (default, unset): the normal gateway. Background workers, timers and schedulers start.
 * - `preview-sparring`: the HTTP API only. No background worker starts. Used by the isolated
 *   staging preview that runs plan sparring. It is an allowlist, not a denylist: a worker is off
 *   in this profile without being named anywhere.
 *
 * Fail closed: any other value is a startup error. A typo must never silently run the full
 * worker set against a preview database.
 */

export const RUNTIME_PROFILES = ['full', 'preview-sparring'] as const;
export type RuntimeProfile = (typeof RUNTIME_PROFILES)[number];

export function resolveRuntimeProfile(env: NodeJS.ProcessEnv = process.env): RuntimeProfile {
  const raw = (env.GATEWAY_RUNTIME_PROFILE ?? '').trim();
  if (raw === '') return 'full';
  if ((RUNTIME_PROFILES as readonly string[]).includes(raw)) return raw as RuntimeProfile;
  throw new Error(
    `GATEWAY_RUNTIME_PROFILE="${raw}" is not a known profile (${RUNTIME_PROFILES.join(' | ')}). Refusing to start.`,
  );
}

export function backgroundWorkersAllowed(profile: RuntimeProfile): boolean {
  return profile === 'full';
}

/**
 * Module-level timers (started at import time) must go through this helper, not a bare
 * `setInterval`. In the preview-sparring profile it starts nothing and returns null. This is the
 * one place a process-wide timer can be created, so a new one cannot bypass the profile.
 */
export function scheduleBackground(
  fn: () => void,
  ms: number,
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof setInterval> | null {
  if (!backgroundWorkersAllowed(resolveRuntimeProfile(env))) return null;
  return setInterval(fn, ms);
}
