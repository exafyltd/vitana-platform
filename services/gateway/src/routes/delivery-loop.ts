/**
 * Delivery loop status route. Mounted at /api/v1/delivery-loop.
 *
 *   GET /status   whether the loop is on, why it is not running when it is not, its level, its projects, whether GitLab, the reviewer
 *                 and an executor are configured, and the result of its last cycle.
 *
 * Read-only: no write and no act endpoint, and nothing here can turn the loop on or change its level (that is the owner's, through
 * the environment). Auth: GATEWAY_SERVICE_TOKEN or an exafy_admin JWT, the gate of the other control-plane read routes. The status
 * carries project paths and counts, never the GitLab token, an issue's text or a log line.
 */
import { Router, Request, Response } from 'express';
import { requireServiceOrAdmin } from '../middleware/require-service-or-admin';
import type { LoopStatus } from '../services/delivery-loop/runtime';

/** What the status route reads. The loop's own status in production; a fake in tests. */
export type StatusSource = () => LoopStatus | null;

let current: StatusSource = () => null;

/** index.ts registers the running loop here, so the route reads the live one. */
export function setDeliveryLoopStatusSource(source: StatusSource): void {
  current = source;
}

export function createDeliveryLoopRouter(getStatus: StatusSource = () => current()): Router {
  const router = Router();

  router.get('/status', requireServiceOrAdmin, (_req: Request, res: Response) => {
    const status = getStatus();
    // No loop was started in this process (it is not enabled): say so plainly rather than answering with an empty object.
    if (!status) return res.status(200).json({ ok: true, enabled: false, not_running_reason: 'the delivery loop was not started in this process' });
    return res.status(200).json({ ok: true, ...status });
  });

  return router;
}

export const deliveryLoopRouter = createDeliveryLoopRouter();
