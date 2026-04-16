/**
 * VTID-02100: Wearables connector routes.
 *
 * Endpoints:
 *   GET  /api/v1/wearables/providers              — list connectors with user status
 *   POST /api/v1/wearables/connect/:connector     — start widget/OAuth flow
 *   POST /api/v1/wearables/disconnect/:connector  — revoke
 *   GET  /api/v1/wearables/connections            — user's active connections
 *   GET  /api/v1/wearables/metrics                — 7-day rollup + recent days
 *   POST /api/v1/wearables/waitlist               — (unchanged — kept for Phase 0 stub during rollout)
 */

import { Router, Request, Response } from 'express';
import * as jose from 'jose';
import { getSupabase } from '../lib/supabase';
import { getConnector, listConnectors } from '../connectors';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();

function getUser(req: Request): { user_id: string; tenant_id: string | null } | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  try {
    const claims = jose.decodeJwt(token);
    const user_id = typeof claims.sub === 'string' ? claims.sub : null;
    if (!user_id) return null;
    const app_metadata = (claims as { app_metadata?: { active_tenant_id?: string } }).app_metadata;
    return { user_id, tenant_id: app_metadata?.active_tenant_id ?? null };
  } catch {
    return null;
  }
}

async function resolveTenantId(userId: string): Promise<string | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase
    .from('user_tenants')
    .select('tenant_id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();
  return data?.tenant_id ?? null;
}

// ==================== GET /providers ====================

router.get('/providers', async (req: Request, res: Response) => {
  const user = getUser(req);
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const { data: registry } = await supabase
    .from('connector_registry')
    .select('*')
    .in('category', ['wearable', 'aggregator'])
    .eq('enabled', true)
    .order('category', { ascending: false })
    .order('display_name', { ascending: true });

  let userConnections: Array<{ connector_id: string; is_active: boolean; last_sync_at: string | null; display_name: string | null }> = [];
  if (user) {
    const { data: connections } = await supabase
      .from('user_connections')
      .select('connector_id, is_active, last_sync_at, display_name')
      .eq('user_id', user.user_id)
      .in('category', ['wearable', 'aggregator']);
    userConnections = connections ?? [];
  }
  const connectionMap = new Map(userConnections.filter((c) => c.is_active).map((c) => [c.connector_id, c]));

  const codeConnectors = new Map(listConnectors().map((c) => [c.id, c]));

  const providers = (registry ?? []).map((r) => {
    const inCode = codeConnectors.has(r.id);
    const userConn = connectionMap.get(r.id);
    const terraConfigured = r.id !== 'terra' || !!process.env.TERRA_API_KEY;
    return {
      id: r.id,
      display_name: r.display_name,
      description: r.description,
      category: r.category,
      auth_type: r.auth_type,
      capabilities: r.capabilities,
      requires_ios_companion: r.requires_ios_companion,
      underlying_providers: r.underlying_providers,
      docs_url: r.docs_url,
      code_registered: inCode,
      env_configured: terraConfigured,
      status: userConn ? 'connected' : 'available',
      last_sync_at: userConn?.last_sync_at ?? null,
    };
  });

  res.json({ ok: true, providers });
});

// ==================== POST /connect/:connector ====================

router.post('/connect/:connector', async (req: Request, res: Response) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const connectorId = req.params.connector;
  const connector = getConnector(connectorId);
  if (!connector) return res.status(404).json({ ok: false, error: `Unknown connector: ${connectorId}` });

  const tenantId = user.tenant_id ?? (await resolveTenantId(user.user_id));
  if (!tenantId) return res.status(400).json({ ok: false, error: 'Tenant not found for user' });

  // For aggregators (Terra) → widget-based flow
  if (connector.generateWidgetUrl) {
    try {
      const widget = await connector.generateWidgetUrl({ tenant_id: tenantId, user_id: user.user_id });
      if (!widget) {
        return res.status(503).json({
          ok: false,
          error: `${connector.display_name} is not configured on this environment (missing API key).`,
        });
      }
      // Persist a pending connection row we'll fill in once the auth webhook arrives
      await supabase
        .from('user_connections')
        .upsert(
          {
            tenant_id: tenantId,
            user_id: user.user_id,
            connector_id: connector.id,
            category: connector.category,
            widget_session_id: widget.session_id,
            enrichment_status: 'pending',
            is_active: false, // flipped to true on auth webhook
          },
          { onConflict: 'tenant_id,user_id,connector_id,provider_user_id' }
        );
      return res.json({ ok: true, connector: connector.id, widget_url: widget.url, widget_session_id: widget.session_id });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(502).json({ ok: false, error: message });
    }
  }

  // Generic OAuth2 flow stub for direct-integration connectors (Fitbit, Oura, ...)
  if (connector.auth_type === 'oauth2' && connector.getOAuthUrl) {
    const state = JSON.stringify({ u: user.user_id, t: tenantId, c: connector.id });
    const stateB64 = Buffer.from(state).toString('base64url');
    const redirectUri = `${process.env.GATEWAY_PUBLIC_URL ?? 'https://gateway-q74ibpv6ia-uc.a.run.app'}/api/v1/wearables/callback/${connector.id}`;
    const url = connector.getOAuthUrl(stateB64, redirectUri);
    return res.json({ ok: true, connector: connector.id, auth_url: url });
  }

  return res.status(501).json({ ok: false, error: `${connector.display_name} does not expose a connect flow yet` });
});

// ==================== POST /disconnect/:connector ====================

router.post('/disconnect/:connector', async (req: Request, res: Response) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const connectorId = req.params.connector;
  const { error } = await supabase
    .from('user_connections')
    .update({ is_active: false, disconnected_at: new Date().toISOString() })
    .eq('user_id', user.user_id)
    .eq('connector_id', connectorId);

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, connector: connectorId });
});

// ==================== GET /connections ====================

router.get('/connections', async (req: Request, res: Response) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const { data, error } = await supabase
    .from('user_connections')
    .select('connector_id, category, display_name, provider_username, is_active, last_sync_at, last_error, connected_at, disconnected_at')
    .eq('user_id', user.user_id)
    .in('category', ['wearable', 'aggregator'])
    .order('connected_at', { ascending: false });
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, connections: data ?? [] });
});

// ==================== GET /metrics ====================

router.get('/metrics', async (req: Request, res: Response) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const [rollup, recent] = await Promise.all([
    supabase.from('wearable_rollup_7d').select('*').eq('user_id', user.user_id).maybeSingle(),
    supabase
      .from('wearable_daily_metrics')
      .select('metric_date, provider, sleep_minutes, sleep_deep_minutes, hrv_avg_ms, resting_hr, active_minutes, workout_count, steps')
      .eq('user_id', user.user_id)
      .order('metric_date', { ascending: false })
      .limit(30),
  ]);

  if (rollup.error) return res.status(500).json({ ok: false, error: rollup.error.message });

  await emitOasisEvent({
    vtid: 'VTID-02100',
    type: 'wearable.metrics.read',
    source: 'gateway',
    status: 'info',
    message: `User ${user.user_id} fetched wearable metrics`,
    payload: {
      user_id: user.user_id,
      rollup_days: (rollup.data as { days_with_data?: number } | null)?.days_with_data ?? 0,
      recent_rows: recent.data?.length ?? 0,
    },
  }).catch(() => {});

  res.json({
    ok: true,
    rollup_7d: rollup.data ?? null,
    recent_daily: recent.data ?? [],
  });
});

// ==================== POST /waitlist — Phase 0 compat (still works) ====================

router.post('/waitlist', async (req: Request, res: Response) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const tenantId = user.tenant_id ?? (await resolveTenantId(user.user_id));
  if (!tenantId) return res.status(400).json({ ok: false, error: 'Tenant not found' });

  const provider = typeof req.body?.provider === 'string' ? (req.body.provider as string) : null;
  if (!provider) return res.status(400).json({ ok: false, error: 'provider required' });

  const { data, error } = await supabase
    .from('wearable_waitlist')
    .upsert(
      { user_id: user.user_id, tenant_id: tenantId, provider, notify_via: 'email' },
      { onConflict: 'user_id,provider' }
    )
    .select('*')
    .single();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, waitlist_entry: data });
});

export default router;
