/**
 * HTTP surface of the embedded authorization server (BLK-007).
 * No HTML is rendered here — /oauth/authorize 302s to the vitana-v1 consent
 * page, which authenticates the user with their existing Supabase session
 * and posts the outcome to /oauth/authorize/decision.
 */
import express, { Request, Response, Router } from 'express';
import { AuthorizationServer, OAuthError } from './authorization-server';
import { RateLimiter } from '../rate-limit';

const oauthFail = (res: Response, err: unknown) => {
  if (err instanceof OAuthError) {
    const status = err.code === 'invalid_client' ? 401 : 400;
    return res.status(status).json({ error: err.code, error_description: err.message });
  }
  return res.status(500).json({ error: 'server_error', error_description: 'unexpected error' });
};

export function buildAuthServerRouter(as: AuthorizationServer, limiter?: RateLimiter): Router {
  const router = Router();
  const ipLimiter = limiter ?? new RateLimiter({ limitPerWindow: 30, windowMs: 60_000 });
  const limitByIp = (req: Request, res: Response, next: () => void) => {
    if (!ipLimiter.allow(`as:${req.ip ?? 'unknown'}`)) {
      res.status(429).set('Retry-After', '60').json({ error: 'slow_down' });
      return;
    }
    next();
  };

  router.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json(as.metadata());
  });

  router.get('/oauth/jwks', (_req, res) => {
    res.json(as.jwks());
  });

  // RFC 7591 open dynamic registration (rate-limited; public PKCE clients only).
  router.post('/oauth/register', limitByIp, express.json(), (req, res) => {
    try {
      const client = as.registerClient(req.body ?? {});
      res.status(201).json(client);
    } catch (err) {
      oauthFail(res, err);
    }
  });

  // Browser-facing: validate, then hand off to the frontend consent page.
  router.get('/oauth/authorize', limitByIp, (req, res) => {
    try {
      const target = as.buildConsentRedirect(req.query as Record<string, unknown>);
      res.redirect(302, target);
    } catch (err) {
      oauthFail(res, err);
    }
  });

  // Called by the consent page with the user's Supabase access token.
  router.post('/oauth/authorize/decision', limitByIp, express.json(), async (req, res) => {
    try {
      const { params, supabase_access_token, approved, approved_scopes } = req.body ?? {};
      const result = await as.decision({
        params: params ?? {},
        supabaseAccessToken: String(supabase_access_token ?? ''),
        approved: approved === true,
        approvedScopes: Array.isArray(approved_scopes) ? approved_scopes : undefined,
      });
      res.json({ ok: true, redirect_to: result.redirectTo });
    } catch (err) {
      oauthFail(res, err);
    }
  });

  router.post('/oauth/token', limitByIp, express.urlencoded({ extended: false }), express.json(), (req, res) => {
    try {
      res.json(as.token(req.body ?? {}));
    } catch (err) {
      oauthFail(res, err);
    }
  });

  return router;
}
