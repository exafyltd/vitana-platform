/**
 * VTID-02403: Admin AI Integrations API
 *
 * Endpoints (mounted at /api/v1/admin/ai-assistants):
 *   GET   /catalog                       — list connector_registry where category='ai_assistant'
 *   PATCH /catalog/:provider             — toggle enabled, edit display_name
 *   GET   /policies/:tenant              — read tenant policy
 *   PUT   /policies/:tenant              — update tenant policy (body can be full list or per-provider)
 *   GET   /connections?tenant=&provider=&status=  — list connections
 *   GET   /consent-log?tenant=&user=&provider=    — query consent log
 *
 * Authorization: JWT with app_metadata.roles including 'ADM' or 'INFRA'.
 */

import { Router, Request, Response } from 'express';
import * as jose from 'jose';
import { getSupabase } from '../../lib/supabase';
import { emitOasisEvent } from '../../services/oasis-event-service';

const router = Router();
const VTID = 'VTID-02403';
const LOG_PREFIX = '[Admin-AI-Integrations]';

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

function requireAdmin(
  req: Request
): { ok: true; user_id: string; roles: string[] } | { ok: false; status: number; error: string } {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'UNAUTHENTICATED' };
  }
  try {
    const claims = jose.decodeJwt(authHeader.slice(7));
    const user_id = typeof claims.sub === 'string' ? claims.sub : null;
    if (!user_id) return { ok: false, status: 401, error: 'INVALID_TOKEN' };
    const app_metadata = (claims as { app_metadata?: { roles?: string[]; exafy_admin?: boolean } }).app_metadata || {};
    const roles = Array.isArray(app_metadata.roles) ? app_metadata.roles : [];
    const hasAdminRole = roles.includes('ADM') || roles.includes('INFRA') || app_metadata.exafy_admin === true;
    if (!hasAdminRole) return { ok: false, status: 403, error: 'FORBIDDEN' };
    return { ok: true, user_id, roles };
  } catch {
    return { ok: false, status: 401, error: 'INVALID_TOKEN' };
  }
}

// =============================================================================
// GET /catalog
// =============================================================================
router.get('/catalog', async (req: Request, res: Response) => {
  const auth = requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const { data, error } = await supabase
    .from('connector_registry')
    .select('*')
    .eq('category', 'ai_assistant')
    .order('display_name', { ascending: true });
  if (error) return res.status(500).json({ ok: false, error: error.message });
  return res.json({ ok: true, catalog: data ?? [] });
});

// =============================================================================
// PATCH /catalog/:provider  — toggle enabled, edit display_name
// =============================================================================
router.patch('/catalog/:provider', async (req: Request, res: Response) => {
  const auth = requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const provider = req.params.provider;
  const { enabled, display_name } = (req.body ?? {}) as { enabled?: boolean; display_name?: string };

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof enabled === 'boolean') updates.enabled = enabled;
  if (typeof display_name === 'string' && display_name.length > 0) updates.display_name = display_name;
  if (Object.keys(updates).length === 1) {
    return res.status(400).json({ ok: false, error: 'NO_FIELDS' });
  }

  const { data, error } = await supabase
    .from('connector_registry')
    .update(updates)
    .eq('id', provider)
    .eq('category', 'ai_assistant')
    .select('*')
    .maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!data) return res.status(404).json({ ok: false, error: 'PROVIDER_NOT_FOUND' });
  return res.json({ ok: true, entry: data });
});

// =============================================================================
// GET /policies/:tenant  — read all provider policies for a tenant
// =============================================================================
router.get('/policies/:tenant', async (req: Request, res: Response) => {
  const auth = requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const tenantParam = req.params.tenant;
  let tenantId = tenantParam;
  // Allow slug-based lookup
  if (!/^[0-9a-fA-F-]{36}$/.test(tenantParam)) {
    const { data: tRow } = await supabase.from('tenants').select('id').eq('slug', tenantParam).maybeSingle();
    if (!tRow) return res.status(404).json({ ok: false, error: 'TENANT_NOT_FOUND' });
    tenantId = tRow.id;
  }

  const { data, error } = await supabase
    .from('ai_provider_policies')
    .select('*')
    .eq('tenant_id', tenantId);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  return res.json({ ok: true, tenant_id: tenantId, policies: data ?? [] });
});

// =============================================================================
// PUT /policies/:tenant — upsert a provider policy
// body: { provider, allowed, allowed_models?, cost_cap_usd_month?, allowed_memory_categories? }
// =============================================================================
router.put('/policies/:tenant', async (req: Request, res: Response) => {
  const auth = requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const tenantParam = req.params.tenant;
  let tenantId = tenantParam;
  if (!/^[0-9a-fA-F-]{36}$/.test(tenantParam)) {
    const { data: tRow } = await supabase.from('tenants').select('id').eq('slug', tenantParam).maybeSingle();
    if (!tRow) return res.status(404).json({ ok: false, error: 'TENANT_NOT_FOUND' });
    tenantId = tRow.id;
  }

  const body = (req.body ?? {}) as {
    provider?: string;
    allowed?: boolean;
    allowed_models?: string[];
    cost_cap_usd_month?: number;
    allowed_memory_categories?: string[];
  };
  if (!body.provider) return res.status(400).json({ ok: false, error: 'PROVIDER_REQUIRED' });

  // Snapshot before for audit
  const { data: before } = await supabase
    .from('ai_provider_policies')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('provider', body.provider)
    .maybeSingle();

  const upsertRow: Record<string, unknown> = {
    tenant_id: tenantId,
    provider: body.provider,
    updated_by: auth.user_id,
    updated_at: new Date().toISOString(),
  };
  if (typeof body.allowed === 'boolean') upsertRow.allowed = body.allowed;
  if (Array.isArray(body.allowed_models)) upsertRow.allowed_models = body.allowed_models;
  if (typeof body.cost_cap_usd_month === 'number') upsertRow.cost_cap_usd_month = body.cost_cap_usd_month;
  if (Array.isArray(body.allowed_memory_categories)) upsertRow.allowed_memory_categories = body.allowed_memory_categories;

  const { data: after, error } = await supabase
    .from('ai_provider_policies')
    .upsert(upsertRow, { onConflict: 'tenant_id,provider' })
    .select('*')
    .single();
  if (error) return res.status(500).json({ ok: false, error: error.message });

  // Audit + OASIS
  await supabase.from('ai_consent_log').insert({
    user_id: null,
    tenant_id: tenantId,
    provider: body.provider,
    action: 'policy_update',
    before_jsonb: before ?? null,
    after_jsonb: after,
    actor_role: 'operator',
    actor_id: auth.user_id,
  });
  emitOasisEvent({
    vtid: VTID,
    type: 'integration.ai.policy.updated',
    source: 'gateway',
    status: 'success',
    message: `AI policy updated: tenant=${tenantId} provider=${body.provider}`,
    payload: { tenant_id: tenantId, provider: body.provider, before, after, actor_id: auth.user_id },
    actor_id: auth.user_id,
    actor_role: 'operator',
    surface: 'command-hub',
  }).catch(() => {});

  return res.json({ ok: true, policy: after });
});

// =============================================================================
// GET /connections — filterable connection list
// =============================================================================
router.get('/connections', async (req: Request, res: Response) => {
  const auth = requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const tenantParam = (req.query.tenant as string | undefined) || null;
  const provider = (req.query.provider as string | undefined) || null;
  const statusParam = (req.query.status as string | undefined) || null; // 'active' | 'inactive'

  let query = supabase
    .from('user_connections')
    .select('id, tenant_id, user_id, connector_id, is_active, connected_at, disconnected_at, last_error')
    .eq('category', 'ai_assistant')
    .order('connected_at', { ascending: false })
    .limit(200);

  if (tenantParam) {
    let tenantId = tenantParam;
    if (!/^[0-9a-fA-F-]{36}$/.test(tenantParam)) {
      const { data: tRow } = await supabase.from('tenants').select('id').eq('slug', tenantParam).maybeSingle();
      if (tRow) tenantId = tRow.id;
    }
    query = query.eq('tenant_id', tenantId);
  }
  if (provider) query = query.eq('connector_id', provider);
  if (statusParam === 'active') query = query.eq('is_active', true);
  if (statusParam === 'inactive') query = query.eq('is_active', false);

  const { data, error } = await query;
  if (error) return res.status(500).json({ ok: false, error: error.message });

  const ids = (data ?? []).map((c) => c.id);
  let credMap = new Map<string, { key_prefix: string; key_last4: string; last_verified_at: string | null; last_verify_status: string | null }>();
  if (ids.length > 0) {
    const { data: creds } = await supabase
      .from('ai_assistant_credentials')
      .select('connection_id, key_prefix, key_last4, last_verified_at, last_verify_status')
      .in('connection_id', ids);
    credMap = new Map(
      (creds ?? []).map((c) => [
        c.connection_id,
        {
          key_prefix: c.key_prefix,
          key_last4: c.key_last4,
          last_verified_at: c.last_verified_at,
          last_verify_status: c.last_verify_status,
        },
      ])
    );
  }

  const connections = (data ?? []).map((c) => {
    const cred = credMap.get(c.id);
    return {
      connection_id: c.id,
      tenant_id: c.tenant_id,
      user_id: c.user_id,
      provider: c.connector_id,
      is_active: c.is_active,
      connected_at: c.connected_at,
      disconnected_at: c.disconnected_at,
      key_prefix: cred?.key_prefix ?? null,
      key_last4: cred?.key_last4 ?? null,
      last_verified_at: cred?.last_verified_at ?? null,
      last_verify_status: cred?.last_verify_status ?? null,
    };
  });
  return res.json({ ok: true, connections });
});

// =============================================================================
// GET /consent-log — filterable consent events
// =============================================================================
router.get('/consent-log', async (req: Request, res: Response) => {
  const auth = requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const tenantParam = (req.query.tenant as string | undefined) || null;
  const userFilter = (req.query.user as string | undefined) || null;
  const providerFilter = (req.query.provider as string | undefined) || null;
  const limit = Math.min(parseInt((req.query.limit as string) || '100', 10) || 100, 500);

  let query = supabase.from('ai_consent_log').select('*').order('ts', { ascending: false }).limit(limit);
  if (tenantParam) {
    let tenantId = tenantParam;
    if (!/^[0-9a-fA-F-]{36}$/.test(tenantParam)) {
      const { data: tRow } = await supabase.from('tenants').select('id').eq('slug', tenantParam).maybeSingle();
      if (tRow) tenantId = tRow.id;
    }
    query = query.eq('tenant_id', tenantId);
  }
  if (userFilter) query = query.eq('user_id', userFilter);
  if (providerFilter) query = query.eq('provider', providerFilter);

  const { data, error } = await query;
  if (error) {
    console.error(`${LOG_PREFIX} GET /consent-log err`, error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
  return res.json({ ok: true, log: data ?? [] });
});

export default router;
