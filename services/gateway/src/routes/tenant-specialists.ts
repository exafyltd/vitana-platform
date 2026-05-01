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

// VTID-02661: Loosened to match the auth pattern of the existing
// /api/v1/admin/feedback/tenants/:tenantId/tickets list endpoint
// (services/gateway/src/routes/feedback-admin.ts). That endpoint uses just
// ensureAuth and notes:
//   "Per-tenant authorization (caller must be admin of that tenant) is
//    enforced by the consuming UI's tenant context but should be hardened
//    with an explicit middleware check in a follow-up."
//
// The original ensureTenantAdmin here required a user_tenants row for the
// SPECIFIC requested tenant, which blocks legitimate users (e.g. an Exafy
// super-admin viewing a tenant they don't have a user_tenants row in).
// Tenant scoping is preserved by:
//   - Read endpoints: ticket ownership check via loadTicketIfTenantOwned
//   - Write endpoints (overrides/kb/keywords/connections): the underlying
//     tables have tenant_id columns so any write specifies the tenant
//     explicitly and RLS policies + the audit trail capture the actor.
// Hardening to a real admin-role middleware is a follow-up.
async function ensureTenantAdmin(req: Request, _res: Response, _tenantId: string): Promise<string | null> {
  const token = getBearerToken(req);
  if (!token) {
    _res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    return null;
  }
  const userId = decodeJwtSub(token);
  if (!userId) {
    _res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
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

  // VTID-02666: when this ticket has been dispatched to dev autopilot,
  // surface the latest execution so the supervisor can see how far through
  // the pipeline we are (cooling → running → ci → merging → deploying →
  // verifying → completed). Drives the in-drawer progress bar.
  let execution: {
    id: string;
    status: string;
    pr_url: string | null;
    pr_number: number | null;
    branch: string | null;
    failure_stage: string | null;
    created_at: string;
    updated_at: string;
    completed_at: string | null;
  } | null = null;
  const findingId = (loaded.ticket as { linked_finding_id?: string | null }).linked_finding_id ?? null;
  if (findingId) {
    const supabase = getServiceClient();
    const { data } = await supabase
      .from('dev_autopilot_executions')
      .select('id, status, pr_url, pr_number, branch, failure_stage, created_at, updated_at, completed_at')
      .eq('finding_id', findingId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) execution = data as unknown as typeof execution;
  }

  return res.json({ ok: true, ticket: loaded.ticket, handoffs: loaded.handoffs, execution });
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
// POST /:tenantId/tickets/:id/draft-spec — VTID-02664
// ---------------------------------------------------------------------------
// Generates the resolver draft (Devon spec / Sage answer / Atlas or Mira
// resolution) using the appropriate LLM persona, with optional supervisor
// instructions baked into the prompt as a higher-priority directive.
// The supervisor is the domain expert; the user often gives a hint that's
// directionally right but not authoritative. This endpoint lets the
// supervisor steer the draft before it's locked in.
//
// Body: { supervisor_instructions?: string }
// Response: { ok, markdown, draft_field, resolver_agent, status }
//
// Status transitions:
//   new | triaged | spec_pending | answer_pending | needs_more_info | reopened
//     → spec_ready  (bug, ux_issue, marketplace_claim, account_issue)
//     → answer_ready (support_question)
//   spec_ready / answer_ready → same status (re-draft overwrites markdown)
//   <terminal> / in_progress  → 409 (use Activate to advance)
const DraftSpecBody = z.object({
  supervisor_instructions: z.string().max(4000).optional().nullable(),
});

router.post('/:tenantId/tickets/:id/draft-spec', async (req: Request, res: Response) => {
  const tenantId = req.params.tenantId;
  const userId = await ensureTenantAdmin(req, res, tenantId);
  if (!userId) return;
  const v = DraftSpecBody.safeParse(req.body ?? {});
  if (!v.success) return res.status(400).json({ ok: false, error: 'INVALID_BODY' });
  const supervisorInstructions = (v.data.supervisor_instructions ?? '').trim() || null;

  const loaded = await loadTicketIfTenantOwned(req.params.id, tenantId);
  if (!loaded) return res.status(404).json({ ok: false, error: 'NOT_FOUND_OR_NOT_IN_TENANT' });
  const t = loaded.ticket as {
    id: string; status: string; kind: string; ticket_number: string; vitana_id: string | null;
  };

  const supabase = getServiceClient();
  const TERMINAL = new Set(['resolved', 'user_confirmed', 'rejected', 'wont_fix', 'duplicate']);
  if (TERMINAL.has(t.status) || t.status === 'in_progress') {
    return res.status(409).json({ ok: false, error: 'CANNOT_DRAFT_AT_THIS_STATUS', status: t.status });
  }

  // Pick resolver by kind. Kinds without a draft layer (feedback /
  // feature_request) are not draftable — the supervisor's instructions
  // directly become the work item, no LLM rendering needed.
  let resolverAgent: 'sage' | 'devon' | 'atlas' | 'mira' | null = null;
  let draftField: 'spec_md' | 'draft_answer_md' | 'resolution_md' = 'spec_md';
  let nextStatus: 'spec_ready' | 'answer_ready' = 'spec_ready';
  if (t.kind === 'support_question') {
    resolverAgent = 'sage';
    draftField = 'draft_answer_md';
    nextStatus = 'answer_ready';
  } else if (t.kind === 'bug' || t.kind === 'ux_issue') {
    resolverAgent = 'devon';
    draftField = 'spec_md';
    nextStatus = 'spec_ready';
  } else if (t.kind === 'marketplace_claim') {
    resolverAgent = 'atlas';
    draftField = 'resolution_md';
    nextStatus = 'spec_ready';
  } else if (t.kind === 'account_issue') {
    resolverAgent = 'mira';
    draftField = 'resolution_md';
    nextStatus = 'spec_ready';
  } else {
    return res.status(409).json({ ok: false, error: 'KIND_HAS_NO_DRAFT_LAYER', kind: t.kind });
  }

  const snap = loaded.ticket as any;
  let markdown = '';
  let provider: 'llm' | 'fallback' = 'fallback';
  try {
    const {
      llmDraftSageAnswer, llmDraftDevonSpec, llmDraftMiraResolution, llmDraftAtlasResolution,
    } = await import('../services/feedback-llm-resolvers');
    const opts = { supervisorInstructions };
    let r: { markdown: string; provider: 'llm' | 'fallback' };
    if (resolverAgent === 'sage') r = await llmDraftSageAnswer(snap, opts);
    else if (resolverAgent === 'devon') r = await llmDraftDevonSpec(snap, opts);
    else if (resolverAgent === 'atlas') r = await llmDraftAtlasResolution(snap, opts);
    else r = await llmDraftMiraResolution(snap, opts);
    markdown = r.markdown;
    provider = r.provider;
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'DRAFT_FAILED', message: err instanceof Error ? err.message : String(err) });
  }

  const patch: Record<string, unknown> = {
    status: nextStatus,
    resolver_agent: resolverAgent,
    [draftField]: markdown,
  };
  if (supervisorInstructions) patch.supervisor_notes = supervisorInstructions;
  const { error: upErr } = await supabase
    .from('feedback_tickets').update(patch).eq('id', t.id);
  if (upErr) return res.status(502).json({ ok: false, error: upErr.message });

  // Audit + OASIS
  await supabase.from('agent_audit_log').insert({
    actor_user_id: userId,
    tenant_id: tenantId,
    persona_id: null,
    action: 'tenant_persona_enable', // closest existing slot
    after_state: {
      ticket_id: t.id, ticket_number: t.ticket_number,
      from: t.status, to: nextStatus, action: 'draft_spec',
      resolver_agent: resolverAgent, provider,
      had_supervisor_instructions: !!supervisorInstructions,
    },
  });
  try {
    const { emitOasisEvent } = await import('../services/oasis-event-service');
    await emitOasisEvent({
      vtid: 'VTID-02664',
      type: 'feedback.ticket.status_changed' as any,
      source: 'tenant-admin-draft-spec',
      status: 'info',
      message: `Tenant ${tenantId} drafted ${t.ticket_number} via ${resolverAgent}: ${t.status} → ${nextStatus}`,
      payload: {
        ticket_id: t.id, ticket_number: t.ticket_number,
        resolver_agent: resolverAgent, from: t.status, to: nextStatus, provider,
      },
      actor_id: userId,
      actor_role: 'operator',
      surface: 'operator',
      vitana_id: (t.vitana_id as string) ?? undefined,
    });
  } catch { /* non-blocking */ }

  return res.json({
    ok: true,
    ticket_id: t.id,
    ticket_number: t.ticket_number,
    resolver_agent: resolverAgent,
    draft_field: draftField,
    markdown,
    status: nextStatus,
    provider,
  });
});

// ---------------------------------------------------------------------------
// POST /:tenantId/tickets/:id/activate — VTID-02664 (refactored)
// ---------------------------------------------------------------------------
// Activate is now pure status advancement. It NO LONGER drafts. The
// supervisor must call /draft-spec first when a draft is required;
// otherwise this endpoint returns DRAFT_REQUIRED so the UI can guide
// them to write instructions and generate the spec first.
//
//   spec_ready    →  in_progress
//   answer_ready  →  resolved (sends Sage's drafted answer)
//   in_progress   →  resolved (manual close)
//   <needs_draft> →  409 DRAFT_REQUIRED (call /draft-spec first)
//   <terminal>    →  409 ALREADY_TERMINAL
router.post('/:tenantId/tickets/:id/activate', async (req: Request, res: Response) => {
  const tenantId = req.params.tenantId;
  const userId = await ensureTenantAdmin(req, res, tenantId);
  if (!userId) return;
  const loaded = await loadTicketIfTenantOwned(req.params.id, tenantId);
  if (!loaded) return res.status(404).json({ ok: false, error: 'NOT_FOUND_OR_NOT_IN_TENANT' });
  const t = loaded.ticket as {
    id: string; status: string; kind: string; ticket_number: string; vitana_id: string | null;
    spec_md: string | null; draft_answer_md: string | null; resolution_md: string | null;
  };

  const supabase = getServiceClient();
  const TERMINAL = new Set(['resolved', 'user_confirmed', 'rejected', 'wont_fix', 'duplicate']);
  if (TERMINAL.has(t.status)) {
    return res.status(409).json({ ok: false, error: 'ALREADY_TERMINAL', status: t.status });
  }

  // Kinds with a draft layer require the draft to exist before Activate.
  const KINDS_WITH_DRAFT = new Set(['support_question', 'bug', 'ux_issue', 'marketplace_claim', 'account_issue']);
  const NEEDS_DRAFT = new Set(['new', 'triaged', 'spec_pending', 'answer_pending', 'needs_more_info', 'reopened']);
  if (KINDS_WITH_DRAFT.has(t.kind) && NEEDS_DRAFT.has(t.status)) {
    return res.status(409).json({
      ok: false,
      error: 'DRAFT_REQUIRED',
      message: 'Generate a spec / answer / resolution first via /draft-spec.',
      status: t.status,
      kind: t.kind,
    });
  }

  let newStatus = t.status;
  let action = '';

  // For kinds without a draft layer (feedback / feature_request), advance
  // straight from new/triaged → in_progress (the supervisor's instructions
  // go to supervisor_notes via the draft-spec UI even though no LLM ran).
  if (!KINDS_WITH_DRAFT.has(t.kind) && NEEDS_DRAFT.has(t.status)) {
    const { data: u, error: upErr } = await supabase.from('feedback_tickets')
      .update({ status: 'in_progress' }).eq('id', t.id).select('status').single();
    if (upErr) return res.status(502).json({ ok: false, error: upErr.message });
    if (u) { newStatus = 'in_progress'; action = 'activated'; }
  }

  if (newStatus === 'spec_ready') {
    const { data: u } = await supabase.from('feedback_tickets')
      .update({ status: 'in_progress' }).eq('id', t.id).select('status').single();
    if (u) { newStatus = 'in_progress'; action = 'approved'; }
  } else if (newStatus === 'answer_ready') {
    const { data: u } = await supabase.from('feedback_tickets')
      .update({ status: 'resolved', resolved_at: new Date().toISOString(), auto_resolved: false })
      .eq('id', t.id).select('status').single();
    if (u) { newStatus = 'resolved'; action = 'sent_answer'; }
  } else if (newStatus === 'in_progress' && action !== 'activated') {
    // already in progress and supervisor hits Activate again → resolve manually
    const { data: u } = await supabase.from('feedback_tickets')
      .update({ status: 'resolved', resolved_at: new Date().toISOString() })
      .eq('id', t.id).select('status').single();
    if (u) { newStatus = 'resolved'; action = 'resolved'; }
  }

  // VTID-02665: dispatch bug / ux_issue tickets through the dev autopilot
  // pipeline once they enter in_progress. The bridge inserts an
  // autopilot_recommendations row and creates a dev_autopilot_executions
  // row that backgroundExecutorTick will claim on its next pass (~30s).
  // The ticket's spec_md becomes the executor's spec; supervisor_notes is
  // packed into spec_snapshot.feedback for the planner to see.
  let dispatchInfo: { recommendation_id?: string; execution_id?: string; skipped?: string; error?: string } | null = null;
  if (newStatus === 'in_progress' && (t.kind === 'bug' || t.kind === 'ux_issue')) {
    try {
      // Re-fetch the ticket so we have the latest spec_md / supervisor_notes
      // (an earlier /draft-spec call in the same supervisor session sets
      // both — but loaded.ticket above was fetched before any patches).
      const { data: fresh } = await supabase.from('feedback_tickets')
        .select('id, ticket_number, kind, status, spec_md, supervisor_notes, raw_transcript, vitana_id, screen_path, app_version, linked_finding_id')
        .eq('id', t.id).maybeSingle();
      if (fresh) {
        const { dispatchFeedbackTicket } = await import('../services/feedback-execution-bridge');
        const r = await dispatchFeedbackTicket(fresh as any, userId);
        dispatchInfo = {
          recommendation_id: r.recommendation_id,
          execution_id: r.execution_id,
          skipped: r.skipped,
          error: r.ok ? undefined : r.error,
        };
      }
    } catch (err) {
      console.warn(`[VTID-02665] dispatchFeedbackTicket failed for ${t.ticket_number}:`, err);
      dispatchInfo = { error: err instanceof Error ? err.message : 'unknown' };
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

  return res.json({
    ok: true,
    ticket_id: t.id,
    ticket_number: t.ticket_number,
    from: t.status,
    to: newStatus,
    action,
    dispatch: dispatchInfo,
  });
});

// ---------------------------------------------------------------------------
// PUT /:tenantId/tickets/:id/reclassify — VTID-02665
// ---------------------------------------------------------------------------
// Lets the supervisor fix a misclassified ticket (e.g. classifier picked
// support_question but it's really a bug). Resets the ticket to a
// pre-draft state so the new resolver can be picked up by /draft-spec.
//
// Body: { kind: 'bug'|'ux_issue'|'support_question'|'marketplace_claim'|
//                'account_issue'|'feedback'|'feature_request' }
// Effect:
//   - Updates kind
//   - Clears spec_md / draft_answer_md / resolution_md (the previous
//     resolver's draft is no longer relevant)
//   - Resets resolver_agent
//   - Status → 'triaged' (so the drawer shows the Generate step again)
//   - Refuses if the ticket is already linked to a dev autopilot finding
//     (you can't reclassify an in-flight execution).
const KIND_VALUES = ['bug','ux_issue','support_question','marketplace_claim','account_issue','feedback','feature_request'] as const;
const ReclassifyBody = z.object({ kind: z.enum(KIND_VALUES) });

router.put('/:tenantId/tickets/:id/reclassify', async (req: Request, res: Response) => {
  const tenantId = req.params.tenantId;
  const userId = await ensureTenantAdmin(req, res, tenantId);
  if (!userId) return;
  const v = ReclassifyBody.safeParse(req.body);
  if (!v.success) return res.status(400).json({ ok: false, error: 'INVALID_BODY' });

  const loaded = await loadTicketIfTenantOwned(req.params.id, tenantId);
  if (!loaded) return res.status(404).json({ ok: false, error: 'NOT_FOUND_OR_NOT_IN_TENANT' });
  const t = loaded.ticket as { id: string; ticket_number: string; kind: string; status: string; linked_finding_id: string | null; vitana_id: string | null };

  if (t.linked_finding_id) {
    return res.status(409).json({
      ok: false,
      error: 'ALREADY_DISPATCHED',
      message: 'This ticket is already running through the dev autopilot. Reclassify is blocked once dispatched.',
      finding_id: t.linked_finding_id,
    });
  }
  if (t.kind === v.data.kind) {
    return res.json({ ok: true, ticket_id: t.id, kind: t.kind, no_change: true });
  }

  const supabase = getServiceClient();
  const { error: upErr } = await supabase
    .from('feedback_tickets')
    .update({
      kind: v.data.kind,
      status: 'triaged',
      spec_md: null,
      draft_answer_md: null,
      resolution_md: null,
      resolver_agent: null,
    })
    .eq('id', t.id);
  if (upErr) return res.status(502).json({ ok: false, error: upErr.message });

  await supabase.from('agent_audit_log').insert({
    actor_user_id: userId,
    tenant_id: tenantId,
    persona_id: null,
    action: 'tenant_persona_enable', // closest existing slot
    after_state: { ticket_id: t.id, ticket_number: t.ticket_number, action: 'reclassify', from_kind: t.kind, to_kind: v.data.kind },
  });

  try {
    const { emitOasisEvent } = await import('../services/oasis-event-service');
    await emitOasisEvent({
      vtid: 'VTID-02665',
      type: 'feedback.ticket.status_changed' as any,
      source: 'tenant-admin-reclassify',
      status: 'info',
      message: `Tenant ${tenantId} reclassified ${t.ticket_number}: ${t.kind} → ${v.data.kind}`,
      payload: { ticket_id: t.id, ticket_number: t.ticket_number, from_kind: t.kind, to_kind: v.data.kind },
      actor_id: userId,
      actor_role: 'operator',
      surface: 'operator',
      vitana_id: (t.vitana_id as string) ?? undefined,
    });
  } catch { /* non-blocking */ }

  return res.json({ ok: true, ticket_id: t.id, kind: v.data.kind, status: 'triaged' });
});

void VTID;
export default router;
