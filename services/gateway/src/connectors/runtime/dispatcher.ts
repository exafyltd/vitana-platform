/**
 * VTID-01939: Generic connector action dispatcher.
 *
 * Given (userId, connectorId, capability, args):
 *   1. Look up the connector in the registry.
 *   2. Load the user's stored token row (from social_connections today —
 *      pluggable later to user_connections).
 *   3. Refresh the access_token if it's expired, persist the new token.
 *   4. Call connector.performAction.
 *   5. Return the normalized ActionResult plus metadata.
 *
 * This is the single choke-point the capability layer + voice tools call into.
 * Adding a new provider = drop a connector file + register it; dispatcher is
 * already the right shape.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActionRequest, ActionResult, Connector, TokenPair } from '../types';
import { getConnector } from '../index';

export interface DispatchContext {
  supabase: SupabaseClient;
  userId: string;
  tenantId: string;
}

export interface DispatchOptions {
  connectorId: string;
  capability: string;
  args?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface DispatchResult extends ActionResult {
  connector: string;
  capability: string;
  token_refreshed?: boolean;
}

const LOG = '[connector-dispatch]';
const REFRESH_BUFFER_MS = 30_000;

/**
 * Load the user's token row. Uses social_connections for now — every new
 * provider registered via the framework also writes here, so storage is
 * consistent across provider types until we migrate to user_connections.
 */
async function loadConnection(
  supabase: SupabaseClient,
  userId: string,
  connectorId: string,
): Promise<{
  id: string;
  access_token: string;
  refresh_token: string | null;
  token_expires_at: string | null;
  provider_user_id: string | null;
  provider_username: string | null;
} | null> {
  const { data } = await supabase
    .from('social_connections')
    .select('id, access_token, refresh_token, token_expires_at, provider_user_id, provider_username')
    .eq('user_id', userId)
    .eq('provider', connectorId)
    .eq('is_active', true)
    .maybeSingle();
  if (!data || !data.access_token) return null;
  return {
    id: data.id,
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? null,
    token_expires_at: data.token_expires_at ?? null,
    provider_user_id: data.provider_user_id ?? null,
    provider_username: data.provider_username ?? null,
  };
}

async function refreshIfExpired(
  supabase: SupabaseClient,
  connectorId: string,
  connectionId: string,
  connector: Connector,
  stored: { access_token: string; refresh_token: string | null; token_expires_at: string | null },
): Promise<{ tokens: TokenPair; refreshed: boolean }> {
  const expiresAt = stored.token_expires_at ? new Date(stored.token_expires_at).getTime() : 0;
  const stale = expiresAt > 0 && expiresAt < Date.now() + REFRESH_BUFFER_MS;

  if (!stale || !stored.refresh_token || !connector.refreshToken) {
    return {
      tokens: {
        access_token: stored.access_token,
        refresh_token: stored.refresh_token ?? undefined,
        expires_at: stored.token_expires_at ?? undefined,
      },
      refreshed: false,
    };
  }

  try {
    const fresh = await connector.refreshToken(stored.refresh_token);
    await supabase
      .from('social_connections')
      .update({
        access_token: fresh.access_token,
        token_expires_at: fresh.expires_at ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', connectionId);
    console.log(`${LOG} refreshed ${connectorId} token, new expiry ${fresh.expires_at}`);
    return { tokens: fresh, refreshed: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`${LOG} refresh failed for ${connectorId}: ${message}. Falling back to existing token.`);
    return {
      tokens: {
        access_token: stored.access_token,
        refresh_token: stored.refresh_token ?? undefined,
        expires_at: stored.token_expires_at ?? undefined,
      },
      refreshed: false,
    };
  }
}

/**
 * Primary entry point — called by the capability layer and (future) voice
 * tool handlers.
 */
export async function dispatchAction(
  ctx: DispatchContext,
  opts: DispatchOptions,
): Promise<DispatchResult> {
  const connector = getConnector(opts.connectorId);
  if (!connector) {
    return {
      ok: false,
      connector: opts.connectorId,
      capability: opts.capability,
      error: `Unknown connector: ${opts.connectorId}`,
    };
  }

  if (!connector.capabilities.includes(opts.capability)) {
    return {
      ok: false,
      connector: opts.connectorId,
      capability: opts.capability,
      error: `Connector ${opts.connectorId} does not declare capability ${opts.capability}`,
    };
  }

  if (!connector.performAction) {
    return {
      ok: false,
      connector: opts.connectorId,
      capability: opts.capability,
      error: `Connector ${opts.connectorId} has no performAction implementation`,
    };
  }

  // VTID-01942: auth_type 'none' connectors (Vitana Media Hub) are always
  // available — skip the token lookup and pass an empty TokenPair.
  let tokens: TokenPair;
  let refreshed = false;
  let storedId: string | undefined;
  let providerUserId: string | undefined;
  let providerUsername: string | undefined;

  if (connector.auth_type === 'none') {
    tokens = { access_token: '' };
  } else {
    const stored = await loadConnection(ctx.supabase, ctx.userId, opts.connectorId);
    if (!stored) {
      return {
        ok: false,
        connector: opts.connectorId,
        capability: opts.capability,
        error: `User has no active ${opts.connectorId} connection`,
      };
    }
    const refreshResult = await refreshIfExpired(
      ctx.supabase, opts.connectorId, stored.id, connector, stored,
    );
    tokens = refreshResult.tokens;
    refreshed = refreshResult.refreshed;
    storedId = stored.id;
    providerUserId = stored.provider_user_id ?? undefined;
    providerUsername = stored.provider_username ?? undefined;
  }

  const request: ActionRequest = {
    capability: opts.capability,
    args: opts.args ?? {},
    idempotency_key: opts.idempotencyKey,
  };

  try {
    const result = await connector.performAction(
      {
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        user_connection_id: storedId,
        provider_user_id: providerUserId,
        provider_username: providerUsername,
      },
      tokens,
      request,
    );
    return {
      ...result,
      connector: opts.connectorId,
      capability: opts.capability,
      token_refreshed: refreshed,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${LOG} performAction threw for ${opts.connectorId}.${opts.capability}: ${message}`);
    return {
      ok: false,
      connector: opts.connectorId,
      capability: opts.capability,
      error: message,
      token_refreshed: refreshed,
    };
  }
}
