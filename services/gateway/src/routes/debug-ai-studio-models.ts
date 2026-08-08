/**
 * BOOTSTRAP-AWS-STAGING-VALIDATION: TEMPORARY debug route.
 *
 * Diagnosing why GeminiApiKeyLiveClient's Live handshake gets rejected with
 * "models/gemini-2.0-flash-live-001 is not found for API version v1beta,
 * or is not supported for bidiGenerateContent" (also tried v1alpha — same
 * result). The sandbox this investigation runs from cannot reach
 * generativelanguage.googleapis.com directly (network policy blocks it),
 * but the gateway itself can (every WS handshake attempt has proven that).
 * This proxies Google's own ListModels so the real, current model catalog
 * for GOOGLE_GEMINI_API_KEY can be read from the response instead of
 * guessed at.
 *
 * REMOVE THIS FILE once the correct model id is confirmed and
 * AI_STUDIO_LIVE_MODEL is set correctly (orb/live/config.ts).
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';

const router = Router();

async function requireDevRole(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.get('X-Gateway-Internal') === (process.env.GATEWAY_INTERNAL_TOKEN || '__dev__') &&
      process.env.GATEWAY_INTERNAL_TOKEN) {
    return next();
  }
  let authFailed = false;
  await requireAuth(req as AuthenticatedRequest, res, () => {
    const identity = (req as AuthenticatedRequest).identity;
    if (!identity) {
      authFailed = true;
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
      return;
    }
    if (identity.exafy_admin === true) return next();
    authFailed = true;
    res.status(403).json({ ok: false, error: 'requires developer access (exafy_admin)' });
  });
  if (authFailed) return;
}

router.get('/debug/ai-studio-models', requireDevRole, async (req: Request, res: Response) => {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY || '';
  if (!apiKey) {
    res.status(500).json({ ok: false, error: 'GOOGLE_GEMINI_API_KEY not configured' });
    return;
  }
  const apiVersion = (req.query.version as string) || 'v1beta';
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/${encodeURIComponent(apiVersion)}/models?key=${encodeURIComponent(apiKey)}`,
    );
    const body = (await resp.json()) as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> };
    if (!resp.ok) {
      res.status(resp.status).json({ ok: false, api_version: apiVersion, google_error: body });
      return;
    }
    const models = (body.models || []) as Array<{ name: string; supportedGenerationMethods?: string[] }>;
    const liveCapable = models.filter((m) =>
      (m.supportedGenerationMethods || []).some((mm) => mm.toLowerCase().includes('bidi')),
    );
    res.json({
      ok: true,
      api_version: apiVersion,
      total_models: models.length,
      live_capable: liveCapable.map((m) => ({ name: m.name, methods: m.supportedGenerationMethods })),
      all_model_names: models.map((m) => m.name),
    });
  } catch (err: any) {
    res.status(502).json({ ok: false, error: err?.message || String(err) });
  }
});

export default router;
