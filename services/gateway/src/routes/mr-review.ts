/**
 * POST /api/v1/mr-review. The Express Router is injected (makeRouter), so the
 * route can be tested without Express. The gateway passes express.Router.
 * Fails closed: unconfigured → 503, unauthenticated → 401 (from the handler),
 * a thrown error → 502 with no detail.
 */
import { timingSafeEqual } from 'node:crypto';
import { handleReviewRequest, type ReviewEndpointDeps } from '../services/mr-review/endpoint';

export interface RouterLike {
  post(path: string, handler: (req: any, res: any) => Promise<void>): unknown;
}

/** Dedicated caller credential for the review route: a constant-time compare, refused when unset or short. */
export function callerAuthorizer(expected: string | undefined): (authorization: string | undefined) => boolean {
  return (authorization) => {
    if (!expected || expected.length < 32) return false;
    if (!authorization || !authorization.toLowerCase().startsWith('bearer ')) return false;
    const got = Buffer.from(authorization.slice(7).trim(), 'utf8');
    const want = Buffer.from(expected, 'utf8');
    return got.length === want.length && timingSafeEqual(got, want);
  };
}

export function createMrReviewRouter(makeRouter: () => RouterLike, getDeps: () => ReviewEndpointDeps | null): RouterLike {
  const router = makeRouter();
  router.post('/mr-review', async (req: any, res: any) => {
    const deps = getDeps();
    if (!deps) {
      res.status(503).json({ error: 'mr-review is not configured' });
      return;
    }
    try {
      const r = await handleReviewRequest(deps, { authorization: req.headers?.authorization, body: req.body });
      res.status(r.status).json(r.body);
    } catch {
      res.status(502).json({ error: 'review failed' });
    }
  });
  return router;
}
