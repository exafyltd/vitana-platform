/**
 * VTID-05095: a member verifies their own phone number.
 *
 *   GET    /api/v1/me/phone                       verified number (masked), switch state
 *   POST   /api/v1/me/phone/verification          { phone, region? } → SMS code
 *   POST   /api/v1/me/phone/verification/confirm  { code } → number verified
 *   DELETE /api/v1/me/phone                       remove the verified number
 *
 * Every route needs a signed-in member and only ever acts on their own
 * number. Behind PHONE_VERIFY_ENABLED (exact 'true'); off = 503
 * PHONE_VERIFY_DISABLED on the three write routes, and GET reports
 * enabled:false so the app hides the entry points.
 */

import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import {
  confirmVerification,
  getPhoneStatus,
  removePhone,
  startVerification,
  type Outcome,
  type PhoneVerificationDeps,
} from '../services/phone-verification/service';
import { logMisconfigurationOnce } from '../services/phone-verification/config';

const LOG = '[me-phone]';

// Per-IP backstop in front of the per-member limits the database enforces.
const ipLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { ok: false, error: 'TOO_MANY_REQUESTS' },
  standardHeaders: true,
  legacyHeaders: false,
});

export function createMePhoneRouter(deps: PhoneVerificationDeps): Router {
  const router = Router();
  router.use(requireAuth as any);
  logMisconfigurationOnce();

  const send = (res: Response, out: Outcome) => res.status(out.status).json(out.body);
  const userOf = (req: AuthenticatedRequest) => req.identity?.user_id ?? null;

  const handle =
    (fn: (userId: string, req: AuthenticatedRequest) => Promise<Outcome>) =>
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = userOf(req);
      if (!userId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
      try {
        return send(res, await fn(userId, req));
      } catch (err: any) {
        console.error(`${LOG} ${req.method} ${req.path} failed: ${err?.message ?? err}`);
        return res.status(502).json({ ok: false, error: 'PHONE_VERIFY_FAILED' });
      }
    };

  router.get('/', handle((userId) => getPhoneStatus(deps, userId)) as any);
  router.post(
    '/verification',
    ipLimit,
    handle((userId, req) => startVerification(deps, userId, { phone: req.body?.phone, region: req.body?.region })) as any,
  );
  router.post(
    '/verification/confirm',
    ipLimit,
    handle((userId, req) => confirmVerification(deps, userId, { code: req.body?.code })) as any,
  );
  router.delete('/', handle((userId) => removePhone(deps, userId)) as any);
  return router;
}

let defaultRouter: Router | null = null;

/** The router with the real dependencies, built on first use. */
export default function mePhoneRouter(): Router {
  if (!defaultRouter) {
    const { phoneVerificationDeps } = require('../services/phone-verification/deps');
    defaultRouter = createMePhoneRouter(phoneVerificationDeps);
  }
  return defaultRouter;
}
