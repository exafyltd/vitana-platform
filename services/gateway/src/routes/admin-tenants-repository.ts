// impact-allow-no-test: pure data-access seam (thin Supabase query wrappers,
// no independent request-handling behavior); exercised indirectly by
// routes/admin-tenants.ts's existing test suite (test/routes/admin-tenants.test.ts),
// which covers every call site here.
/**
 * routes/admin-tenants.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/admin-tenants.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== tenants ====================

export async function fetchTenantsList(sb: SupabaseClient, query?: string) {
  let q = sb.from('tenants').select('*').order('name', { ascending: true });
  if (query) q = q.ilike('name', `%${query}%`);
  return q;
}

export async function fetchTenantById(sb: SupabaseClient, id: string) {
  return sb.from('tenants').select('*').eq('tenant_id', id).single();
}

export async function fetchTenantBySlug(sb: SupabaseClient, slug: string) {
  return sb.from('tenants').select('*').eq('slug', slug).single();
}

// ==================== user_tenants ====================

export async function fetchAllTenantMemberships(sb: SupabaseClient) {
  return sb.from('user_tenants').select('tenant_id');
}

export async function fetchTenantMemberships(sb: SupabaseClient, tenantId: string) {
  return sb.from('user_tenants').select('*').eq('tenant_id', tenantId);
}

// ==================== app_users ====================

export async function fetchAppUsersByIds(sb: SupabaseClient, userIds: string[]) {
  return sb.from('app_users').select('user_id, email, display_name').in('user_id', userIds);
}

// ==================== VTID-05150: tenant provisioning ====================
// New functions only; the read functions above are unchanged. Every call runs
// with the service-role client the route passes in (exafy_admin-gated routes).

export const TENANT_ASSETS_BUCKET = 'tenant-assets';
/** The Vitana bot (Alle Beisammen pattern); provision_tenant() adds it to the system group. */
export const VITANA_BOT_USER_ID = '00000000-0000-0000-0000-000000000001';

export async function rpcProvisionTenant(sb: SupabaseClient, args: Record<string, unknown>) {
  return sb.rpc('provision_tenant', args);
}

export async function fetchTenantSettingsRow(sb: SupabaseClient, tenantId: string) {
  return sb.from('tenant_settings').select('*').eq('tenant_id', tenantId).maybeSingle();
}

export async function updateTenantSettingsPack(sb: SupabaseClient, tenantId: string, updates: Record<string, unknown>) {
  return sb.from('tenant_settings').update(updates).eq('tenant_id', tenantId).select('*').single();
}

export async function updateTenantOpenSignup(sb: SupabaseClient, tenantId: string, openSignup: boolean) {
  return sb
    .from('tenants')
    .update({ open_signup: openSignup, updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .select('tenant_id, open_signup')
    .single();
}

/** Every tenant row (select * so the call works before and after Lane A adds is_platform). */
export async function fetchAllTenantsRows(sb: SupabaseClient) {
  return sb.from('tenants').select('*');
}

export async function fetchNotificationControls(sb: SupabaseClient, tenantIds: string[]) {
  return sb.from('notification_type_controls').select('tenant_id, type, source_key').in('tenant_id', tenantIds);
}

export async function fetchPolicyProviders(sb: SupabaseClient, tenantIds: string[]) {
  return sb.from('ai_provider_policies').select('tenant_id, provider').in('tenant_id', tenantIds);
}

export async function countAutopilotSettings(sb: SupabaseClient, tenantId: string) {
  return sb.from('tenant_autopilot_settings').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId);
}

export async function fetchSystemGroupIds(sb: SupabaseClient, tenantId: string) {
  return sb.from('chat_groups').select('id').eq('tenant_id', tenantId).eq('is_system', true);
}

export async function fetchBotMemberships(sb: SupabaseClient, groupIds: string[]) {
  return sb
    .from('chat_group_members')
    .select('group_id')
    .in('group_id', groupIds)
    .eq('user_id', VITANA_BOT_USER_ID)
    .eq('role', 'bot');
}

/** An accepted invitation carrying the admin role (id only — never the email). */
export async function fetchAcceptedAdminInvitation(sb: SupabaseClient, tenantId: string) {
  return sb
    .from('tenant_invitations')
    .select('id')
    .eq('tenant_id', tenantId)
    .not('accepted_at', 'is', null)
    .contains('roles', ['admin'])
    .limit(1);
}

export async function fetchAdminMembership(sb: SupabaseClient, tenantId: string) {
  return sb.from('user_tenants').select('user_id').eq('tenant_id', tenantId).eq('active_role', 'admin').limit(1);
}

// ---- Storage (service role, REST — same pattern as services/operator-media.ts) ----

function storageEnv(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  return url && key ? { url: url.replace(/\/+$/, ''), key } : null;
}

const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

/** Object names directly under tenant-assets/<slug>/; null when storage is unavailable. */
export async function listTenantAssetObjects(slug: string): Promise<string[] | null> {
  const s = storageEnv();
  if (!s) return null;
  try {
    const r = await fetch(`${s.url}/storage/v1/object/list/${TENANT_ASSETS_BUCKET}`, {
      method: 'POST',
      headers: { apikey: s.key, Authorization: `Bearer ${s.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: `${slug}/`, limit: 100, offset: 0 }),
    });
    if (!r.ok) return null;
    const rows = (await r.json()) as Array<{ name?: string }>;
    return Array.isArray(rows) ? rows.map((o) => String(o.name ?? '')).filter(Boolean) : null;
  } catch {
    return null;
  }
}

/** Upsert one object at tenant-assets/<objectPath>. */
export async function uploadTenantAssetObject(objectPath: string, bytes: Buffer, contentType: string): Promise<{ ok: boolean; status: number }> {
  const s = storageEnv();
  if (!s) return { ok: false, status: 503 };
  try {
    const up = await fetch(`${s.url}/storage/v1/object/${TENANT_ASSETS_BUCKET}/${encPath(objectPath)}`, {
      method: 'POST',
      headers: {
        apikey: s.key,
        Authorization: `Bearer ${s.key}`,
        'Content-Type': contentType,
        'x-upsert': 'true',
        'Cache-Control': 'public, max-age=300',
      },
      body: bytes,
    });
    return { ok: up.ok, status: up.status };
  } catch {
    return { ok: false, status: 503 };
  }
}
