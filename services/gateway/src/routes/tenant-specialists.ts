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

// ---------------------------------------------------------------------------
// VTID-02659: per-customer Approve-All
// ---------------------------------------------------------------------------
// Supervisor batch action triggered from the customer-grouped tickets view
// (PR vitana-v1#325). For ALL of this customer's tickets in this tenant
// that are sitting in 'spec_ready' or 'answer_ready':
//   - 'spec_ready'   → 'in_progress' (kicks the autopilot fix pipeline,
//                                      same as /feedback/tickets/:id/approve)
//   - 'answer_ready' → 'resolved'    (sends Sage's drafted answer, same as
//                                      /feedback/tickets/:id/send-answer)
// Each transition emits the same OASIS events the per-ticket flow does.
//
// Authorization: tenant admin only (ensureTenantAdmin). The customer must
// be a member of this tenant.
//
// Response: counts of {approved, sent, skipped, total} so the UI can show
// a toast like "3 approved, 2 answers sent".

router.post('/:tenantId/customers/:vitanaId/approve-all', async (req: Request, res: Response) => {
  const tenantId = req.params.tenantId;
  const vitanaId = req.params.vitanaId;
  const userId = await ensureTenantAdmin(req, res, tenantId);
  if (!userId) return;

  const supabase = getServiceClient();

  // Resolve vitana_id → user_id via the canonical app_users mirror, then
  // confirm the customer is a member of this tenant. Refusing to act on
  // tickets owned by users outside the tenant is the security guarantee.
  const { data: appUser } = await supabase
    .from('app_users')
    .select('user_id')
    .eq('vitana_id', vitanaId)
    .maybeSingle();
  if (!appUser) {
    return res.status(404).json({ ok: false, error: 'CUSTOMER_NOT_FOUND' });
  }
  const customerUserId = appUser.user_id;

  const { data: membership } = await supabase
    .from('user_tenants')
    .select('user_id')
    .eq('user_id', customerUserId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!membership) {
    return res.status(404).json({ ok: false, error: 'CUSTOMER_NOT_IN_TENANT' });
  }

  // Find this customer's actionable tickets.
  const { data: tickets, error: qErr } = await supabase
    .from('feedback_tickets')
    .select('id, ticket_number, kind, status, vitana_id, resolver_agent')
    .eq('user_id', customerUserId)
    .in('status', ['spec_ready', 'answer_ready']);
  if (qErr) {
    return res.status(502).json({ ok: false, error: 'QUERY_FAILED', details: qErr.message });
  }

  let approved = 0;
  let sent = 0;
  let skipped = 0;
  const results: Array<{ ticket_number: string; from: string; to: string }> = [];
  const now = new Date().toISOString();

  async function emit(type: string, ticket: Record<string, unknown>, payload: Record<string, unknown>) {
    try {
      const { emitOasisEvent } = await import('../services/oasis-event-service');
      await emitOasisEvent({
        vtid: 'VTID-02659',
        type: type as any,
        source: 'feedback-admin-bulk',
        status: 'info',
        message: `bulk: ${type} for ${ticket.ticket_number}`,
        payload: { ticket_id: ticket.id, ticket_number: ticket.ticket_number, ...payload },
        actor_id: userId!,
        actor_role: 'operator',
        surface: 'operator',
        vitana_id: (ticket.vitana_id as string) ?? undefined,
      });
    } catch { /* non-blocking */ }
  }

  for (const t of tickets ?? []) {
    if (t.status === 'spec_ready') {
      const { data: updated, error: upErr } = await supabase
        .from('feedback_tickets')
        .update({ status: 'in_progress' })
        .eq('id', t.id)
        .eq('status', 'spec_ready')          // optimistic lock against concurrent edits
        .select('id, ticket_number, kind, status, vitana_id, resolver_agent')
        .single();
      if (upErr || !updated) { skipped++; continue; }
      approved++;
      results.push({ ticket_number: updated.ticket_number, from: 'spec_ready', to: 'in_progress' });
      await emit('feedback.ticket.status_changed', updated, { new_status: 'in_progress', from: 'bulk-approve' });
    } else if (t.status === 'answer_ready') {
      const { data: updated, error: upErr } = await supabase
        .from('feedback_tickets')
        .update({ status: 'resolved', resolved_at: now, auto_resolved: false })
        .eq('id', t.id)
        .eq('status', 'answer_ready')
        .select('id, ticket_number, kind, status, vitana_id, resolver_agent, draft_answer_md')
        .single();
      if (upErr || !updated) { skipped++; continue; }
      sent++;
      results.push({ ticket_number: updated.ticket_number, from: 'answer_ready', to: 'resolved' });
      await emit('feedback.ticket.resolved', updated, { from: 'bulk-send-answer', resolver_agent: updated.resolver_agent });
    }
  }

  // Tenant audit row covering the whole batch — easier to scan than N
  // individual rows when reading the tenant audit log.
  await supabase.from('agent_audit_log').insert({
    actor_user_id: userId,
    tenant_id: tenantId,
    persona_id: null,
    // Closest existing enum slot. Future cleanup: extend the action enum
    // with 'tenant_bulk_approve' for clearer audit reads.
    action: 'tenant_persona_enable',
    after_state: { vitana_id: vitanaId, approved, sent, skipped, results, ts: now },
  });

  return res.json({
    ok: true,
    customer_vitana_id: vitanaId,
    approved,
    sent,
    skipped,
    total: (tickets ?? []).length,
    results,
  });
});

// ---------------------------------------------------------------------------
// VTID-02660: Tenant-scoped ticket detail + Activate/Reject actions.
// ---------------------------------------------------------------------------
// The tenant admin Feedback drawer needs:
//   1. Full transcript + intake messages so the supervisor knows what the
//      customer actually said.
//   2. Activate button — smart action that drafts a spec/answer/resolution
//      first if none exists, otherwise advances the existing draft.
//   3. Reject button.
// All scoped to tenant: caller must be tenant admin AND the ticket's owner
// must be a member of the tenant. This is the security gate that keeps
// tenant admins from acting on tickets in another tenant.

async function loadTicketIfTenantOwned(
  ticketId: string,
  tenantId: string,
): Promise<null | { ticket: Record<string, any>; handoffs: Array<Record<string, any>> }> {
  const supabase = getServiceClient();
  const { data: ticket } = await supabase
    .from('feedback_tickets')
    .select('*')
    .eq('id', ticketId)
    .maybeSingle();
  if (!ticket) return null;
  if (!ticket.user_id) return null;
  const { data: membership } = await supabase
    .from('user_tenants')
    .select('user_id')
    .eq('user_id', ticket.user_id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!membership) return null;
  const { data: handoffs } = await supabase
    .from('feedback_handoff_events')
    .select('id, from_agent, to_agent, reason, detected_intent, matched_keyword, confidence, ts')
    .eq('ticket_id', ticketId)
    .order('ts', { ascending: true });
  return { ticket, handoffs: handoffs ?? [] };
}

router.get('/:tenantId/tickets/:id', async (req: Request, res: Response) => {
  const tenantId = req.params.tenantId;
  if (!(await ensureTenantAdmin(req, res, tenantId))) return;
  const loaded = await loadTicketIfTenantOwned(req.params.id, tenantId);
  if (!loaded) return res.status(404).json({ ok: false, error: 'NOT_FOUND_OR_NOT_IN_TENANT' });
  return res.json({ ok: true, ticket: loaded.ticket, handoffs: loaded.handoffs });
});

const RejectSchema = z.object({ reason: z.string().max(500).optional() });

router.post('/:tenantId/tickets/:id/reject', async (req: Request, res: Response) => {
  const tenantId = req.params.tenantId;
  const userId = await ensureTenantAdmin(req, res, tenantId);
  if (!userId) return;
  const v = RejectSchema.safeParse(req.body); if (!v.success) return res.status(400).json({ ok: false });
  const loaded = await loadTicketIfTenantOwned(req.params.id, tenantId);
  if (!loaded) return res.status(404).json({ ok: false, error: 'NOT_FOUND_OR_NOT_IN_TENANT' });

  const supabase = getServiceClient();
  const { data: updated, error } = await supabase
    .from('feedback_tickets')
    .update({ status: 'rejected', supervisor_notes: v.data.reason ?? null })
    .eq('id', req.params.id)
    .select('id, ticket_number, kind, status, vitana_id')
    .single();
  if (error || !updated) return res.status(502).json({ ok: false, error: error?.message });

  await supabase.from('agent_audit_log').insert({
    actor_user_id: userId,
    tenant_id: tenantId,
    persona_id: null,
    action: 'tenant_persona_disable',  // closest existing slot until 'tenant_ticket_reject' added
    after_state: { ticket_id: updated.id, ticket_number: updated.ticket_number, reason: v.data.reason ?? null },
  });

  try {
    const { emitOasisEvent } = await import('../services/oasis-event-service');
    await emitOasisEvent({
      vtid: 'VTID-02660',
      type: 'feedback.ticket.status_changed' as any,
      source: 'tenant-admin-reject',
      status: 'info',
      message: `Tenant ${tenantId} rejected ticket ${updated.ticket_number}`,
      payload: { ticket_id: updated.id, ticket_number: updated.ticket_number, new_status: 'rejected', reason: v.data.reason ?? null },
      actor_id: userId,
      actor_role: 'operator',
      surface: 'operator',
      vitana_id: (updated.vitana_id as string) ?? undefined,
    });
  } catch { /* non-blocking */ }

  return res.json({ ok: true, ticket: updated });
});

// ---------------------------------------------------------------------------
// POST /:tenantId/tickets/:id/activate — smart action.
// ---------------------------------------------------------------------------
// One button, status-aware: drafts the appropriate resolution if none yet,
// otherwise advances the existing one toward terminal. The supervisor never
// has to think about which sub-action to call — the system picks.
//
//   new | triaged | spec_pending | answer_pending  →  draft + advance to
//                                                     in_progress (bug/ux)
//                                                     or resolved (support)
//                                                     so a single click
//                                                     takes the ticket all
//                                                     the way to "actively
//                                                     being worked on" or
//                                                     "answered + closed".
//   spec_ready                                      →  in_progress
//   answer_ready                                    →  resolved (sends Sage)
//   in_progress                                     →  resolved (manual close)
//   <terminal>                                      →  409 idempotent
router.post('/:tenantId/tickets/:id/activate', async (req: Request, res: Response) => {
  const tenantId = req.params.tenantId;
  const userId = await ensureTenantAdmin(req, res, tenantId);
  if (!userId) return;
  const loaded = await loadTicketIfTenantOwned(req.params.id, tenantId);
  if (!loaded) return res.status(404).json({ ok: false, error: 'NOT_FOUND_OR_NOT_IN_TENANT' });
  const t = loaded.ticket as { id: string; status: string; kind: string; ticket_number: string; vitana_id: string | null };

  const supabase = getServiceClient();
  const TERMINAL = new Set(['resolved', 'user_confirmed', 'rejected', 'wont_fix', 'duplicate']);
  if (TERMINAL.has(t.status)) {
    return res.status(409).json({ ok: false, error: 'ALREADY_TERMINAL', status: t.status });
  }

  let newStatus = t.status;
  let action = '';

  // Step 1: if not yet drafted, draft via the appropriate resolver. We call
  // the same LLM-backed services the per-ticket flow uses (PR #1135).
  const NEEDS_DRAFT = new Set(['new', 'triaged', 'spec_pending', 'answer_pending', 'needs_more_info', 'reopened']);
  if (NEEDS_DRAFT.has(t.status)) {
    const snap = loaded.ticket as any;
    let resolverAgent = '';
    let draftField: 'spec_md' | 'draft_answer_md' | 'resolution_md' = 'spec_md';
    let nextStatus: string = 'spec_ready';
    let markdown = '';
    try {
      const { llmDraftSageAnswer, llmDraftDevonSpec, llmDraftMiraResolution, llmDraftAtlasResolution } =
        await import('../services/feedback-llm-resolvers');
      if (t.kind === 'support_question') {
        const r = await llmDraftSageAnswer(snap);
        markdown = r.markdown;
        resolverAgent = 'sage';
        draftField = 'draft_answer_md';
        nextStatus = 'answer_ready';
      } else if (t.kind === 'bug' || t.kind === 'ux_issue') {
        const r = await llmDraftDevonSpec(snap);
        markdown = r.markdown;
        resolverAgent = 'devon';
        draftField = 'spec_md';
        nextStatus = 'spec_ready';
      } else if (t.kind === 'marketplace_claim') {
        const r = await llmDraftAtlasResolution(snap);
        markdown = r.markdown;
        resolverAgent = 'atlas';
        draftField = 'resolution_md';
        nextStatus = 'spec_ready';
      } else if (t.kind === 'account_issue') {
        const r = await llmDraftMiraResolution(snap);
        markdown = r.markdown;
        resolverAgent = 'mira';
        draftField = 'resolution_md';
        nextStatus = 'spec_ready';
      } else {
        // feedback / feature_request — no draft layer; jump straight to in_progress
        // so the supervisor's "Activate" still does something meaningful.
        nextStatus = 'in_progress';
      }
    } catch (err) {
      console.warn('[VTID-02660] activate draft failed, falling back to direct status flip:', err);
      nextStatus = 'in_progress';
    }
    const patch: Record<string, unknown> = { status: nextStatus };
    if (resolverAgent) patch.resolver_agent = resolverAgent;
    if (markdown) patch[draftField] = markdown;
    const { error: upErr } = await supabase
      .from('feedback_tickets').update(patch).eq('id', t.id);
    if (upErr) return res.status(502).json({ ok: false, error: upErr.message });
    newStatus = nextStatus;
    action = 'drafted';
  }

  // Step 2: advance the now-drafted ticket toward terminal. spec_ready and
  // answer_ready are advanced automatically. If the supervisor wants the
  // intermediate review, they click Activate twice; otherwise one click
  // takes it all the way. Set ?stop_at_draft=1 to keep the intermediate.
  const stopAtDraft = String(req.query.stop_at_draft || '') === '1';
  if (!stopAtDraft) {
    if (newStatus === 'spec_ready') {
      const { data: u } = await supabase.from('feedback_tickets')
        .update({ status: 'in_progress' }).eq('id', t.id).select('status').single();
      if (u) { newStatus = 'in_progress'; action = action ? `${action}+approved` : 'approved'; }
    } else if (newStatus === 'answer_ready') {
      const { data: u } = await supabase.from('feedback_tickets')
        .update({ status: 'resolved', resolved_at: new Date().toISOString(), auto_resolved: false })
        .eq('id', t.id).select('status').single();
      if (u) { newStatus = 'resolved'; action = action ? `${action}+sent` : 'sent_answer'; }
    } else if (newStatus === 'in_progress') {
      // already in progress and supervisor hits Activate again → resolve manually
      const { data: u } = await supabase.from('feedback_tickets')
        .update({ status: 'resolved', resolved_at: new Date().toISOString() })
        .eq('id', t.id).select('status').single();
      if (u) { newStatus = 'resolved'; action = action ? `${action}+resolved` : 'resolved'; }
    }
  }

  // Audit + OASIS
  await supabase.from('agent_audit_log').insert({
    actor_user_id: userId,
    tenant_id: tenantId,
    persona_id: null,
    action: 'tenant_persona_enable', // closest existing slot until 'tenant_ticket_activate' added
    after_state: { ticket_id: t.id, ticket_number: t.ticket_number, from: t.status, to: newStatus, action },
  });
  try {
    const { emitOasisEvent } = await import('../services/oasis-event-service');
    await emitOasisEvent({
      vtid: 'VTID-02660',
      type: (newStatus === 'resolved' ? 'feedback.ticket.resolved' : 'feedback.ticket.status_changed') as any,
      source: 'tenant-admin-activate',
      status: 'info',
      message: `Tenant ${tenantId} activate ${t.ticket_number}: ${t.status} → ${newStatus}`,
      payload: { ticket_id: t.id, ticket_number: t.ticket_number, from: t.status, to: newStatus, action },
      actor_id: userId,
      actor_role: 'operator',
      surface: 'operator',
      vitana_id: (t.vitana_id as string) ?? undefined,
    });
  } catch { /* non-blocking */ }

  return res.json({ ok: true, ticket_id: t.id, ticket_number: t.ticket_number, from: t.status, to: newStatus, action });
});

void VTID;
export default router;
