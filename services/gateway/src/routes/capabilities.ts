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
import { listCapabilities, executeCapability } from '../capabilities';
import { listConnectors } from '../connectors';

const router = Router();

async function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(url, key);
}

function extractUserFromJwt(req: Request): { userId: string; tenantId: string } | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const token = authHeader.split(' ')[1];
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return {
      userId: payload.sub,
      tenantId: payload.app_metadata?.active_tenant_id || process.env.DEFAULT_TENANT_ID || '',
    };
  } catch {
    return null;
  }
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

  const { data: activeRows } = await supabase
    .from('social_connections')
    .select('provider, provider_username, connected_at')
    .eq('user_id', user.userId)
    .eq('is_active', true);

  const activeByProvider = new Map((activeRows ?? []).map((r) => [r.provider, r]));
  const connectors = listConnectors().map((c) => ({
    ...c,
    connected: activeByProvider.has(c.id),
    provider_username: activeByProvider.get(c.id)?.provider_username ?? null,
    connected_at: activeByProvider.get(c.id)?.connected_at ?? null,
  }));
  return res.json({ ok: true, connectors });
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
