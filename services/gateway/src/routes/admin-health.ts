/**
 * /api/v1/admin/health and /api/v1/admin/build-info
 *
 * Phase 0 staging build (handoff brief P0.3 + Smoke C acceptance).
 *
 * Both endpoints are deliberately auth-free diagnostic surfaces — they carry
 * no secrets, only environment identity (VITANA_ENV), the Supabase hostname
 * (no key, no path), and the running Cloud Run revision. They exist so that
 * the STAGE-DEPLOY post-deploy smoke can `curl` them and prove the new
 * revision is live, and so that an operator can verify staging vs prod
 * isolation from a phone in 5 seconds.
 *
 * If you ever want to attach sensitive fields, gate them behind requireAdminAuth
 * — never weaken the public response.
 *
 * `/feature-flags` (added below) follows that rule: it is admin-gated, and the
 * two public responses above are unchanged.
 */

import { Router, Request, Response } from 'express';
import { VITANA_ENV, supabaseHost, cloudRunRevision, cloudRunService } from '../env';
import { featureFlagSetting, isFeatureLive } from '../services/feature-flags';
import { requireAdminAuth } from '../middleware/auth-supabase-jwt';
import type { AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getOrbSessionStateHealth } from '../services/orb/orb-session-state';

const router = Router();

/**
 * Every feature flag the gateway actually reads. Keep in sync with the
 * `isFeatureLive('...')` call sites — the inventory endpoint below is only
 * useful for drift detection if it is exhaustive.
 */
const KNOWN_FEATURE_FLAGS = [
  'AUTOPILOT_CALENDAR_PREP',
  'BOOTSTRAP_CONTEXT_RANKED_RETRIEVAL',
  'FINETUNED_GREETING',
  'ORB_BRAIN_CACHE',
  'ORB_FAST_START',
  'ORB_GREETING_PREBUFFER',
  'ORB_GREETING_TTS_BRIDGE',
  'ORB_SAFE_FAST_GREETING',
  'ORB_WS_TRANSPORT',
  'VOICE_RANKING_SHADOW',
] as const;

const BOOT_TIME = new Date().toISOString();
const BUILD_COMMIT =
  process.env.GIT_COMMIT_SHA ||
  process.env.COMMIT_SHA ||
  process.env.K_REVISION ||
  null;

router.get('/health', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    env: VITANA_ENV,
    supabase_host: supabaseHost(),
    cloud_run_service: cloudRunService(),
    cloud_run_revision: cloudRunRevision(),
    booted_at: BOOT_TIME,
  });
});

router.get('/build-info', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    env: VITANA_ENV,
    cloud_run_service: cloudRunService(),
    cloud_run_revision: cloudRunRevision(),
    git_commit: BUILD_COMMIT,
    booted_at: BOOT_TIME,
    // Smoke C in the handoff brief calls for an `extra_field` to prove a
    // round-trip from main commit → staging revision → PUBLISH → prod
    // revision. Keep this object stable; bump `marker` when running the smoke
    // so the response visibly differs in the CLOCK history before/after.
    marker: process.env.BUILD_INFO_MARKER || null,
  });
});

/**
 * GET /api/v1/admin/feature-flags — admin-gated feature-flag inventory.
 *
 * Exists because a flag can be *present* on a task definition and still be
 * dead: `isFeatureLive` maps 'staging-only' → `isStaging`, so a value copied
 * from a staging task def evaluates to OFF in production. That is exactly how
 * `FEATURE_ORB_FAST_START_ENV` was lost in the VTID-03419 GCP→AWS cutover —
 * the ORB wake path silently fell back to the legacy inline mode, pushing cold
 * authenticated session/start past the orb widget's 8s abort budget, so the
 * first connect after login hung on "Verbinden..." forever.
 *
 * `setting` is what the env var says; `live` is what the code actually does.
 * Diff this endpoint across two stacks to find drift — compare `live`, never
 * merely whether the variable exists. `misconfigured_for_env` flags the
 * specific staging-only-in-prod trap above.
 *
 * Admin-gated rather than public: the flag inventory reveals which
 * experiments are running, which is more than /health's environment identity.
 */
router.get(
  '/feature-flags',
  requireAdminAuth,
  (_req: AuthenticatedRequest, res: Response) => {
    const flags = KNOWN_FEATURE_FLAGS.map((name) => {
      const setting = featureFlagSetting(name);
      return {
        name,
        env_var: `FEATURE_${name}_ENV`,
        // Whether the variable is set at all — distinguishes "explicitly off"
        // from "never configured on this stack" (the drift signature).
        env_var_present: process.env[`FEATURE_${name}_ENV`] !== undefined,
        setting,
        live: isFeatureLive(name),
        misconfigured_for_env: setting === 'staging-only' && VITANA_ENV === 'production',
      };
    });

    return res.status(200).json({
      ok: true,
      env: VITANA_ENV,
      cloud_run_service: cloudRunService(),
      git_commit: BUILD_COMMIT,
      flags,
    });
  },
);

/**
 * GET /api/v1/admin/orb-session-state-health — VTID-03485.
 *
 * Exists because `orb_session_state` did not exist in production for ~2 months
 * (VTID-03480) and nothing noticed. Every helper in `orb-session-state.ts`
 * fails soft by design, so the outage surfaced only as `ok:false` inside a
 * telemetry payload nobody was alerting on — four ORB features (audio-ready
 * handshake, close/reopen continuity, pending autopilot CTA, opener rotation)
 * were inert the whole time.
 *
 * `ok:false` here means writes/reads are failing *persistently*, not that one
 * blipped. `schema_missing:true` is the specific VTID-03480 signature — the
 * relation itself is unreachable, which in this codebase has meant an authored
 * but never-applied migration.
 *
 * Returns HTTP 503 when unhealthy so an uptime check or `curl -f` alarms
 * without having to parse the body.
 *
 * Admin-gated, matching /feature-flags: failure reasons can echo database
 * error text, which is more than /health's environment identity.
 */
// Kept on one line through `requireAdminAuth` on purpose: the impact-scan rule
// `new-route-without-auth-middleware` matches the added `router.<verb>(` line and
// looks for an auth name on that same line, so the split-argument style used by
// /feature-flags above reads as unauthenticated to it. The gate is real either
// way; this just lets the scanner see it.
router.get('/orb-session-state-health', requireAdminAuth, (_req: AuthenticatedRequest, res: Response) => {
  const health = getOrbSessionStateHealth();
  return res.status(health.ok ? 200 : 503).json({
    ok: health.ok,
    env: VITANA_ENV,
    cloud_run_service: cloudRunService(),
    cloud_run_revision: cloudRunRevision(),
    git_commit: BUILD_COMMIT,
    orb_session_state: health,
  });
});

export default router;
