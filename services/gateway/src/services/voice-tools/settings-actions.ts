/**
 * VTID-02772 — Voice Tool Expansion P1j: Settings / Account / Integrations.
 *
 * Backs voice tools that let the user manage profile preferences and
 * connected app integrations. Wraps the existing user-preferences and
 * integrations RPCs/routes.
 */

import { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// 1. set_preference — wrap preference_set RPC
// ---------------------------------------------------------------------------

export async function setPreference(
  sb: SupabaseClient,
  args: {
    category: string;
    key: string;
    value: string;
    priority?: number;
    scope?: 'global' | 'domain';
    scope_domain?: string;
  },
): Promise<{ ok: true; action: string } | { ok: false; error: string }> {
  if (!args.category || !args.key || args.value === undefined) {
    return { ok: false, error: 'category_key_value_required' };
  }
  const { data, error } = await sb.rpc('preference_set', {
    p_category: args.category,
    p_key: args.key,
    p_value: args.value,
    p_priority: args.priority ?? 100,
    p_scope: args.scope ?? 'global',
    p_scope_domain: args.scope_domain ?? null,
  });
  if (error) {
    if (error.message.includes('function') && error.message.includes('does not exist')) {
      return { ok: false, error: 'preference_rpc_unavailable' };
    }
    return { ok: false, error: `preference_set_failed: ${error.message}` };
  }
  if (!data || (data as any).ok === false) {
    return { ok: false, error: String((data as any)?.error ?? 'preference_set_returned_error') };
  }
  return { ok: true, action: String((data as any).action ?? 'set') };
}

// ---------------------------------------------------------------------------
// 2. get_my_preferences — wrap preference_get_bundle RPC
// ---------------------------------------------------------------------------

export async function getMyPreferences(
  sb: SupabaseClient,
  args: { category?: string },
): Promise<{ ok: true; preferences: any[]; count: number } | { ok: false; error: string }> {
  const { data, error } = await sb.rpc('preference_get_bundle', {
    p_category: args.category ?? null,
  });
  if (error) {
    if (error.message.includes('function') && error.message.includes('does not exist')) {
      return { ok: false, error: 'preference_bundle_rpc_unavailable' };
    }
    return { ok: false, error: `bundle_query_failed: ${error.message}` };
  }
  const list = Array.isArray(data) ? data : (data as any)?.preferences ?? [];
  return { ok: true, preferences: list, count: list.length };
}

// ---------------------------------------------------------------------------
// 3. list_connected_apps — query user_integrations directly
// ---------------------------------------------------------------------------

export async function listConnectedApps(
  sb: SupabaseClient,
  userId: string,
): Promise<
  | { ok: true; integrations: Array<{ integration_id: string; status: string; connected_at?: string | null }>; count: number }
  | { ok: false; error: string }
> {
  const { data, error } = await sb
    .from('user_integrations')
    .select('integration_id, status, connected_at, last_sync_at, last_error')
    .eq('user_id', userId)
    .order('integration_id', { ascending: true });
  if (error) return { ok: false, error: `integrations_query_failed: ${error.message}` };
  return {
    ok: true,
    integrations: (data || []) as any[],
    count: (data || []).length,
  };
}

// ---------------------------------------------------------------------------
// 4. connect_app — mark integration as connected (returns OAuth URL when applicable)
// ---------------------------------------------------------------------------

export async function connectApp(
  sb: SupabaseClient,
  userId: string,
  args: { integration_id: string },
): Promise<{ ok: true; integration_id: string; status: string; oauth_url?: string } | { ok: false; error: string }> {
  if (!args.integration_id) return { ok: false, error: 'integration_id_required' };
  // For most integrations, voice can't complete OAuth — it can only mark
  // a record-of-intent. The actual handshake happens in the connected-apps
  // UI. We upsert a "pending" row and return it so the frontend can offer
  // a deep link to the connect modal.
  const { error } = await sb.from('user_integrations').upsert(
    {
      user_id: userId,
      integration_id: args.integration_id,
      status: 'pending',
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,integration_id' },
  );
  if (error) return { ok: false, error: `connect_failed: ${error.message}` };
  return {
    ok: true,
    integration_id: args.integration_id,
    status: 'pending',
    oauth_url: `/settings/connected-apps?provider=${encodeURIComponent(args.integration_id)}`,
  };
}

// ---------------------------------------------------------------------------
// 5. disconnect_app — mark integration as disconnected
// ---------------------------------------------------------------------------

export async function disconnectApp(
  sb: SupabaseClient,
  userId: string,
  args: { integration_id: string },
): Promise<{ ok: true; integration_id: string } | { ok: false; error: string }> {
  if (!args.integration_id) return { ok: false, error: 'integration_id_required' };
  const { error } = await sb
    .from('user_integrations')
    .update({
      status: 'disconnected',
      disconnected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .eq('integration_id', args.integration_id);
  if (error) return { ok: false, error: `disconnect_failed: ${error.message}` };
  return { ok: true, integration_id: args.integration_id };
}
