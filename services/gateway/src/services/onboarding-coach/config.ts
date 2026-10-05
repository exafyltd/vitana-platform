/**
 * VTID-04892 — which mode the onboarding coach runs in, decided in one place.
 *
 *   disabled-on-staging  the staging gateway never runs the coach: staging and
 *                        production share one database, so a staging run would
 *                        write coach rows (and later sends) for real members
 *                        (plan v3 §4.2, sparring F5/N1).
 *   off                  FEATURE_ONBOARDING_ASSISTANT_ENV is not live here, or
 *                        VOA_ROLLOUT_DATE is missing/invalid.
 *   shadow               decide and record what Vitana would do; send nothing.
 *
 * Slice 1 has no live mode: VOA_MODE=live is reported as `live_not_available`
 * and the coach still runs in shadow. Sending arrives in a later slice.
 */
import { isStaging as runningOnStaging } from '../../env';
import { isFeatureLive } from '../feature-flags';

export type CoachMode = 'disabled-on-staging' | 'off' | 'shadow';

export interface CoachConfig {
  mode: CoachMode;
  reason: string;
  rolloutDate: Date | null;
}

export const COACH_FEATURE = 'ONBOARDING_ASSISTANT';

export function resolveCoachConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: { isStaging?: boolean; featureLive?: boolean } = {},
): CoachConfig {
  const staging = opts.isStaging ?? runningOnStaging;
  if (staging) return { mode: 'disabled-on-staging', reason: 'staging_shares_production_database', rolloutDate: null };

  const live = opts.featureLive ?? isFeatureLive(COACH_FEATURE);
  if (!live) return { mode: 'off', reason: 'feature_off', rolloutDate: null };

  const raw = (env.VOA_ROLLOUT_DATE ?? '').trim();
  const rolloutDate = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00Z`) : null;
  if (!rolloutDate || Number.isNaN(rolloutDate.getTime())) {
    return { mode: 'off', reason: 'rollout_date_missing', rolloutDate: null };
  }

  const requested = (env.VOA_MODE ?? 'shadow').trim().toLowerCase();
  const reason = requested === 'live' ? 'live_not_available' : 'shadow';
  return { mode: 'shadow', reason, rolloutDate };
}
