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
 */

import { Router, Request, Response } from 'express';
import { VITANA_ENV, supabaseHost, cloudRunRevision, cloudRunService } from '../env';

const router = Router();

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

export default router;
