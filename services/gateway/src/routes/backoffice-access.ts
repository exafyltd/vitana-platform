/**
 * VTID-03834: BackOffice ERP capability access
 *
 * Mounted at /api/v1/backoffice. Endpoints:
 * - GET  /me                 - caller's effective ERP capabilities (role defaults ∪ explicit grants)
 * - GET  /access             - every explicit grant in the caller's tenant, grouped per user
 * - GET  /access/:userId     - explicit grants for one user in the tenant
 * - POST /access/grant       - grant a capability  { user_id, capability, tenant_id? }
 * - POST /access/revoke      - revoke a capability { user_id, capability, tenant_id? }
 *
 * Security (mirrors routes/role-admin.ts, VTID-01230):
 * - every endpoint needs a valid Bearer token; identity + tenant come from lib/tenant-role-auth
 * - /me: any authenticated user
 * - /access*: Exafy super-admin OR a caller whose effective access holds `erp.admin`
 *   (tenant admins by default); the target user must be in the caller's tenant
 * - hr.* / payroll.* (personal data) can only be granted by an Exafy admin or a tenant `admin`
 * - rows are written with the service role through PostgREST; the browser never writes the table
 *
 * The frontend hides what it cannot use; THIS layer enforces. `requireErpCapability()` is the
 * middleware later BackOffice routes (commands, reads) attach.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { verifyAuth, canManageRoles } from '../lib/tenant-role-auth';
import { ERP_CAPABILITIES, type ErpCapability } from '../constants/erp-capabilities';
import { effectiveCapabilities, canManageErpAccess, validateGrant, hasCapability, type EffectiveAccess } from '../services/backoffice/erp-access';

const router = Router();
const VTID = 'VTID-03834';
const TABLE = 'erp_capability_grants';

interface GrantRow { user_id: string; tenant_id: string; capability: string; granted_by: string | null; granted_at: string }

function serviceCreds(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  return url && key ? { url, key } : null;
}

async function fetchGrants(tenantId: string, userId?: string): Promise<GrantRow[]> {
  const creds = serviceCreds();
  if (!creds) throw new Error('SERVICE_CONFIG');
  let url = `${creds.url}/rest/v1/${TABLE}?tenant_id=eq.${encodeURIComponent(tenantId)}&select=user_id,tenant_id,capability,granted_by,granted_at&order=capability.asc`;
  if (userId) url += `&user_id=eq.${encodeURIComponent(userId)}`;
  const response = await fetch(url, { headers: { apikey: creds.key, Authorization: `Bearer ${creds.key}` } });
  if (!response.ok) throw new Error(`GRANTS_FETCH_${response.status}`);
  return (await response.json()) as GrantRow[];
}

/** Resolve the caller's effective access (role defaults ∪ explicit grants in their tenant). */
async function resolveAccess(auth: { user_id: string; is_exafy_admin: boolean; tenant_id: string | null; active_role: string | null }): Promise<EffectiveAccess> {
  let explicit: string[] = [];
  if (auth.tenant_id) {
    try {
      explicit = (await fetchGrants(auth.tenant_id, auth.user_id)).map((r) => r.capability);
    } catch (err: any) {
      console.error(`[${VTID}] explicit grants fetch failed:`, err.message);
      // fail closed on explicit grants, but role defaults still apply
    }
  }
  return effectiveCapabilities(auth.active_role, auth.is_exafy_admin, explicit);
}

/**
 * Middleware factory for later BackOffice routes: 401 without identity, 403 without the
 * capability, otherwise `req.erpAccess` carries the resolved access.
 */
export function requireErpCapability(capability: ErpCapability) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const auth = await verifyAuth(req);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
    const access = await resolveAccess(auth);
    if (!hasCapability(access, capability)) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', message: `Requires ERP capability '${capability}'`, required: capability });
    }
    (req as any).erpAccess = { ...access, user_id: auth.user_id, tenant_id: auth.tenant_id };
    return next();
  };
}

// GET /me ------------------------------------------------------------------------
router.get('/me', async (req: Request, res: Response) => {
  const auth = await verifyAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  try {
    const access = await resolveAccess(auth);
    return res.status(200).json({
      ok: true,
      user_id: auth.user_id,
      tenant_id: auth.tenant_id,
      role: access.role,
      is_exafy_admin: access.is_exafy_admin,
      capabilities: access.capabilities,
      defaults: access.defaults,
      explicit: access.explicit,
      can_manage_access: canManageErpAccess(access),
      catalog: ERP_CAPABILITIES,
    });
  } catch (err: any) {
    console.error(`[${VTID}] GET /me error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// Shared guard for /access* ----------------------------------------------------------
async function requireManager(req: Request, res: Response): Promise<{ auth: Extract<Awaited<ReturnType<typeof verifyAuth>>, { ok: true }>; access: EffectiveAccess; tenantId: string } | null> {
  const auth = await verifyAuth(req);
  if (!auth.ok) { res.status(auth.status).json({ ok: false, error: auth.error }); return null; }
  const access = await resolveAccess(auth);
  if (!canManageErpAccess(access)) {
    res.status(403).json({ ok: false, error: 'FORBIDDEN', message: "Requires ERP capability 'erp.admin' or super admin" });
    return null;
  }
  const requested = typeof req.body?.tenant_id === 'string' ? req.body.tenant_id : (typeof req.query?.tenant_id === 'string' ? req.query.tenant_id : null);
  const tenantId = auth.is_exafy_admin ? (requested || auth.tenant_id) : auth.tenant_id;
  if (!tenantId) { res.status(400).json({ ok: false, error: 'NO_TENANT_CONTEXT' }); return null; }
  return { auth, access, tenantId };
}

// GET /access ----------------------------------------------------------------------
router.get('/access', async (req: Request, res: Response) => {
  const ctx = await requireManager(req, res);
  if (!ctx) return;
  try {
    const rows = await fetchGrants(ctx.tenantId);
    const byUser = new Map<string, GrantRow[]>();
    for (const r of rows) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);
    return res.status(200).json({
      ok: true,
      tenant_id: ctx.tenantId,
      catalog: ERP_CAPABILITIES,
      users: [...byUser.entries()].map(([user_id, grants]) => ({
        user_id,
        capabilities: grants.map((g) => g.capability),
        details: grants,
      })),
    });
  } catch (err: any) {
    console.error(`[${VTID}] GET /access error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// GET /access/:userId --------------------------------------------------------------
router.get('/access/:userId', async (req: Request, res: Response) => {
  const ctx = await requireManager(req, res);
  if (!ctx) return;
  try {
    const rows = await fetchGrants(ctx.tenantId, req.params.userId);
    return res.status(200).json({ ok: true, user_id: req.params.userId, tenant_id: ctx.tenantId, capabilities: rows.map((r) => r.capability), details: rows });
  } catch (err: any) {
    console.error(`[${VTID}] GET /access/:userId error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// POST /access/grant ---------------------------------------------------------------
router.post('/access/grant', async (req: Request, res: Response) => {
  const ctx = await requireManager(req, res);
  if (!ctx) return;
  const { user_id: targetUserId, capability } = req.body || {};
  if (!targetUserId || typeof targetUserId !== 'string') return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });
  const v = validateGrant(capability, ctx.auth);
  if (!v.ok) {
    if (v.error === 'INVALID_CAPABILITY') return res.status(400).json({ ok: false, error: 'INVALID_CAPABILITY', catalog: ERP_CAPABILITIES });
    return res.status(403).json({ ok: false, error: 'FORBIDDEN', message: `'${capability}' is personal-data access and can only be granted by a tenant admin or super admin` });
  }
  // target must be in the tenant — same check role-admin uses (Exafy bypasses inside)
  const membership = await canManageRoles({ ...ctx.auth, tenant_id: ctx.tenantId, active_role: ctx.auth.is_exafy_admin ? ctx.auth.active_role : 'admin' }, targetUserId);
  if (!membership.allowed) return res.status(403).json({ ok: false, error: 'FORBIDDEN', message: membership.reason });
  const creds = serviceCreds();
  if (!creds) return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  try {
    const response = await fetch(`${creds.url}/rest/v1/${TABLE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: creds.key, Authorization: `Bearer ${creds.key}`, Prefer: 'return=representation' },
      body: JSON.stringify({ user_id: targetUserId, tenant_id: ctx.tenantId, capability, granted_by: ctx.auth.user_id }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 409 || errorText.includes('duplicate') || errorText.includes('unique')) {
        return res.status(200).json({ ok: true, message: 'Capability already granted', user_id: targetUserId, tenant_id: ctx.tenantId, capability });
      }
      console.error(`[${VTID}] Grant error:`, errorText);
      return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
    }
    console.log(`[${VTID}] Capability granted: ${capability} to ${targetUserId} by ${ctx.auth.email}`);
    return res.status(200).json({ ok: true, message: `Capability '${capability}' granted`, user_id: targetUserId, tenant_id: ctx.tenantId, capability, granted_by: ctx.auth.user_id, explicit_only: v.explicit_only === true });
  } catch (err: any) {
    console.error(`[${VTID}] POST /access/grant error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// POST /access/revoke --------------------------------------------------------------
router.post('/access/revoke', async (req: Request, res: Response) => {
  const ctx = await requireManager(req, res);
  if (!ctx) return;
  const { user_id: targetUserId, capability } = req.body || {};
  if (!targetUserId || typeof targetUserId !== 'string') return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });
  if (!(ERP_CAPABILITIES as readonly string[]).includes(capability)) return res.status(400).json({ ok: false, error: 'INVALID_CAPABILITY', catalog: ERP_CAPABILITIES });
  const creds = serviceCreds();
  if (!creds) return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  try {
    const response = await fetch(
      `${creds.url}/rest/v1/${TABLE}?user_id=eq.${encodeURIComponent(targetUserId)}&tenant_id=eq.${encodeURIComponent(ctx.tenantId)}&capability=eq.${encodeURIComponent(capability)}`,
      { method: 'DELETE', headers: { apikey: creds.key, Authorization: `Bearer ${creds.key}`, Prefer: 'return=minimal' } },
    );
    if (!response.ok) {
      console.error(`[${VTID}] Revoke error:`, await response.text());
      return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
    }
    console.log(`[${VTID}] Capability revoked: ${capability} from ${targetUserId} by ${ctx.auth.email}`);
    return res.status(200).json({ ok: true, message: `Capability '${capability}' revoked`, user_id: targetUserId, tenant_id: ctx.tenantId, capability });
  } catch (err: any) {
    console.error(`[${VTID}] POST /access/revoke error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

export default router;
