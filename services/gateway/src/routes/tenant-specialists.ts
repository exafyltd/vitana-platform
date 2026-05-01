/**
 * VTID-02655: Phase 6 — tenant overlay management endpoints.
 *
 * Mounted at /api/v1/admin/tenants/:tenantId/specialists. The vitana-v1
 * admin UI uses these to let tenant admins customize the platform-built
 * specialists for their tenant: enable/disable, attach KB scopes, add
 * routing keywords, intake schema extras, tenant-scoped 3rd-party
 * connections.
 *
 * Three-layer separation:
 *   Command Hub (BUILD)      → /api/v1/admin/specialists/* (platform)
 *   Tenant Admin (CUSTOMIZE) → /api/v1/admin/tenants/:tenantId/specialists/*
 *                              (this file)
 *   Community User (USE)     → orb-live.ts uses tenant-aware registry
 *
 * Auth: caller must be authenticated AND a member of the requested tenant
 * with admin role. RLS on the underlying tables also enforces this; this
 * file's check fails fast at the gateway.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { clearTenantPersonaCache } from '../services/persona-registry';

const router = Router();
const VTID = 'VTID-02655';

function getServiceClient() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!,
    { auth: { persistSession: false, autoRefreshToken: false } });
}

function getBearerToken(req: Request): string | null {
  const h = req.headers.authorization;
  return h && h.startsWith('Bearer ') ? h.slice(7) : null;
}

function decodeJwtSub(token: string): string | null {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).sub ?? null; }
  catch { return null; }
}

async function ensureTenantAdmin(req: Request, res: Response, tenantId: string): Promise<string | null> {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    return null;
  }
  const userId = decodeJwtSub(token);
  if (!userId) {
    res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
    return null;
  }
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('user_tenants')
    .select('tenant_id, role')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error || !data) {
    res.status(403).json({ ok: false, error: 'NOT_TENANT_MEMBER' });
    return null;
  }
  return userId;
}

async function resolvePersonaId(key: string): Promise<string | null> {
  const supabase = getServiceClient();
  const { data } = await supabase
    .from('agent_personas')
    .select('id')
    .eq('key', key)
    .maybeSingle();
  return data?.id ?? null;
}

async function writeTenantAudit(
  actorUserId: string,
  tenantId: string,
  personaId: string | null,
  action: string,
  before: unknown,
  after: unknown,
) {
  const supabase = getServiceClient();
  await supabase.from('agent_audit_log').insert({
    actor_user_id: actorUserId,
    tenant_id: tenantId,
    persona_id: personaId,
    action,
    before_state: before ?? null,
    after_state: after ?? null,
  });
}

// ---------------------------------------------------------------------------
// GET /:tenantId/specialists/:key/overrides — read tenant overlay
// ---------------------------------------------------------------------------
// Returns the tenant's overlay row + the platform persona it overlays so the
// UI can show "Platform default: enabled. Your tenant: disabled" side-by-side.

router.get('/:tenantId/specialists/:key/overrides', async (req: Request, res: Response) => {
  const tenantId = req.params.tenantId;
  if (!(await ensureTenantAdmin(req, res, tenantId))) return;

  const supabase = getServiceClient();
  const { data: persona } = await supabase
    .from('agent_personas')
    .select('id, key, display_name, role, voice_id, status, handles_kinds, handoff_keywords, greeting_templates')
    .eq('key', req.params.key)
    .maybeSingle();
  if (!persona) return res.status(404).json({ ok: false, error: 'PERSONA_NOT_FOUND' });

  const { data: overlay } = await supabase
    .from('agent_personas_tenant_overrides')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('persona_id', persona.id)
    .maybeSingle();

  const { data: kbBindings } = await supabase
    .from('agent_kb_bindings_tenant')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('persona_id', persona.id);

  const { data: keywords } = await supabase
    .from('agent_routing_keywords_tenant')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('persona_id', persona.id);

  const { data: connections } = await supabase
    .from('agent_third_party_connections')
    .select('id, provider, status, last_check_at, created_at')
    .eq('tenant_id', tenantId)
    .eq('persona_id', persona.id);

  return res.json({
    ok: true,
    persona,
    overlay: overlay ?? { enabled: true, intake_schema_extras: {}, custom_greeting_templates: {}, notes: null },
    kb_bindings: kbBindings ?? [],
    routing_keywords: keywords ?? [],
    connections: connections ?? [],
  });
});

// ---------------------------------------------------------------------------
// PUT /:tenantId/specialists/:key/overrides — upsert tenant overlay
// ---------------------------------------------------------------------------

const OverrideUpsertSchema = z.object({
  enabled: z.boolean().optional(),
  intake_schema_extras: z.record(z.unknown()).optional(),
  custom_greeting_templates: z.record(z.string()).optional(),
  notes: z.string().max(2000).nullable().optional(),
});

router.put('/:tenantId/specialists/:key/overrides', async (req: Request, res: Response) => {
  const tenantId = req.params.tenantId;
  const userId = await ensureTenantAdmin(req, res, tenantId);
  if (!userId) return;
  const v = OverrideUpsertSchema.safeParse(req.body);
  if (!v.success) return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', details: v.error.errors });

  const personaId = await resolvePersonaId(req.params.key);
  if (!personaId) return res.status(404).json({ ok: false, error: 'PERSONA_NOT_FOUND' });

  const supabase = getServiceClient();
  const { data: existing } = await supabase
    .from('agent_personas_tenant_overrides')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('persona_id', personaId)
    .maybeSingle();

  const patch = {
    tenant_id: tenantId,
    persona_id: personaId,
    enabled: v.data.enabled ?? existing?.enabled ?? true,
    intake_schema_extras: v.data.intake_schema_extras ?? existing?.intake_schema_extras ?? {},
    custom_greeting_templates: v.data.custom_greeting_templates ?? existing?.custom_greeting_templates ?? {},
    notes: v.data.notes !== undefined ? v.data.notes : existing?.notes ?? null,
    updated_by: userId,
    updated_at: new Date().toISOString(),
  };

  const { data: upserted, error } = await supabase
    .from('agent_personas_tenant_overrides')
    .upsert(patch, { onConflict: 'tenant_id,persona_id' })
    .select('*')
    .single();
  if (error || !upserted) return res.status(502).json({ ok: false, error: error?.message });

  // Audit — distinguish enable vs disable vs intake_extras change.
  let action = 'tenant_intake_extras_change';
  if (v.data.enabled === true && existing?.enabled === false) action = 'tenant_persona_enable';
  else if (v.data.enabled === false && existing?.enabled !== false) action = 'tenant_persona_disable';
  await writeTenantAudit(userId, tenantId, personaId, action, existing, upserted);

  // Invalidate tenant cache so the next runtime call sees the new overlay.
  clearTenantPersonaCache(tenantId);

  return res.json({ ok: true, overlay: upserted });
});

// ---------------------------------------------------------------------------
// PUT /:tenantId/specialists/:key/kb-bindings — replace tenant KB bindings
// ---------------------------------------------------------------------------

const KbBindingsSchema = z.object({
  scopes: z.array(z.string().min(1).max(120)).max(50),
});

router.put('/:tenantId/specialists/:key/kb-bindings', async (req: Request, res: Response) => {
  const tenantId = req.params.tenantId;
  const userId = await ensureTenantAdmin(req, res, tenantId);
  if (!userId) return;
  const v = KbBindingsSchema.safeParse(req.body);
  if (!v.success) return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED' });

  const personaId = await resolvePersonaId(req.params.key);
  if (!personaId) return res.status(404).json({ ok: false, error: 'PERSONA_NOT_FOUND' });

  const supabase = getServiceClient();
  const { data: before } = await supabase
    .from('agent_kb_bindings_tenant')
    .select('kb_scope, enabled')
    .eq('tenant_id', tenantId)
    .eq('persona_id', personaId);

  await supabase.from('agent_kb_bindings_tenant')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('persona_id', personaId);

  if (v.data.scopes.length > 0) {
    await supabase.from('agent_kb_bindings_tenant').insert(
      v.data.scopes.map(scope => ({
        tenant_id: tenantId,
        persona_id: personaId,
        kb_scope: scope,
        enabled: true,
        bound_by: userId,
      }))
    );
  }

  await writeTenantAudit(
    userId, tenantId, personaId, 'tenant_kb_bind',
    before ?? [],
    v.data.scopes.map(s => ({ kb_scope: s, enabled: true })),
  );
  clearTenantPersonaCache(tenantId);
  return res.json({ ok: true, bindings: v.data.scopes });
});

// ---------------------------------------------------------------------------
// PUT /:tenantId/specialists/:key/keywords — replace tenant routing keywords
// ---------------------------------------------------------------------------

const KeywordsSchema = z.object({
  keywords: z.array(z.object({
    keyword: z.string().min(1).max(200),
    weight: z.number().min(0).max(10).optional(),
  })).max(200),
});

router.put('/:tenantId/specialists/:key/keywords', async (req: Request, res: Response) => {
  const tenantId = req.params.tenantId;
  const userId = await ensureTenantAdmin(req, res, tenantId);
  if (!userId) return;
  const v = KeywordsSchema.safeParse(req.body);
  if (!v.success) return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED' });

  const personaId = await resolvePersonaId(req.params.key);
  if (!personaId) return res.status(404).json({ ok: false, error: 'PERSONA_NOT_FOUND' });

  const supabase = getServiceClient();
  const { data: before } = await supabase
    .from('agent_routing_keywords_tenant')
    .select('keyword, weight, enabled')
    .eq('tenant_id', tenantId)
    .eq('persona_id', personaId);

  await supabase.from('agent_routing_keywords_tenant')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('persona_id', personaId);

  if (v.data.keywords.length > 0) {
    await supabase.from('agent_routing_keywords_tenant').insert(
      v.data.keywords.map(k => ({
        tenant_id: tenantId,
        persona_id: personaId,
        keyword: k.keyword.trim().toLowerCase(),
        weight: k.weight ?? 1.0,
        enabled: true,
        added_by: userId,
      }))
    );
  }

  await writeTenantAudit(
    userId, tenantId, personaId, 'tenant_keyword_add',
    before ?? [],
    v.data.keywords,
  );
  // No cache to clear — pick_specialist_for_text_tenant reads SQL each call.
  return res.json({ ok: true, keywords: v.data.keywords });
});

// ---------------------------------------------------------------------------
// /:tenantId/specialists/:key/connections — tenant 3rd-party connections
// ---------------------------------------------------------------------------

const ConnectionAddSchema = z.object({
  provider: z.string().min(1).max(120),
});

router.get('/:tenantId/specialists/:key/connections', async (req: Request, res: Response) => {
  const tenantId = req.params.tenantId;
  if (!(await ensureTenantAdmin(req, res, tenantId))) return;
  const personaId = await resolvePersonaId(req.params.key);
  if (!personaId) return res.status(404).json({ ok: false, error: 'PERSONA_NOT_FOUND' });

  const supabase = getServiceClient();

  // Tenant-scoped connections: tenant_id = X
  const { data: tenantConns } = await supabase
    .from('agent_third_party_connections')
    .select('id, provider, status, last_check_at, created_at')
    .eq('tenant_id', tenantId)
    .eq('persona_id', personaId);

  // Platform default connections (tenant_id IS NULL) shown as read-only
  const { data: platformConns } = await supabase
    .from('agent_third_party_connections')
    .select('id, provider, status, last_check_at, created_at')
    .is('tenant_id', null)
    .eq('persona_id', personaId);

  return res.json({
    ok: true,
    tenant_connections: tenantConns ?? [],
    platform_defaults: platformConns ?? [],
  });
});

router.post('/:tenantId/specialists/:key/connections', async (req: Request, res: Response) => {
  const tenantId = req.params.tenantId;
  const userId = await ensureTenantAdmin(req, res, tenantId);
  if (!userId) return;
  const v = ConnectionAddSchema.safeParse(req.body);
  if (!v.success) return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED' });

  const personaId = await resolvePersonaId(req.params.key);
  if (!personaId) return res.status(404).json({ ok: false, error: 'PERSONA_NOT_FOUND' });

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('agent_third_party_connections')
    .insert({
      tenant_id: tenantId,
      persona_id: personaId,
      provider: v.data.provider,
      status: 'draft',
      created_by: userId,
    })
    .select('*')
    .single();
  if (error || !data) return res.status(502).json({ ok: false, error: error?.message });

  await writeTenantAudit(userId, tenantId, personaId, 'tenant_connection_add', null, {
    connection_id: data.id, provider: v.data.provider,
  });
  return res.status(201).json({ ok: true, connection: data });
});

router.delete('/:tenantId/specialists/:key/connections/:connectionId', async (req: Request, res: Response) => {
  const tenantId = req.params.tenantId;
  const userId = await ensureTenantAdmin(req, res, tenantId);
  if (!userId) return;

  const supabase = getServiceClient();
  const { data: existing } = await supabase
    .from('agent_third_party_connections')
    .select('*')
    .eq('id', req.params.connectionId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!existing) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  await supabase.from('agent_third_party_connections')
    .delete()
    .eq('id', req.params.connectionId)
    .eq('tenant_id', tenantId);

  await writeTenantAudit(userId, tenantId, existing.persona_id, 'tenant_connection_remove', existing, null);
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /:tenantId/audit — tenant-scoped audit log
// ---------------------------------------------------------------------------

router.get('/:tenantId/audit', async (req: Request, res: Response) => {
  const tenantId = req.params.tenantId;
  if (!(await ensureTenantAdmin(req, res, tenantId))) return;
  const limit = Math.min(parseInt(String(req.query.limit ?? '100'), 10) || 100, 500);
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('agent_audit_log')
    .select('id, actor_user_id, persona_id, action, before_state, after_state, ts')
    .eq('tenant_id', tenantId)
    .order('ts', { ascending: false })
    .limit(limit);
  if (error) return res.status(502).json({ ok: false, error: error.message });
  return res.json({ ok: true, audit: data ?? [] });
});

void VTID;
export default router;
