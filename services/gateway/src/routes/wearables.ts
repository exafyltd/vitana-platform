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

import { gatewayBaseUrl } from '../env';
import { signOAuthState, verifyOAuthState } from '../lib/oauth-state';
import { Router, Request, Response } from 'express';
import * as jose from 'jose';
import { getSupabase } from '../lib/supabase';
import { getConnector, listConnectors } from '../connectors';
import type { RevokeAccessResult } from '../connectors/types';
import { emitOasisEvent } from '../services/oasis-event-service';
import { isTokenCryptoConfigured, openToken, sealToken } from '../lib/connection-token-crypto';
import * as repo from './wearables-repository';

const router = Router();

/** VTID-05030: the callback redirects carry a fixed code, never an exception message. */
function callbackErrorUrl(connectorId: string, code: string): string {
  return `${process.env.FRONTEND_PUBLIC_URL ?? 'https://vitanaland.com'}/ecosystem?wearable=error&provider=${encodeURIComponent(connectorId)}&reason=${encodeURIComponent(code)}`;
}

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
  const { data, error } = await repo.fetchActivePrimaryTenant(supabase, userId);
  if (error) {
    // Non-fatal by design — the sole caller already treats a null tenant
    // as a 400. Logged so a real DB failure here isn't silently
    // indistinguishable from a user who genuinely has no active tenant.
    console.error(`[wearables] resolveTenantId lookup failed for user=${userId}: ${error.message}`);
  }
  return data?.tenant_id ?? null;
}

// ==================== GET /providers ====================

router.get('/providers', async (req: Request, res: Response) => {
  const user = getUser(req);
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const { data: registry, error: registryErr } = await repo.fetchWearableConnectorRegistry(supabase);
  if (registryErr) return res.status(500).json({ ok: false, error: registryErr.message });

  let userConnections: Array<{ connector_id: string; is_active: boolean; last_sync_at: string | null; display_name: string | null }> = [];
  if (user) {
    const { data: connections, error: connectionsErr } = await repo.fetchUserWearableConnections(supabase, user.user_id);
    if (connectionsErr) {
      // Non-fatal: the provider catalog itself is still valid — degrade to
      // "nothing shows as connected" rather than fail the whole page, but
      // log so a real error isn't silently read as "user has no connections".
      console.error(`[wearables] user connections lookup failed for user=${user.user_id}: ${connectionsErr.message}`);
    }
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
      await repo.upsertPendingWidgetConnection(supabase, {
        tenant_id: tenantId,
        user_id: user.user_id,
        connector_id: connector.id,
        category: connector.category,
        widget_session_id: widget.session_id,
        enrichment_status: 'pending',
        is_active: false, // flipped to true on auth webhook
      });
      return res.json({ ok: true, connector: connector.id, widget_url: widget.url, widget_session_id: widget.session_id });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(502).json({ ok: false, error: message });
    }
  }

  // Generic OAuth2 flow stub for direct-integration connectors (Fitbit, Oura, ...)
  if (connector.auth_type === 'oauth2' && connector.getOAuthUrl) {
    // VTID-04401: signed, expiring state (the callback has no bearer token).
    let stateB64: string;
    try {
      stateB64 = signOAuthState({ u: user.user_id, t: tenantId, c: connector.id });
    } catch {
      return res.status(503).json({ ok: false, error: 'OAUTH_STATE_NOT_CONFIGURED' });
    }
    const redirectUri = `${process.env.GATEWAY_PUBLIC_URL ?? gatewayBaseUrl()}/api/v1/wearables/callback/${connector.id}`;
    const url = connector.getOAuthUrl(stateB64, redirectUri);
    return res.json({ ok: true, connector: connector.id, auth_url: url });
  }

  return res.status(501).json({ ok: false, error: `${connector.display_name} does not expose a connect flow yet` });
});

// ==================== GET /callback/:connector ====================
// OAuth2 redirect target. Provider sends the user back here with `code` + `state`.
// We exchange the code for tokens and persist a user_connections row.

router.get('/callback/:connector', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const connectorId = req.params.connector;
  const connector = getConnector(connectorId);
  if (!connector || !connector.exchangeCode) {
    return res.status(404).json({ ok: false, error: `Unknown connector: ${connectorId}` });
  }

  const code = typeof req.query.code === 'string' ? req.query.code : null;
  const state = typeof req.query.state === 'string' ? req.query.state : null;
  const error_param = typeof req.query.error === 'string' ? req.query.error : null;

  if (error_param) {
    // User denied or provider errored — redirect to frontend with error flag.
    // The provider's `error` param is an OAuth error code (RFC 6749 §4.1.2.1).
    return res.redirect(302, callbackErrorUrl(connectorId, error_param));
  }
  if (!code || !state) {
    return res.status(400).json({ ok: false, error: 'Missing code or state' });
  }

  // VTID-04401: only a signed, unexpired state names the user.
  const stateData = verifyOAuthState<{ u: string; t: string; c: string }>(state);
  if (!stateData || typeof stateData.u !== 'string') {
    return res.status(400).json({ ok: false, error: 'Invalid state' });
  }
  if (stateData.c !== connectorId) {
    return res.status(400).json({ ok: false, error: 'State/connector mismatch' });
  }

  const redirectUri = `${process.env.GATEWAY_PUBLIC_URL ?? gatewayBaseUrl()}/api/v1/wearables/callback/${connectorId}`;

  // VTID-05030 (Health Hub D1): tokens are only ever stored sealed. Without
  // the key, nothing is stored and the member gets a fixed error code.
  if (!isTokenCryptoConfigured()) {
    console.error(`[wearables/callback/${connectorId}] token encryption key not configured — refusing to store tokens`);
    await emitOasisEvent({
      vtid: 'VTID-05030',
      type: 'connector.wearable.token_storage_unavailable',
      source: 'gateway',
      status: 'error',
      message: `Wearable connect refused for ${connectorId}: token encryption not configured`,
      payload: { connector_id: connectorId },
    }).catch(() => {});
    return res.redirect(302, callbackErrorUrl(connectorId, 'storage_unavailable'));
  }

  try {
    const result = await connector.exchangeCode(code, redirectUri);
    const sealedAccess = sealToken(result.tokens.access_token);
    const sealedRefresh = result.tokens.refresh_token ? sealToken(result.tokens.refresh_token) : null;
    if (!sealedAccess || (result.tokens.refresh_token && !sealedRefresh)) {
      return res.redirect(302, callbackErrorUrl(connectorId, 'storage_unavailable'));
    }

    // Persist user_connections row
    await repo.upsertOAuthConnection(supabase, {
      tenant_id: stateData.t,
      user_id: stateData.u,
      connector_id: connector.id,
      category: connector.category,
      provider_user_id: result.provider_user_id ?? null,
      provider_username: result.profile?.provider_username ?? null,
      display_name: result.profile?.display_name ?? null,
      avatar_url: result.profile?.avatar_url ?? null,
      profile_url: result.profile?.profile_url ?? null,
      access_token: sealedAccess,
      refresh_token: sealedRefresh,
      token_expires_at: result.tokens.expires_at ?? null,
      scopes_granted: result.tokens.scopes_granted ?? [],
      capabilities_granted: connector.capabilities,
      profile_data: (result.profile?.raw ?? {}) as object,
      enrichment_status: 'pending',
      is_active: true,
      connected_at: new Date().toISOString(),
    });

    // Redirect user to frontend success page
    const successUrl = `${process.env.FRONTEND_PUBLIC_URL ?? 'https://vitanaland.com'}/ecosystem?wearable=success&provider=${connectorId}`;
    return res.redirect(302, successUrl);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[wearables/callback/${connectorId}]`, message);
    // VTID-05030: never put the exception text in the URL — a fixed code only.
    return res.redirect(302, callbackErrorUrl(connectorId, 'exchange_failed'));
  }
});

// ==================== POST /disconnect/:connector ====================

router.post('/disconnect/:connector', async (req: Request, res: Response) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const connectorId = req.params.connector;

  // VTID-05030 (Health Hub D1): read what the vendor revoke needs, wipe the
  // stored tokens FIRST, then revoke at the vendor (bounded). Local state is
  // safe even if the vendor hangs or fails; a vendor failure never blocks the
  // disconnect.
  const { data: rows } = await repo.fetchConnectionsForDisconnect(supabase, user.user_id, connectorId);
  const { error } = await repo.disconnectUserConnection(supabase, user.user_id, connectorId);
  if (error) return res.status(500).json({ ok: false, error: error.message });

  const connector = getConnector(connectorId);
  const revoke = await revokeAtVendor(connector, (rows ?? []) as DisconnectRow[]);
  await emitOasisEvent({
    vtid: 'VTID-05030',
    type: 'connector.wearable.vendor_revoke',
    source: 'gateway',
    status: revoke.status === 'failed' ? 'warning' : 'info',
    message: `Vendor revoke for ${connectorId}: ${revoke.status}`,
    payload: { user_id: user.user_id, connector_id: connectorId, ...revoke },
  }).catch(() => {});

  res.json({ ok: true, connector: connectorId, vendor_revoke: revoke.status });
});

interface DisconnectRow {
  id: string;
  access_token: string | null;
  refresh_token: string | null;
  provider_user_id: string | null;
  provider_username: string | null;
}

export const VENDOR_REVOKE_TIMEOUT_MS = 5_000;

/**
 * VTID-05030: revoke every connection row for this connector at the vendor,
 * within one total time bound. Terra/Vital widget rows never hold OAuth tokens
 * in user_connections; their identifier is provider_user_id (and, for Vital,
 * the provider slug the auth.completed webhook stores in provider_username).
 */
export async function revokeAtVendor(
  connector: ReturnType<typeof getConnector>,
  rows: DisconnectRow[],
  timeoutMs: number = VENDOR_REVOKE_TIMEOUT_MS,
): Promise<RevokeAccessResult> {
  if (!connector?.revokeAccess) return { status: 'unsupported' };
  if (rows.length === 0) return { status: 'no_token' };
  const revokeAll = async (): Promise<RevokeAccessResult> => {
    let last: RevokeAccessResult = { status: 'no_token' };
    for (const row of rows) {
      const r = await connector.revokeAccess!({
        access_token: openToken(row.access_token),
        refresh_token: openToken(row.refresh_token),
        provider_user_id: row.provider_user_id,
        provider_slug: row.provider_username,
      });
      if (r.status === 'failed') return r;
      if (r.status === 'ok' || last.status === 'no_token') last = r;
    }
    return last;
  };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<RevokeAccessResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'failed', detail: 'timeout' }), timeoutMs);
  });
  try {
    return await Promise.race([revokeAll().catch(() => ({ status: 'failed' as const, detail: 'error' })), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ==================== GET /connections ====================

router.get('/connections', async (req: Request, res: Response) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const { data, error } = await repo.fetchUserWearableConnectionsFull(supabase, user.user_id);
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
    repo.fetchWearableRollup7d(supabase, user.user_id),
    repo.fetchRecentWearableDailyMetrics(supabase, user.user_id, 30),
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

// POST /api/v1/wearables/waitlist is owned by routes/wearables-waitlist.ts
// (mounted separately in index.ts). Kept there to avoid a duplicate-route
// registration that blocks gateway startup.

export default router;
