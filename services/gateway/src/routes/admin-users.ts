/**
 * Admin Users API — User Management & Role Distribution
 *
 * Endpoints:
 * - GET  /               — List users with tenant/role info (search, pagination)
 * - GET  /roles-summary  — Role distribution counts
 * - GET  /:userId        — Single user detail with all memberships
 *
 * Security (Batch 1.B1 — dual-mode):
 * - exafy_admin: full cross-tenant access (sees all users, all memberships)
 * - tenant admin (active_role = 'admin'): scoped to their own tenant only
 */

import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import { createUserSupabaseClient } from '../lib/supabase-user';

const router = Router();
const VTID = 'ADMIN-USERS';

// ── Auth Helper (Batch 1.B1: dual-mode — exafy_admin OR tenant admin) ───

function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

interface AdminAuthResult {
  ok: true;
  user_id: string;
  email: string;
  is_exafy_admin: boolean;
  /** Non-null for tenant admins — queries must be scoped to this tenant. Null for exafy_admin (full access). */
  scoped_tenant_id: string | null;
}

interface AdminAuthError {
  ok: false;
  status: number;
  error: string;
}

async function verifyAdminAccess(
  req: Request
): Promise<AdminAuthResult | AdminAuthError> {
  const token = getBearerToken(req);
  if (!token) return { ok: false, status: 401, error: 'UNAUTHENTICATED' };

  try {
    const userClient = createUserSupabaseClient(token);
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData?.user) return { ok: false, status: 401, error: 'INVALID_TOKEN' };

    const appMetadata = authData.user.app_metadata || {};
    const isExafyAdmin = appMetadata.exafy_admin === true;

    if (isExafyAdmin) {
      return {
        ok: true,
        user_id: authData.user.id,
        email: authData.user.email || 'unknown',
        is_exafy_admin: true,
        scoped_tenant_id: null, // full access
      };
    }

    // Not exafy_admin — check if caller is a tenant admin via user_tenants
    const tenantId = appMetadata.active_tenant_id as string | undefined;
    if (!tenantId) {
      return { ok: false, status: 403, error: 'FORBIDDEN' };
    }

    const supabase = getSupabase();
    if (!supabase) return { ok: false, status: 503, error: 'DB_UNAVAILABLE' };

    const { data: membership } = await supabase
      .from('user_tenants')
      .select('active_role')
      .eq('user_id', authData.user.id)
      .eq('tenant_id', tenantId)
      .single();

    if (!membership || membership.active_role !== 'admin') {
      return { ok: false, status: 403, error: 'FORBIDDEN' };
    }

    return {
      ok: true,
      user_id: authData.user.id,
      email: authData.user.email || 'unknown',
      is_exafy_admin: false,
      scoped_tenant_id: tenantId, // scoped to this tenant only
    };
  } catch (err: any) {
    console.error(`[${VTID}] Auth error:`, err.message);
    return { ok: false, status: 500, error: 'INTERNAL_ERROR' };
  }
}

// ── Helper: build tenant lookup map ─────────────────────────

async function getTenantMap(supabase: any): Promise<Record<string, { name: string; slug: string }>> {
  const { data: tenants } = await supabase.from('tenants').select('*');
  const map: Record<string, { name: string; slug: string }> = {};
  (tenants || []).forEach((t: any) => {
    // Use whatever PK the table has — check for 'id' or 'tenant_id'
    const key = t.id || t.tenant_id;
    if (key) map[key] = { name: t.name || t.slug || 'Unknown', slug: t.slug || '' };
  });
  return map;
}

// ── GET / — List users with tenant/role info ────────────────

router.get('/', async (req: Request, res: Response) => {
  const auth = await verifyAdminAccess(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const query = (req.query.query as string || '').trim();
    const role = (req.query.role as string || '').trim();
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;

    // Batch 1.B1: tenant admins only see users in their own tenant.
    // For tenant-scoped requests, first get user_ids from user_tenants,
    // then filter app_users to that set.
    let scopedUserIds: string[] | null = null;
    if (auth.scoped_tenant_id) {
      const { data: tenantMembers } = await supabase
        .from('user_tenants')
        .select('user_id')
        .eq('tenant_id', auth.scoped_tenant_id);
      scopedUserIds = (tenantMembers || []).map((m: any) => m.user_id);
      if (scopedUserIds.length === 0) {
        return res.json({ ok: true, users: [] });
      }
    }

    // 1. Get users (flat query, no nested relations)
    let usersQuery = supabase
      .from('app_users')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (query) {
      usersQuery = usersQuery.ilike('email', `%${query}%`);
    }

    if (scopedUserIds) {
      usersQuery = usersQuery.in('user_id', scopedUserIds);
    }

    // 2. Get memberships (scoped if tenant admin) and tenants in parallel
    let membershipsQuery = supabase.from('user_tenants').select('*');
    if (auth.scoped_tenant_id) {
      membershipsQuery = membershipsQuery.eq('tenant_id', auth.scoped_tenant_id);
    }

    const [usersResult, membershipsResult, tenantMap] = await Promise.all([
      usersQuery,
      membershipsQuery,
      getTenantMap(supabase),
    ]);

    if (usersResult.error) {
      console.error(`[${VTID}] Users query error:`, usersResult.error.message);
      return res.status(500).json({ ok: false, error: usersResult.error.message });
    }

    // Build membership lookup by user_id
    const membershipsByUser: Record<string, any[]> = {};
    (membershipsResult.data || []).forEach((m: any) => {
      if (!membershipsByUser[m.user_id]) membershipsByUser[m.user_id] = [];
      membershipsByUser[m.user_id].push(m);
    });

    // 3. Flatten: each user gets their primary membership info at top level
    const flatUsers = (usersResult.data || []).map((u: any) => {
      const memberships = membershipsByUser[u.user_id] || [];
      const primary = memberships.find((m: any) => m.is_primary) || memberships[0] || null;
      const tenantInfo = primary ? tenantMap[primary.tenant_id] : null;

      return {
        user_id: u.user_id,
        email: u.email,
        display_name: u.display_name,
        avatar_url: u.avatar_url,
        active_role: primary?.active_role || null,
        tenant_name: tenantInfo?.name || null,
        tenant_id: primary?.tenant_id || null,
        is_primary: primary?.is_primary || false,
        status: memberships.length > 0 ? 'Active' : 'Inactive',
        created_at: u.created_at,
        updated_at: u.updated_at,
        memberships: memberships.map((m: any) => ({
          tenant_id: m.tenant_id,
          tenant_name: tenantMap[m.tenant_id]?.name || null,
          tenant_slug: tenantMap[m.tenant_id]?.slug || null,
          active_role: m.active_role,
          is_primary: m.is_primary,
        })),
      };
    });

    // Filter by role if requested
    const filtered = role
      ? flatUsers.filter((u: any) => u.memberships.some((m: any) => m.active_role === role))
      : flatUsers;

    console.log(`[${VTID}] Listed ${filtered.length} users (query=${query}, role=${role}, scoped=${auth.scoped_tenant_id || 'all'})`);
    return res.json({ ok: true, users: filtered });
  } catch (err: any) {
    console.error(`[${VTID}] Error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── GET /roles-summary — Role distribution counts ───────────

router.get('/roles-summary', async (req: Request, res: Response) => {
  const auth = await verifyAdminAccess(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    let membershipsQuery = supabase.from('user_tenants').select('active_role');
    if (auth.scoped_tenant_id) {
      membershipsQuery = membershipsQuery.eq('tenant_id', auth.scoped_tenant_id);
    }
    const { data: memberships, error } = await membershipsQuery;

    if (error) {
      console.error(`[${VTID}] Roles summary error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    const counts: Record<string, number> = {};
    (memberships || []).forEach((m: any) => {
      const role = m.active_role || 'unknown';
      counts[role] = (counts[role] || 0) + 1;
    });

    const ALL_ROLES = ['community', 'patient', 'professional', 'staff', 'admin', 'developer', 'infra'];
    const roles = ALL_ROLES.map(role => ({
      role,
      user_count: counts[role] || 0,
    }));

    console.log(`[${VTID}] Roles summary:`, roles);
    return res.json({ ok: true, roles });
  } catch (err: any) {
    console.error(`[${VTID}] Error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── GET /:userId — Single user detail ───────────────────────

router.get('/:userId', async (req: Request, res: Response) => {
  const auth = await verifyAdminAccess(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const { userId } = req.params;

    // Batch 1.B1: tenant admins can only view users who belong to their tenant
    if (auth.scoped_tenant_id) {
      const { data: memberCheck } = await supabase
        .from('user_tenants')
        .select('user_id')
        .eq('user_id', userId)
        .eq('tenant_id', auth.scoped_tenant_id)
        .single();
      if (!memberCheck) {
        return res.status(404).json({ ok: false, error: 'USER_NOT_FOUND' });
      }
    }

    // Flat queries — no nested PostgREST relations
    let membershipsQuery = supabase.from('user_tenants').select('*').eq('user_id', userId);
    if (auth.scoped_tenant_id) {
      membershipsQuery = membershipsQuery.eq('tenant_id', auth.scoped_tenant_id);
    }

    const [userResult, membershipsResult, tenantMap] = await Promise.all([
      supabase.from('app_users').select('*').eq('user_id', userId).single(),
      membershipsQuery,
      getTenantMap(supabase),
    ]);

    if (userResult.error || !userResult.data) {
      return res.status(404).json({ ok: false, error: 'USER_NOT_FOUND' });
    }

    const u = userResult.data as any;
    const memberships = (membershipsResult.data || []) as any[];
    const primary = memberships.find((m: any) => m.is_primary) || memberships[0] || null;
    const tenantInfo = primary ? tenantMap[primary.tenant_id] : null;

    const result = {
      user_id: u.user_id,
      email: u.email,
      display_name: u.display_name,
      avatar_url: u.avatar_url,
      bio: u.bio,
      active_role: primary?.active_role || null,
      tenant_name: tenantInfo?.name || null,
      tenant_id: primary?.tenant_id || null,
      status: memberships.length > 0 ? 'Active' : 'Inactive',
      created_at: u.created_at,
      updated_at: u.updated_at,
      memberships: memberships.map((m: any) => ({
        tenant_id: m.tenant_id,
        tenant_name: tenantMap[m.tenant_id]?.name || null,
        tenant_slug: tenantMap[m.tenant_id]?.slug || null,
        active_role: m.active_role,
        is_primary: m.is_primary,
      })),
    };

    return res.json({ ok: true, user: result });
  } catch (err: any) {
    console.error(`[${VTID}] Error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

export default router;
