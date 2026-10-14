/**
 * VTID-05177 — GET /api/v1/app-config: native app remote config.
 *
 * No auth, no tenant, no member data. Per-platform flags and minimum
 * supported version from services/app-config/defaults.ts, with any armed
 * `native_app.kill.*` system control forcing its flag off.
 *
 *   200 { ok, schema_version, generated_at, ttl_seconds, platforms }
 *       Cache-Control: public, max-age=60
 *   503 { ok:false, error:'config_unavailable' } when the kill switches could
 *       not be read — the app keeps its cached config; this endpoint never
 *       answers with flags it could not check.
 *   429 { ok:false, error:'TOO_MANY_REQUESTS' } past 120 requests/min per IP.
 *
 * The payload is static, the edge may cache it for 60 s and the kill read has
 * a 10 s in-process cache, so the per-IP limiter only bounds abuse.
 */

import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { fetchNativeAppKillRows, type FetchKillRows } from '../services/app-config/app-config-repository';
import { createAppConfigReader } from '../services/app-config/app-config-service';

export interface AppConfigRouterDeps {
  fetchKillRows?: FetchKillRows;
  clock?: () => Date;
}

export function createAppConfigRouter(deps: AppConfigRouterDeps = {}): Router {
  const router = Router();
  const readAppConfig = createAppConfigReader(deps.fetchKillRows ?? fetchNativeAppKillRows, deps.clock);

  const ipLimit = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    message: { ok: false, error: 'TOO_MANY_REQUESTS' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.get('/', ipLimit, async (_req: Request, res: Response) => { // public-route — read before sign-in (VTID-05177)
    const result = await readAppConfig();
    if (!result.ok) {
      console.warn(`[app-config] kill switch read failed (${result.error}); answering 503`);
      res.set('Cache-Control', 'no-store');
      return res.status(503).json({ ok: false, error: 'config_unavailable' });
    }
    res.set('Cache-Control', 'public, max-age=60');
    return res.status(200).json(result.body);
  });

  return router;
}

export default createAppConfigRouter();
