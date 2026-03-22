/**
 * Admin Tenants API — Tenant Management
 *
 * Endpoints:
 * - GET  /       — List tenants with user counts
 * - GET  /:id    — Single tenant detail with member list
 *
 * Security:
 * - All endpoints require Bearer token + exafy_admin
 */

import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import { createUserSupabaseClient } from '../lib/supabase-user';

const router = Router();
const VTID = 'ADMIN-TENANTS';

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

// ── GET / — List tenants with user counts ───────────────────

router.get('/', async (req: Request, res: Response) => {
  const auth = await verifyExafyAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const query = (req.query.query as string || '').trim();

    // Flat queries — no nested PostgREST relations
    let tenantsQuery = supabase
      .from('tenants')
      .select('*')
      .order('name', { ascending: true });

    if (query) {
      tenantsQuery = tenantsQuery.ilike('name', `%${query}%`);
    }

    const [tenantsResult, membershipsResult] = await Promise.all([
      tenantsQuery,
      supabase.from('user_tenants').select('tenant_id'),
    ]);

    if (tenantsResult.error) {
      console.error(`[${VTID}] Tenants query error:`, tenantsResult.error.message);
      return res.status(500).json({ ok: false, error: tenantsResult.error.message });
    }

    // Count per tenant
    const counts: Record<string, number> = {};
    (membershipsResult.data || []).forEach((m: any) => {
      counts[m.tenant_id] = (counts[m.tenant_id] || 0) + 1;
    });

    const result = (tenantsResult.data || []).map((t: any) => {
      // Use whatever PK the table has
      const tenantId = t.id || t.tenant_id;
      const userCount = counts[tenantId] || 0;
      return {
        id: tenantId,
        name: t.name,
        slug: t.slug,
        user_count: userCount,
        status: userCount > 0 ? 'Active' : 'Empty',
        created_at: t.created_at,
        updated_at: t.updated_at,
      };
    });

    console.log(`[${VTID}] Listed ${result.length} tenants`);
    return res.json({ ok: true, tenants: result });
  } catch (err: any) {
    console.error(`[${VTID}] Error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── GET /:id — Single tenant detail with members ────────────

router.get('/:id', async (req: Request, res: Response) => {
  const auth = await verifyExafyAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const { id } = req.params;

    // Try to find tenant by id (could be 'id' or 'tenant_id' column)
    let tenantResult = await supabase.from('tenants').select('*').eq('id', id).single();

    // If that fails, try slug as fallback
    if (tenantResult.error) {
      tenantResult = await supabase.from('tenants').select('*').eq('slug', id).single();
    }

    if (tenantResult.error || !tenantResult.data) {
      return res.status(404).json({ ok: false, error: 'TENANT_NOT_FOUND' });
    }

    const tenant = tenantResult.data as any;
    const tenantId = tenant.id || tenant.tenant_id;

    // Get members — flat query, then lookup user emails separately
    const { data: memberships } = await supabase
      .from('user_tenants')
      .select('*')
      .eq('tenant_id', tenantId);

    // Get user details for members
    const userIds = (memberships || []).map((m: any) => m.user_id);
    let usersMap: Record<string, any> = {};
    if (userIds.length > 0) {
      const { data: users } = await supabase
        .from('app_users')
        .select('user_id, email, display_name')
        .in('user_id', userIds);
      (users || []).forEach((u: any) => {
        usersMap[u.user_id] = u;
      });
    }

    const result = {
      id: tenantId,
      name: tenant.name,
      slug: tenant.slug,
      user_count: (memberships || []).length,
      status: (memberships || []).length > 0 ? 'Active' : 'Empty',
      created_at: tenant.created_at,
      updated_at: tenant.updated_at,
      members: (memberships || []).map((m: any) => ({
        user_id: m.user_id,
        email: usersMap[m.user_id]?.email || null,
        display_name: usersMap[m.user_id]?.display_name || null,
        active_role: m.active_role,
        is_primary: m.is_primary,
      })),
    };

    return res.json({ ok: true, tenant: result });
  } catch (err: any) {
    console.error(`[${VTID}] Error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

export default router;
