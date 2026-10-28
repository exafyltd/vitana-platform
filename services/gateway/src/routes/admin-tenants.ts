/**
 * Admin Tenants API — Tenant Management
 *
 * Endpoints:
 * - GET   /                    — List tenants with user counts
 * - GET   /:id                 — Single tenant detail with member list
 * - POST  /                    — VTID-05150: provision a new tenant (provision_tenant RPC)
 * - PATCH /:id                 — VTID-05150: edit a provisioned tenant's brand pack / open_signup
 * - PUT   /:id/assets/:kind    — VTID-05150: logo | favicon | og_image (png/jpeg/webp, ≤1 MB)
 * - GET   /:id/readiness       — VTID-05150: is the tenant ready to open?
 *
 * Security:
 * - All endpoints require Bearer token + exafy_admin
 *
 * The /:id routes are single-segment (or a fixed second segment), so they never
 * capture the per-tenant sub-routers mounted after this one in index.ts
 * (/:tenantId/invitations, /settings, …).
 */

import express, { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import { createUserSupabaseClient } from '../lib/supabase-user';
import * as repo from './admin-tenants-repository';
import { emitOasisEvent } from '../services/oasis-event-service';
import { sniffImageType } from '../services/operator-media';
import {
  ASSET_KINDS,
  AssetKind,
  ProvisionTenantSchema,
  TenantBrandPackPatchSchema,
} from '../services/tenant-provisioning/schemas';
import { isReservedSlug } from '../services/tenant-provisioning/reserved-slugs';
import {
  computeNotificationBaseline,
  computeReadiness,
  ControlKey,
  ReadinessInput,
} from '../services/tenant-provisioning/readiness';

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

    const [tenantsResult, membershipsResult] = await Promise.all([
      repo.fetchTenantsList(supabase, query || undefined),
      repo.fetchAllTenantMemberships(supabase),
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

    // tenants' PK column is `tenant_id`, not `id` — see admin_tenants schema note
    let tenantResult = await repo.fetchTenantById(supabase, id);

    // If that fails, try slug as fallback
    if (tenantResult.error) {
      tenantResult = await repo.fetchTenantBySlug(supabase, id);
    }

    if (tenantResult.error || !tenantResult.data) {
      return res.status(404).json({ ok: false, error: 'TENANT_NOT_FOUND' });
    }

    const tenant = tenantResult.data as any;
    const tenantId = tenant.id || tenant.tenant_id;

    // Get members — flat query, then lookup user emails separately
    const { data: memberships, error: membershipsErr } = await repo.fetchTenantMemberships(supabase, tenantId);
    if (membershipsErr) throw membershipsErr;

    // Get user details for members
    const userIds = (memberships || []).map((m: any) => m.user_id);
    let usersMap: Record<string, any> = {};
    if (userIds.length > 0) {
      const { data: users, error: usersErr } = await repo.fetchAppUsersByIds(supabase, userIds);
      if (usersErr) throw usersErr;
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

// ══ VTID-05150: tenant provisioning ═════════════════════════════════════════

const PROVISION_VTID = 'VTID-05150';
const OASIS_SOURCE = 'gateway/admin-tenants';

/** Asset types a public bucket may hold (sniffImageType also knows GIF: refused here). */
export const ALLOWED_ASSET_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
type AllowedAssetType = (typeof ALLOWED_ASSET_TYPES)[number];
const ASSET_EXT: Record<AllowedAssetType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
export const ASSET_MAX_BYTES = 1024 * 1024;
const rawAsset = express.raw({ type: [...ALLOWED_ASSET_TYPES], limit: ASSET_MAX_BYTES });

/** provision_tenant() code words (message prefix) → HTTP status. */
const CODE_STATUS: Record<string, number> = {
  INVALID_SLUG: 400,
  RESERVED_SLUG: 400,
  INVALID_NAME: 400,
  INVALID_ADMIN_EMAIL: 400,
  NOT_EXAFY_ADMIN: 403,
  SERVICE_ACCOUNT_EMAIL: 400,
  INVALID_PARAMS: 400,
  INVALID_LOCALE: 400,
  INVALID_TIMEZONE: 400,
  INVALID_ASSET_PATH: 400,
  SLUG_TAKEN: 409,
  NO_DEFAULT_TENANT: 409,
  NO_NOTIFICATION_BASELINE: 409,
};

type DbError = { code?: string; message?: string; details?: string } | null | undefined;

function isMissingFunction(err: DbError): boolean {
  if (!err) return false;
  return err.code === 'PGRST202' || err.code === '42883' || /could not find the function/i.test(err.message || '');
}

/** A DB error mapped to {status, error}; null when it is not one we name. */
function mapDbError(err: DbError): { status: number; error: string } | null {
  if (!err) return null;
  const word = String(err.message || '').split(/[:\s]/)[0];
  if (word in CODE_STATUS) return { status: CODE_STATUS[word], error: word };
  if (err.code === '23514') return { status: 400, error: 'INVALID_PARAMS' }; // CHECK violation
  return null;
}

const issues = (e: { issues: Array<{ path: (string | number)[]; message: string }> }) =>
  e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

async function resolveTenant(supabase: any, idOrSlug: string): Promise<any | null> {
  let r = await repo.fetchTenantById(supabase, idOrSlug);
  if (r.error || !r.data) r = await repo.fetchTenantBySlug(supabase, idOrSlug);
  return r.error || !r.data ? null : r.data;
}

/** Fetch every row readiness needs and run the pure computeReadiness(). */
async function gatherReadiness(supabase: any, tenant: any, settingsOverride?: Record<string, unknown>) {
  const tenantId: string = tenant.tenant_id;
  const settingsRes = await repo.fetchTenantSettingsRow(supabase, tenantId);
  const settings = settingsRes.data ? { ...settingsRes.data, ...(settingsOverride || {}) } : null;

  const tenantsRes = await repo.fetchAllTenantsRows(supabase);
  const all: any[] = tenantsRes.data || [];
  const others = all.filter((t) => t.tenant_id !== tenantId && t.is_active !== false && t.is_platform !== true);
  const defaultTenant = all.find((t) => t.is_default === true) || null;

  const controlsRes = await repo.fetchNotificationControls(supabase, [tenantId, ...others.map((t) => t.tenant_id)]);
  const byTenant = new Map<string, ControlKey[]>();
  for (const t of others) byTenant.set(t.tenant_id, []);
  const mine: ControlKey[] = [];
  for (const c of (controlsRes.data || []) as any[]) {
    const key = { type: c.type, source_key: c.source_key ?? '' };
    if (c.tenant_id === tenantId) mine.push(key);
    else byTenant.get(c.tenant_id)?.push(key);
  }

  const policyRes = await repo.fetchPolicyProviders(
    supabase,
    defaultTenant ? [tenantId, defaultTenant.tenant_id] : [tenantId],
  );
  const policies: any[] = policyRes.data || [];

  const autopilot = await repo.countAutopilotSettings(supabase, tenantId);
  const groups = await repo.fetchSystemGroupIds(supabase, tenantId);
  const groupIds = ((groups.data || []) as any[]).map((g) => g.id);
  const bots = groupIds.length ? await repo.fetchBotMemberships(supabase, groupIds) : { data: [] };

  const acceptedAdmin = await repo.fetchAcceptedAdminInvitation(supabase, tenantId);
  const adminMember = await repo.fetchAdminMembership(supabase, tenantId);

  const platformHost =
    (settings as any)?.domains?.primary_domain || process.env.FRONTEND_URL || null;

  const input: ReadinessInput = {
    tenant: { tenant_id: tenantId, slug: tenant.slug ?? null, open_signup: tenant.open_signup ?? null },
    settings: settings as Record<string, any> | null,
    platformHost,
    storageObjects: tenant.slug ? await repo.listTenantAssetObjects(tenant.slug) : null,
    controls: mine,
    baseline: computeNotificationBaseline(byTenant),
    policyProviders: policies.filter((p) => p.tenant_id === tenantId).map((p) => p.provider),
    defaultPolicyProviders: defaultTenant
      ? policies.filter((p) => p.tenant_id === defaultTenant.tenant_id).map((p) => p.provider)
      : [],
    autopilotRows: autopilot.count ?? 0,
    systemGroupWithBot: ((bots.data || []) as any[]).length > 0,
    firstAdmin: ((acceptedAdmin.data || []) as any[]).length > 0 || ((adminMember.data || []) as any[]).length > 0,
  };
  return { settingsRow: settingsRes.data as Record<string, any> | null, result: computeReadiness(input) };
}

function emit(type: 'tenant.provisioned' | 'tenant.brand_pack.updated' | 'tenant.asset.uploaded', message: string, actorId: string, payload: Record<string, unknown>) {
  return emitOasisEvent({
    vtid: PROVISION_VTID,
    type,
    source: OASIS_SOURCE,
    status: 'success',
    message,
    actor_id: actorId,
    actor_role: 'admin',
    surface: 'api',
    payload,
  }).catch(() => undefined);
}

// ── POST / — provision a tenant ─────────────────────────────

router.post('/', async (req: Request, res: Response) => {
  const auth = await verifyExafyAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const parsed = ProvisionTenantSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', issues: issues(parsed.error) });
  const b = parsed.data;
  if (isReservedSlug(b.slug)) return res.status(400).json({ ok: false, error: 'RESERVED_SLUG' });

  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const { data, error } = await repo.rpcProvisionTenant(supabase, {
      p_slug: b.slug,
      p_name: b.name,
      p_admin_email: b.admin_email,
      p_invited_by: auth.user_id,
      p_all_members_group_name: b.all_members_group_name,
      p_display_name: b.display_name ?? null,
      p_jev_monthly_budget_usd: b.jev_monthly_budget_usd ?? 10,
      p_default_locale: b.default_locale ?? 'de',
      p_enabled_locales: b.enabled_locales ?? null,
      p_timezone: b.timezone ?? 'Europe/Berlin',
      p_currency: b.currency ?? 'EUR',
    });
    if (error) {
      if (isMissingFunction(error)) return res.status(503).json({ ok: false, error: 'PROVISIONING_UNAVAILABLE' });
      const mapped = mapDbError(error);
      if (mapped) return res.status(mapped.status).json({ ok: false, error: mapped.error });
      console.error(`[${PROVISION_VTID}] provision_tenant failed:`, error.message);
      return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
    }

    const r = data as any;
    const created = r?.created === true;
    await emit('tenant.provisioned', `Tenant ${r?.slug} ${created ? 'provisioned' : 're-checked (already provisioned)'}`, auth.user_id, {
      tenant_id: r?.tenant_id,
      slug: r?.slug,
      created,
      invitation_id: r?.invitation?.id ?? null,
      ensured: r?.ensured ?? null,
    });

    return res.status(created ? 201 : 200).json({
      ok: true,
      tenant_id: r?.tenant_id,
      slug: r?.slug,
      created,
      invitation: {
        id: r?.invitation?.id ?? null,
        expires_at: r?.invitation?.expires_at ?? null,
        reused: r?.invitation?.reused === true,
        // The operator delivers this to the first admin (no invitation email yet).
        accept_path: r?.invitation?.token ? `/admin/invitations/accept/${r.invitation.token}` : null,
      },
      ensured: r?.ensured ?? null,
    });
  } catch (err: any) {
    console.error(`[${PROVISION_VTID}] provision error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── PATCH /:id — brand pack / open_signup (provisioned tenants only) ───

const PACK_FIELDS = [
  'display_name', 'brand', 'legal_entity_line', 'support_email', 'sender_name', 'sender_email',
  'default_locale', 'enabled_locales', 'timezone', 'currency', 'landing', 'persona_facts',
] as const;

router.patch('/:id', async (req: Request, res: Response) => {
  const auth = await verifyExafyAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const parsed = TenantBrandPackPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', issues: issues(parsed.error) });
  const b = parsed.data;

  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenant = await resolveTenant(supabase, req.params.id);
    if (!tenant) return res.status(404).json({ ok: false, error: 'TENANT_NOT_FOUND' });

    const current = await repo.fetchTenantSettingsRow(supabase, tenant.tenant_id);
    if (current.error) return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
    const row = current.data as Record<string, any> | null;
    if (!row || !('provisioned_at' in row)) return res.status(503).json({ ok: false, error: 'PROVISIONING_UNAVAILABLE' });
    if (!row.provisioned_at) return res.status(409).json({ ok: false, error: 'LEGACY_TENANT_READ_ONLY' });

    const updates: Record<string, unknown> = {};
    for (const f of PACK_FIELDS) {
      if (b[f] === undefined) continue;
      // brand / landing keep the keys this PATCH cannot set (asset paths).
      if (f === 'brand' || f === 'landing') updates[f] = { ...(row[f] || {}), ...(b[f] as object) };
      else updates[f] = b[f];
    }
    const changed = Object.keys(updates);

    let readinessReady: boolean | undefined;
    let overrideUsed = false;
    if (b.open_signup === true) {
      const { result } = await gatherReadiness(supabase, tenant, updates);
      readinessReady = result.ready;
      if (!result.ready) {
        if (!b.override_reason) {
          return res.status(409).json({
            ok: false,
            error: 'TENANT_NOT_READY',
            failing: result.checks.filter((c) => !c.ok && !c.informational).map((c) => c.key),
          });
        }
        overrideUsed = true;
      }
    }

    let settings: unknown = row;
    if (changed.length) {
      const { data, error } = await repo.updateTenantSettingsPack(supabase, tenant.tenant_id, {
        ...updates,
        updated_at: new Date().toISOString(),
        updated_by: auth.user_id,
      });
      if (error) {
        const mapped = mapDbError(error);
        if (mapped) return res.status(mapped.status).json({ ok: false, error: mapped.error });
        return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
      }
      settings = data;
    }
    if (b.open_signup !== undefined) {
      const { error } = await repo.updateTenantOpenSignup(supabase, tenant.tenant_id, b.open_signup);
      if (error) return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
      changed.push('open_signup');
    }

    await emit('tenant.brand_pack.updated', `Tenant ${tenant.slug} brand pack updated`, auth.user_id, {
      tenant_id: tenant.tenant_id,
      slug: tenant.slug,
      fields: changed,
      ...(b.open_signup !== undefined ? { open_signup: b.open_signup } : {}),
      ...(readinessReady !== undefined ? { readiness_ready: readinessReady } : {}),
      ...(overrideUsed ? { override_reason: b.override_reason } : {}),
    });

    return res.json({ ok: true, tenant_id: tenant.tenant_id, updated_fields: changed, settings });
  } catch (err: any) {
    console.error(`[${PROVISION_VTID}] patch error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── PUT /:id/assets/:kind — logo | favicon | og_image ────────

router.put('/:id/assets/:kind', async (req: Request, res: Response) => {
  const auth = await verifyExafyAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const kind = req.params.kind as AssetKind;
  if (!(ASSET_KINDS as readonly string[]).includes(kind)) return res.status(400).json({ ok: false, error: 'INVALID_ASSET_KIND' });

  // Body only after the caller is known to be an exafy_admin.
  const parseErr = await new Promise<unknown>((resolve) => rawAsset(req, res, (err?: unknown) => resolve(err)));
  if (parseErr) {
    const tooLarge = (parseErr as { type?: string }).type === 'entity.too.large';
    return res.status(tooLarge ? 413 : 400).json({ ok: false, error: tooLarge ? 'TOO_LARGE' : 'INVALID_BODY' });
  }
  const bytes = Buffer.isBuffer(req.body) ? (req.body as Buffer) : null;
  if (!bytes || bytes.length === 0) return res.status(415).json({ ok: false, error: 'UNSUPPORTED_TYPE', allowed: ALLOWED_ASSET_TYPES });
  const declared = String(req.header('content-type') || '').split(';')[0].trim().toLowerCase();
  const real = sniffImageType(bytes);
  if (!real || !(ALLOWED_ASSET_TYPES as readonly string[]).includes(real) || real !== declared) {
    return res.status(415).json({ ok: false, error: 'UNSUPPORTED_TYPE', allowed: ALLOWED_ASSET_TYPES });
  }
  const mime = real as AllowedAssetType;

  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenant = await resolveTenant(supabase, req.params.id);
    if (!tenant || !tenant.slug) return res.status(404).json({ ok: false, error: 'TENANT_NOT_FOUND' });
    const current = await repo.fetchTenantSettingsRow(supabase, tenant.tenant_id);
    const row = current.data as Record<string, any> | null;
    if (current.error) return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
    if (!row || !('provisioned_at' in row)) return res.status(503).json({ ok: false, error: 'PROVISIONING_UNAVAILABLE' });
    if (!row.provisioned_at) return res.status(409).json({ ok: false, error: 'LEGACY_TENANT_READ_ONLY' });

    const objectPath = `${tenant.slug}/${kind}.${ASSET_EXT[mime]}`;
    const up = await repo.uploadTenantAssetObject(objectPath, bytes, mime);
    if (!up.ok) {
      console.error(`[${PROVISION_VTID}] asset upload failed (${up.status}) for ${objectPath}`);
      return res.status(503).json({ ok: false, error: 'STORAGE_UNAVAILABLE' });
    }
    const { error } = await repo.updateTenantSettingsPack(supabase, tenant.tenant_id, {
      brand: { ...(row.brand || {}), [`${kind}_path`]: objectPath },
      updated_at: new Date().toISOString(),
      updated_by: auth.user_id,
    });
    if (error) return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });

    await emit('tenant.asset.uploaded', `Tenant ${tenant.slug} ${kind} uploaded`, auth.user_id, {
      tenant_id: tenant.tenant_id,
      slug: tenant.slug,
      kind,
      mime_type: mime,
      size_bytes: bytes.length,
    });
    return res.json({ ok: true, path: objectPath, mime_type: mime, size_bytes: bytes.length });
  } catch (err: any) {
    console.error(`[${PROVISION_VTID}] asset error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── GET /:id/readiness ─────────────────────────────────────

router.get('/:id/readiness', async (req: Request, res: Response) => {
  const auth = await verifyExafyAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
    const tenant = await resolveTenant(supabase, req.params.id);
    if (!tenant) return res.status(404).json({ ok: false, error: 'TENANT_NOT_FOUND' });

    const { result } = await gatherReadiness(supabase, tenant);
    return res.json({ ok: true, tenant_id: tenant.tenant_id, slug: tenant.slug, ...result });
  } catch (err: any) {
    console.error(`[${PROVISION_VTID}] readiness error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

export default router;
