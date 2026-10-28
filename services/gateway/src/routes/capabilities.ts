/**
 * VTID-01939: Capability HTTP routes.
 *
 *   GET  /api/v1/capabilities                 — list all capabilities (tool schemas)
 *   POST /api/v1/capabilities/:capability     — invoke a capability
 *   GET  /api/v1/capabilities/my-connectors   — enumerate the user's connected providers + capabilities they unlock
 *
 * Mounted at /api/v1/capabilities by src/index.ts.
 */
import { Router, Request, Response } from 'express';
import { optionalAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { listCapabilities, executeCapability } from '../capabilities';
import { listConnectors } from '../connectors';
import * as repo from './capabilities-repository';

const router = Router();
// VTID-04401: verify every bearer token before a handler reads the identity.
router.use(optionalAuth);

async function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(url, key);
}

// VTID-04401: the identity comes from optionalAuth, which VERIFIES the token.
// This used to base64-decode the payload without checking the signature, so a
// forged token naming any user id reached that user's connected accounts with
// the service role.
function extractUserFromJwt(req: Request): { userId: string; tenantId: string } | null {
  const identity = (req as AuthenticatedRequest).identity;
  if (!identity?.user_id) return null;
  return { userId: identity.user_id, tenantId: identity.tenant_id || process.env.DEFAULT_TENANT_ID || '' };
}

/** GET /api/v1/capabilities — list the full capability catalogue. */
router.get('/', (_req: Request, res: Response) => {
  return res.json({ ok: true, capabilities: listCapabilities() });
});

/** GET /api/v1/capabilities/my-connectors — user-scoped: what they've connected and what that unlocks. */
router.get('/my-connectors', async (req: Request, res: Response) => {
  const user = extractUserFromJwt(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Authentication required' });

  const supabase = await getServiceClient();
  if (!supabase) return res.status(503).json({ ok: false, error: 'Service unavailable' });

  const { data: activeRows } = await repo.fetchActiveSocialConnectionsForUser(supabase, user.userId);

  const activeByProvider = new Map((activeRows ?? []).map((r) => [r.provider, r]));
  const connectors = listConnectors().map((c) => ({
    ...c,
    connected: activeByProvider.has(c.id),
    provider_username: activeByProvider.get(c.id)?.provider_username ?? null,
    connected_at: activeByProvider.get(c.id)?.connected_at ?? null,
  }));
  return res.json({ ok: true, connectors });
});

/**
 * VTID-01942 PR 2: preferences CRUD so users can pin a default provider per
 * capability (e.g. "always play music via YouTube Music") and clear it later.
 * Must be declared BEFORE the generic POST /:capability route below or
 * "/preferences" would be parsed as a capability name.
 *
 *   GET    /api/v1/capabilities/preferences                — list user prefs
 *   PUT    /api/v1/capabilities/preferences/:capability    — set / update one
 *   DELETE /api/v1/capabilities/preferences/:capability    — clear one
 */
router.get('/preferences', async (req: Request, res: Response) => {
  const user = extractUserFromJwt(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Authentication required' });

  const supabase = await getServiceClient();
  if (!supabase) return res.status(503).json({ ok: false, error: 'Service unavailable' });

  const { data, error } = await repo.fetchUserCapabilityPreferences(supabase, user.userId);

  if (error) return res.status(500).json({ ok: false, error: error.message });
  return res.json({ ok: true, preferences: data ?? [] });
});

router.put('/preferences/:capability', async (req: Request, res: Response) => {
  const user = extractUserFromJwt(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Authentication required' });

  const capability = req.params.capability;
  const body = (req.body && typeof req.body === 'object') ? req.body as any : {};
  const preferred_connector_id = String(body.preferred_connector_id ?? '').trim();
  const rawSetMethod = String(body.set_method ?? 'explicit').trim();
  const set_method: 'explicit' | 'learned' | 'onboarding' =
    rawSetMethod === 'learned' ? 'learned'
      : rawSetMethod === 'onboarding' ? 'onboarding'
        : 'explicit';

  if (!preferred_connector_id) {
    return res.status(400).json({ ok: false, error: 'preferred_connector_id is required' });
  }

  const supabase = await getServiceClient();
  if (!supabase) return res.status(503).json({ ok: false, error: 'Service unavailable' });

  const { data, error } = await repo.upsertUserCapabilityPreference(supabase, {
    tenant_id: user.tenantId,
    user_id: user.userId,
    capability_id: capability,
    preferred_connector_id,
    set_method,
    updated_at: new Date().toISOString(),
  });

  if (error) return res.status(500).json({ ok: false, error: error.message });
  return res.json({ ok: true, preference: data });
});

router.delete('/preferences/:capability', async (req: Request, res: Response) => {
  const user = extractUserFromJwt(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Authentication required' });

  const supabase = await getServiceClient();
  if (!supabase) return res.status(503).json({ ok: false, error: 'Service unavailable' });

  const { error } = await repo.deleteUserCapabilityPreference(supabase, user.userId, req.params.capability);

  if (error) return res.status(500).json({ ok: false, error: error.message });
  return res.json({ ok: true });
});

/** POST /api/v1/capabilities/:capability — invoke a capability. */
router.post('/:capability', async (req: Request, res: Response) => {
  const user = extractUserFromJwt(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Authentication required' });

  const supabase = await getServiceClient();
  if (!supabase) return res.status(503).json({ ok: false, error: 'Service unavailable' });

  const capability = req.params.capability;
  const args = (req.body && typeof req.body === 'object') ? req.body : {};
  const result = await executeCapability(
    { supabase, userId: user.userId, tenantId: user.tenantId },
    capability,
    args,
  );
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

export default router;
