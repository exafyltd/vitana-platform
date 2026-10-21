/**
 * VTID-05216 — Project Manager read route. Mounted at /api/v1/project-manager.
 *
 *   GET /status   the PM mode and the current (last tick's) decision list.
 *                 VTID-05274: plus `claude: {available, reason}`, `fallback`,
 *                 `build_lanes_in_flight`, `last_lease`.
 *   GET /mode     VTID-05274 (plan kiro-autonomy-fallback §3, R1-F3): PUBLIC on
 *                 purpose — only `{ok, enabled, mode, executor_mode}` so the
 *                 read-only STAGING-VERIFY runner (no credential) can prove the
 *                 mode. Discloses which executor routing is active (one enum),
 *                 nothing about why, no lane / PR / user / decision data; the
 *                 reason and the 4 h evidence stay behind requireServiceOrAdmin.
 *
 * Read-only. No write/act endpoint. Auth for /status: GATEWAY_SERVICE_TOKEN or
 * an exafy_admin JWT (same gate as the other control-plane read routes).
 */

import { Router, Request, Response } from 'express';
import { requireServiceOrAdmin } from '../middleware/require-service-or-admin';
import {
  PmStatusSnapshot,
  getStatusSnapshot,
  pmAgentEnabled,
} from '../services/project-manager';

type SnapshotFn = () => PmStatusSnapshot;

/** Factory so tests inject the snapshot source; production uses the module state. */
export function createProjectManagerRouter(getSnapshot: SnapshotFn = getStatusSnapshot): Router {
  const router = Router();

  // Public on purpose: one executor-routing enum, no member, lane or decision data — the read-only staging suite (rule 48) checks it without a sign-in.
  router.get('/mode', (_req: Request, res: Response) => { // public-route
    const snapshot = getSnapshot();
    return res.status(200).json({
      ok: true,
      enabled: pmAgentEnabled(),
      mode: snapshot.mode,
      executor_mode: snapshot.fallback ? 'kiro_fallback' : 'claude_primary',
    });
  });

  router.get('/status', requireServiceOrAdmin, (_req: Request, res: Response) => {
    const snapshot = getSnapshot();
    return res.status(200).json({
      ok: true,
      enabled: pmAgentEnabled(),
      mode: snapshot.mode,
      last_tick_at: snapshot.last_tick_at,
      decisions: snapshot.decisions,
      claude: snapshot.claude ?? { available: true, reason: null },
      fallback: snapshot.fallback ?? false,
      build_lanes_in_flight: snapshot.build_lanes_in_flight ?? {},
      last_lease: snapshot.last_lease ?? null,
    });
  });

  return router;
}

export const projectManagerRouter = createProjectManagerRouter();
