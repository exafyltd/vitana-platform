/**
 * Admin Users API — User Management & Role Distribution
 *
 * Endpoints:
 * - GET  /               — List users with tenant/role info (search, pagination)
 * - GET  /roles-summary  — Role distribution counts
 * - GET  /:userId        — Single user detail with all memberships
 *
 * Security:
 * - All endpoints require Bearer token + exafy_admin
 */

import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import { createUserSupabaseClient } from '../lib/supabase-user';

const router = Router();
const VTID = 'ADMIN-USERS';

// ── Auth Helper ─────────────────────────────────────────────

function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

async function verifyExafyAdmin(
  req: Request
): Promise<{ ok: true; user_id: string; email: string } | { ok: false; status: number; error: string }> {
  const token = getBearerToken(req);
  if (!token) return { ok: false, status: 401, error: 'UNAUTHENTICATED' };

  try {
    const userClient = createUserSupabaseClient(token);
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData?.user) return { ok: false, status: 401, error: 'INVALID_TOKEN' };

    const appMetadata = authData.user.app_metadata || {};
    if (appMetadata.exafy_admin !== true) {
      return { ok: false, status: 403, error: 'FORBIDDEN' };
    }

    return { ok: true, user_id: authData.user.id, email: authData.user.email || 'unknown' };
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
  const auth = await verifyExafyAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const query = (req.query.query as string || '').trim();
    const role = (req.query.role as string || '').trim();
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;

    // 1. Get users (flat query, no nested relations)
    let usersQuery = supabase
      .from('app_users')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (query) {
      usersQuery = usersQuery.ilike('email', `%${query}%`);
    }

    // 2. Get all memberships and tenants in parallel
    const [usersResult, membershipsResult, tenantMap] = await Promise.all([
      usersQuery,
      supabase.from('user_tenants').select('*'),
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

    console.log(`[${VTID}] Listed ${filtered.length} users (query=${query}, role=${role})`);
    return res.json({ ok: true, users: filtered });
  } catch (err: any) {
    console.error(`[${VTID}] Error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── GET /roles-summary — Role distribution counts ───────────

router.get('/roles-summary', async (req: Request, res: Response) => {
  const auth = await verifyExafyAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const { data: memberships, error } = await supabase
      .from('user_tenants')
      .select('active_role');

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
  const auth = await verifyExafyAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const { userId } = req.params;

    // Flat queries — no nested PostgREST relations
    const [userResult, membershipsResult, tenantMap] = await Promise.all([
      supabase.from('app_users').select('*').eq('user_id', userId).single(),
      supabase.from('user_tenants').select('*').eq('user_id', userId),
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
