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
