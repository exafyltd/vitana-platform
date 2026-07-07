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

function readSetting(name: string): FeatureFlagSetting {
  const raw = process.env[`FEATURE_${name}_ENV`];
  if (raw === 'off' || raw === 'staging-only' || raw === 'staging+prod') return raw;
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
