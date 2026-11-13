/**
 * VTID-05658 — client identity middleware (native-app adoption measurement).
 *
 * - Echoes the request class on every response: `X-Vitana-Client-Class: native | web`, set with
 *   res.setHeader before next() (classifier: lane client-identity-gateway, VTID-05657).
 * - When the response finishes, if route-level auth has set `req.identity` with BOTH a user_id and a
 *   tenant_id, records one (day, tenant, member, class) row, best effort. `req.identity` is read at
 *   `finish`, never at mount time, and no JWT is decoded here. Never fails or delays the request.
 */
import type { NextFunction, Request, Response } from 'express';
import { CLIENT_HEADER, classifyClient } from '../services/client-identity/classify';
import { seenRecorder, type SeenRecorder } from '../services/client-adoption/seen-store';

export const CLIENT_CLASS_HEADER = 'X-Vitana-Client-Class';

export function clientIdentity(recorder: SeenRecorder = seenRecorder) {
  return (req: Request, res: Response, next: NextFunction): void => {
    let clientClass: ReturnType<typeof classifyClient> = 'web';
    try {
      clientClass = classifyClient(req.headers[CLIENT_HEADER.toLowerCase()]);
      res.setHeader(CLIENT_CLASS_HEADER, clientClass);
      res.once('finish', () => {
        try {
          const identity = (req as Request & { identity?: { user_id?: string | null; tenant_id?: string | null } }).identity;
          const userId = identity?.user_id;
          const tenantId = identity?.tenant_id;
          if (!identity || !userId || !tenantId) return;
          recorder.record({ tenantId, userId, clientClass });
        } catch {
          /* best effort */
        }
      });
    } catch {
      /* never fail a request over measurement */
    }
    next();
  };
}
