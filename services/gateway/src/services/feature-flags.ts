/**
 * Feature flag helper — Phase 0 staging build (handoff brief P0.3).
 *
 * Convention:
 *   - One env var per feature, named FEATURE_<NAME>_ENV.
 *   - Values: 'off' | 'staging-only' | 'staging+prod'.
 *   - Unset = 'off'.
 *
 * Same code on `main` deploys to both stacks; behavior is gated by setting
 * the env var per Cloud Run service. A feature graduates 'off' → 'staging-only'
 * → 'staging+prod' over the experiment window, with rollback = flip the env
 * var back without a redeploy.
 *
 * Usage:
 *   import { isFeatureLive } from '../services/feature-flags';
 *   if (isFeatureLive('FINETUNED_GREETING')) { ... }
 */

import { isStaging } from '../env';

export type FeatureFlagSetting = 'off' | 'staging-only' | 'staging+prod';

// Behavior-safe defaults (BOOTSTRAP-MEMORY-DAILY-LEARNING): shadow-mode flags
// only LOG a naive-vs-ranked comparison and never change what ships, so they
// default ON in staging to collect flip-evidence without an operator env
// change. An explicit env value always wins.
const DEFAULT_SETTINGS: Record<string, FeatureFlagSetting> = {
  VOICE_RANKING_SHADOW: 'staging-only',
};

/**
 * VTID-04098 — an unrecognised value must not fail SILENTLY.
 *
 * Found live on 2026-09-19: the production gateway task definition
 * (`vitana-gateway-awsdr` rev 108) carried
 * `FEATURE_LATENCY_TELEMETRY_ENV = "production"` and
 * `FEATURE_ORB_SAFE_FAST_GREETING_ENV = "production"`. `production` is not one
 * of the three accepted values, so both resolved to `off` — the operator
 * believed phase-level voice latency telemetry and the greeting-facts prefetch
 * were ON in production for weeks while neither was, and nothing anywhere said
 * so. That is precisely the failure CLAUDE.md Part 1 ALWAYS rule 10 ("always
 * fail loudly if a required invariant is missing") exists to prevent.
 *
 * It logs rather than throws, deliberately: a typo in one flag must not take
 * the whole gateway down on boot, and the safe VALUE is still `off`. The
 * warning is emitted once per flag name (this is read on the session hot path,
 * so an unbounded log would be its own incident) and the condition is also
 * reported by `GET /api/v1/admin/health/feature-flags` as `invalid_value`,
 * which is where drift is meant to be noticed.
 */
const warnedInvalid = new Set<string>();

export function isRecognisedFeatureFlagValue(raw: string | undefined): boolean {
  return raw === 'off' || raw === 'staging-only' || raw === 'staging+prod';
}

export function featureFlagHasInvalidValue(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[`FEATURE_${name}_ENV`];
  return raw !== undefined && !isRecognisedFeatureFlagValue(raw);
}

function readSetting(name: string): FeatureFlagSetting {
  const raw = process.env[`FEATURE_${name}_ENV`];
  if (isRecognisedFeatureFlagValue(raw)) return raw as FeatureFlagSetting;
  if (raw !== undefined && !warnedInvalid.has(name)) {
    warnedInvalid.add(name);
    console.error(
      `[VTID-04098][feature-flags] FEATURE_${name}_ENV is set to ${JSON.stringify(raw)}, which is not one of ` +
        `'off' | 'staging-only' | 'staging+prod'. Resolving to '${DEFAULT_SETTINGS[name] ?? 'off'}' — the feature is ` +
        `NOT enabled. Fix the task definition; this is a silent-disable, not a warning you can leave.`,
    );
  }
  return DEFAULT_SETTINGS[name] ?? 'off';
}

/**
 * True iff the feature should be active on THIS process's environment.
 * Reads the env var at call time so live operator changes via `gcloud run
 * services update` take effect without an in-memory cache to invalidate.
 */
export function isFeatureLive(name: string): boolean {
  const setting = readSetting(name);
  if (setting === 'off') return false;
  if (setting === 'staging-only') return isStaging;
  if (setting === 'staging+prod') return true;
  return false;
}

/**
 * Inspect the configured setting (useful for /admin/health and feature
 * inventory endpoints — never gate logic on this; use isFeatureLive).
 */
export function featureFlagSetting(name: string): FeatureFlagSetting {
  return readSetting(name);
}
