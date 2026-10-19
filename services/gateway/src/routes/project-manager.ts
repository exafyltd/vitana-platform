/**
 * VTID-05216 — Project Manager read route. Mounted at /api/v1/project-manager.
 *
 *   GET /status   the PM mode and the current (last tick's) decision list.
 *
 * Read-only. P3 adds no write/act endpoint; the mode switch and act are later
 * phases. Auth: GATEWAY_SERVICE_TOKEN or an exafy_admin JWT (same gate as the
 * other control-plane read routes).
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

  router.get('/status', requireServiceOrAdmin, (_req: Request, res: Response) => {
    const snapshot = getSnapshot();
    return res.status(200).json({
      ok: true,
      enabled: pmAgentEnabled(),
      mode: snapshot.mode,
      last_tick_at: snapshot.last_tick_at,
      decisions: snapshot.decisions,
    });
  });

  return router;
}

export const projectManagerRouter = createProjectManagerRouter();
