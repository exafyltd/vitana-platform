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

    // Get all tenants
    let dbQuery = supabase
      .from('tenants')
      .select('id, name, slug, created_at, updated_at')
      .order('name', { ascending: true });

    if (query) {
      dbQuery = dbQuery.ilike('name', `%${query}%`);
    }

    const { data: tenants, error: tenantsError } = await dbQuery;

    if (tenantsError) {
      console.error(`[${VTID}] Tenants query error:`, tenantsError.message);
      return res.status(500).json({ ok: false, error: tenantsError.message });
    }

    // Get user counts per tenant
    const { data: memberships, error: membError } = await supabase
      .from('user_tenants')
      .select('tenant_id');

    if (membError) {
      console.error(`[${VTID}] Memberships query error:`, membError.message);
      return res.status(500).json({ ok: false, error: membError.message });
    }

    // Count per tenant
    const counts: Record<string, number> = {};
    (memberships || []).forEach((m: any) => {
      counts[m.tenant_id] = (counts[m.tenant_id] || 0) + 1;
    });

    const result = (tenants || []).map((t: any) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      user_count: counts[t.id] || 0,
      status: (counts[t.id] || 0) > 0 ? 'Active' : 'Empty',
      created_at: t.created_at,
      updated_at: t.updated_at,
    }));

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

    // Get tenant info
    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .select('id, name, slug, created_at, updated_at')
      .eq('id', id)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ ok: false, error: 'TENANT_NOT_FOUND' });
    }

    // Get members of this tenant
    const { data: members, error: membersError } = await supabase
      .from('user_tenants')
      .select(`
        user_id,
        active_role,
        is_primary,
        app_users (
          email,
          display_name
        )
      `)
      .eq('tenant_id', id);

    if (membersError) {
      console.error(`[${VTID}] Members query error:`, membersError.message);
      return res.status(500).json({ ok: false, error: membersError.message });
    }

    const result = {
      id: (tenant as any).id,
      name: (tenant as any).name,
      slug: (tenant as any).slug,
      user_count: (members || []).length,
      status: (members || []).length > 0 ? 'Active' : 'Empty',
      created_at: (tenant as any).created_at,
      updated_at: (tenant as any).updated_at,
      members: (members || []).map((m: any) => ({
        user_id: m.user_id,
        email: m.app_users?.email || null,
        display_name: m.app_users?.display_name || null,
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
