/**
 * VTID-05149 (multi-tenant M0, lane A): the one place the gateway resolves a
 * user's tenant and describes a tenant.
 *
 * - resolvePrimaryTenant(userId): the user's primary user_tenants row,
 *   deterministic (is_primary desc, created_at, tenant_id, limit 1). A user with
 *   no primary row but other memberships gets the oldest membership
 *   (`membership_fallback`, logged as `tenant_primary_missing`). The result is a
 *   tagged union so "no membership" and "could not look it up" cannot be
 *   confused; callers switch on `status` exhaustively.
 * - getTenantMeta / getDefaultTenantId: tenants.slug / is_default / is_platform
 *   (M1, 20261014000100) from a 60 s in-process cache. Errors are never cached.
 *   Accepted staleness: every ECS task holds its own cache, so a change to
 *   is_default/is_platform reaches all tasks within 60 s. Changing the default
 *   tenant is a rare, migration-driven action, and the signup triggers in the
 *   database never use this cache.
 */

import { getSupabase } from '../../lib/supabase';
import * as repo from './tenant-context-repository';

export type TenantSource = 'token' | 'exafy_admin_token' | 'primary' | 'membership_fallback';

export interface TenantContext {
  tenantId: string;
  slug: string | null;
  role: string | null;
  source: TenantSource;
  isPlatform: boolean;
}

export type PrimaryTenantResult =
  | { status: 'found'; tenantId: string; role: string | null; source: 'primary' | 'membership_fallback' }
  | { status: 'none' } // the user has no membership
  | { status: 'unavailable' }; // lookup error, timeout or abort

export interface TenantMeta {
  slug: string;
  isPlatform: boolean;
  isDefault: boolean;
}

export async function resolvePrimaryTenant(
  userId: string,
  opts?: { signal?: AbortSignal }
): Promise<PrimaryTenantResult> {
  const supabase = getSupabase();
  if (!supabase || !userId) return { status: 'unavailable' };
  try {
    const { data, error } = await repo.fetchPrimaryMembership(supabase, userId, opts?.signal);
    if (error) return { status: 'unavailable' };
    const row = (data as Array<{ tenant_id: string; active_role: string | null; is_primary: boolean }> | null)?.[0];
    if (!row?.tenant_id) return { status: 'none' };
    if (!row.is_primary) {
      console.warn(
        JSON.stringify({ event: 'tenant_primary_missing', vtid: 'VTID-05149', user_id: userId, tenant_id: row.tenant_id })
      );
      return { status: 'found', tenantId: row.tenant_id, role: row.active_role ?? null, source: 'membership_fallback' };
    }
    return { status: 'found', tenantId: row.tenant_id, role: row.active_role ?? null, source: 'primary' };
  } catch {
    return { status: 'unavailable' };
  }
}

const TENANT_META_CACHE_TTL_MS = 60 * 1000;
const TENANT_META_TIMEOUT_MS = 2500;
let tenantMetaCache: { byId: Map<string, TenantMeta>; defaultId: string | null; expiresAt: number } | null = null;

async function loadTenantFlags(): Promise<{ byId: Map<string, TenantMeta>; defaultId: string | null } | null> {
  if (tenantMetaCache && tenantMetaCache.expiresAt > Date.now()) return tenantMetaCache;
  const supabase = getSupabase();
  if (!supabase) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TENANT_META_TIMEOUT_MS);
  try {
    const { data, error } = await repo.fetchTenantFlags(supabase, controller.signal);
    if (error || !Array.isArray(data)) return null;
    const byId = new Map<string, TenantMeta>();
    let defaultId: string | null = null;
    for (const t of data as Array<{ tenant_id: string; slug: string | null; is_default?: boolean; is_platform?: boolean }>) {
      byId.set(t.tenant_id, { slug: t.slug ?? '', isPlatform: t.is_platform === true, isDefault: t.is_default === true });
      if (t.is_default === true) defaultId = t.tenant_id;
    }
    tenantMetaCache = { byId, defaultId, expiresAt: Date.now() + TENANT_META_CACHE_TTL_MS };
    return tenantMetaCache;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Slug and flags of one tenant; null when unknown or the lookup failed. */
export async function getTenantMeta(tenantId: string): Promise<TenantMeta | null> {
  const flags = await loadTenantFlags();
  return flags?.byId.get(tenantId) ?? null;
}

/** The tenant new members land in (tenants.is_default); null when unresolved. */
export async function getDefaultTenantId(): Promise<string | null> {
  const flags = await loadTenantFlags();
  return flags?.defaultId ?? null;
}

/** Drop the tenant metadata cache (tests). */
export function clearTenantMetaCache(): void {
  tenantMetaCache = null;
}
