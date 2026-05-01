/**
 * VTID-02605: Unified Feedback Pipeline — supervisor (Command Hub) admin routes
 * Parent plan PR 7.
 *
 * Endpoints (mounted at /api/v1/admin/feedback):
 * - GET  /tickets       — paginated list with filters
 * - GET  /tickets/:id   — full detail (transcript + messages + handoffs)
 * - GET  /handoffs/recent — recent handoff events (Live Handoffs panel)
 * - GET  /personas      — read-only roster (also feeds Specialists tab)
 * - GET  /kpis          — aggregate KPIs by kind / specialist / week
 *
 * Auth: requires authenticated user; service role used for cross-tenant
 * reads. The Command Hub is operator-only — TODO when role gating is wired,
 * add an explicit `developer` / `operator` role check here. For now, the
 * gateway's existing auth-supabase-jwt middleware enforces authentication.
 */

import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';

const router = Router();
const VTID = 'VTID-02605';

function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE missing');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function getBearerToken(req: Request): string | null {
  const h = req.headers.authorization;
  return h && h.startsWith('Bearer ') ? h.slice(7) : null;
}

function ensureAuth(req: Request, res: Response): boolean {
  if (!getBearerToken(req)) {
    res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// GET /tickets
// ---------------------------------------------------------------------------

router.get('/tickets', async (req: Request, res: Response) => {
  if (!ensureAuth(req, res)) return;
  const supabase = getServiceClient();

  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  const status = req.query.status as string | undefined;
  const kind = req.query.kind as string | undefined;
  const priority = req.query.priority as string | undefined;
  const surface = req.query.surface as string | undefined;
  const resolverAgent = req.query.resolver_agent as string | undefined;

  let q = supabase
    .from('feedback_tickets')
    .select('id, ticket_number, vitana_id, kind, status, priority, surface, raw_transcript, screen_path, app_version, classifier_meta, duplicate_of, resolver_agent, created_at, triaged_at, resolved_at, user_confirmed_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (status) q = q.eq('status', status);
  if (kind) q = q.eq('kind', kind);
  if (priority) q = q.eq('priority', priority);
  if (surface) q = q.eq('surface', surface);
  if (resolverAgent) q = q.eq('resolver_agent', resolverAgent);

  const { data, error } = await q;
  if (error) {
    console.error(`[${VTID}] tickets list failed:`, error.message);
    return res.status(502).json({ ok: false, error: 'QUERY_FAILED', details: error.message });
  }
  return res.json({ ok: true, tickets: data ?? [] });
});

// ---------------------------------------------------------------------------
// GET /tickets/:id
// ---------------------------------------------------------------------------

router.get('/tickets/:id', async (req: Request, res: Response) => {
  if (!ensureAuth(req, res)) return;
  const id = req.params.id;
  const supabase = getServiceClient();

  const { data: ticket, error } = await supabase
    .from('feedback_tickets')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error || !ticket) {
    return res.status(404).json({ ok: false, error: 'NOT_FOUND', details: error?.message });
  }

  const { data: handoffs } = await supabase
    .from('feedback_handoff_events')
    .select('id, from_agent, to_agent, reason, detected_intent, matched_keyword, confidence, ts')
    .eq('ticket_id', id)
    .order('ts', { ascending: true });

  const { data: similar } = ticket.duplicate_of
    ? await supabase.from('feedback_tickets').select('id, ticket_number, kind, status').eq('id', ticket.duplicate_of).maybeSingle().then(r => ({ data: r.data ? [r.data] : [] }))
    : { data: [] };

  return res.json({ ok: true, ticket, handoffs: handoffs ?? [], similar: similar ?? [] });
});

// ---------------------------------------------------------------------------
// GET /handoffs/recent
// ---------------------------------------------------------------------------

router.get('/handoffs/recent', async (req: Request, res: Response) => {
  if (!ensureAuth(req, res)) return;
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from('feedback_handoff_events')
    .select('id, conversation_id, ticket_id, vitana_id, from_agent, to_agent, reason, detected_intent, matched_keyword, confidence, ts')
    .order('ts', { ascending: false })
    .limit(limit);

  if (error) {
    return res.status(502).json({ ok: false, error: 'QUERY_FAILED', details: error.message });
  }
  return res.json({ ok: true, handoffs: data ?? [] });
});

// ---------------------------------------------------------------------------
// GET /personas
// ---------------------------------------------------------------------------

router.get('/personas', async (req: Request, res: Response) => {
  if (!ensureAuth(req, res)) return;
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('agent_personas')
    .select('id, key, display_name, role, voice_id, voice_sample_url, system_prompt, intake_schema_ref, handles_kinds, handoff_keywords, max_questions, max_duration_seconds, status, version, updated_at')
    .order('key');
  if (error) return res.status(502).json({ ok: false, error: 'QUERY_FAILED', details: error.message });
  return res.json({ ok: true, personas: data ?? [] });
});

// ---------------------------------------------------------------------------
// GET /kpis
// ---------------------------------------------------------------------------

router.get('/kpis', async (req: Request, res: Response) => {
  if (!ensureAuth(req, res)) return;
  const supabase = getServiceClient();

  // Total counts by status
  const { data: byStatus } = await supabase
    .from('feedback_tickets')
    .select('status')
    .gte('created_at', new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString());

  const { data: byKind } = await supabase
    .from('feedback_tickets')
    .select('kind')
    .gte('created_at', new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString());

  const { data: byResolver } = await supabase
    .from('feedback_tickets')
    .select('resolver_agent')
    .not('resolver_agent', 'is', null)
    .gte('created_at', new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString());

  const { data: handoffCount } = await supabase
    .from('feedback_handoff_events')
    .select('to_agent', { count: 'exact', head: false })
    .gte('ts', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString());

  const tally = (rows: Array<Record<string, unknown>> | null, col: string): Record<string, number> => {
    const t: Record<string, number> = {};
    (rows ?? []).forEach(r => { const k = String(r[col] ?? 'unknown'); t[k] = (t[k] ?? 0) + 1; });
    return t;
  };

  return res.json({
    ok: true,
    window: '30d',
    by_status: tally(byStatus as Array<Record<string, unknown>> | null, 'status'),
    by_kind: tally(byKind as Array<Record<string, unknown>> | null, 'kind'),
    by_resolver: tally(byResolver as Array<Record<string, unknown>> | null, 'resolver_agent'),
    handoffs_7d: tally(handoffCount as Array<Record<string, unknown>> | null, 'to_agent'),
  });
});

// ---------------------------------------------------------------------------
// GET /tenants/:tenantId/tickets   — tenant-scoped read for tenant admins
// ---------------------------------------------------------------------------
// Joins user_tenants → app_users → feedback_tickets. Returns only tickets
// whose user_id is a member of the requested tenant. Used by the vitana-v1
// /admin/feedback screen (PR 25 baseline).
//
// SECURITY NOTE: This endpoint currently authenticates only (any logged-in
// user passes). Per-tenant authorization (caller must be admin of that
// tenant) is enforced by the consuming UI's tenant context but should be
// hardened with an explicit middleware check in a follow-up.

router.get('/tenants/:tenantId/tickets', async (req: Request, res: Response) => {
  if (!ensureAuth(req, res)) return;
  const tenantId = req.params.tenantId;
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  const supabase = getServiceClient();

  // Get the user_ids in this tenant
  const { data: members, error: memErr } = await supabase
    .from('user_tenants')
    .select('user_id')
    .eq('tenant_id', tenantId);

  if (memErr) {
    return res.status(502).json({ ok: false, error: 'TENANT_LOOKUP_FAILED', details: memErr.message });
  }

  const userIds = (members ?? []).map(m => m.user_id);
  if (userIds.length === 0) {
    return res.json({ ok: true, tickets: [] });
  }

  const { data, error } = await supabase
    .from('feedback_tickets')
    .select('id, ticket_number, vitana_id, kind, status, priority, surface, screen_path, app_version, resolver_agent, created_at, resolved_at, user_confirmed_at')
    .in('user_id', userIds)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    return res.status(502).json({ ok: false, error: 'QUERY_FAILED', details: error.message });
  }

  // VTID-02659: enrich with avatar_url + display_name from profiles so the
  // tenant admin Feedback page can render real customer photos on the
  // grouped-by-customer view (PR vitana-v1#325) instead of just initials.
  // Single batch query keyed by unique vitana_ids (~1 req regardless of
  // ticket count).
  const tickets = data ?? [];
  const uniqueVitanaIds = [...new Set(tickets.map(t => t.vitana_id).filter((v): v is string => !!v))];
  let profilesByVitanaId: Record<string, { avatar_url: string | null; display_name: string | null }> = {};
  if (uniqueVitanaIds.length > 0) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('vitana_id, avatar_url, display_name')
      .in('vitana_id', uniqueVitanaIds);
    for (const p of profiles ?? []) {
      const r = p as { vitana_id: string; avatar_url: string | null; display_name: string | null };
      profilesByVitanaId[r.vitana_id] = {
        avatar_url: r.avatar_url ?? null,
        display_name: r.display_name ?? null,
      };
    }
  }
  const enriched = tickets.map(t => {
    const prof = t.vitana_id ? profilesByVitanaId[t.vitana_id] : null;
    return {
      ...t,
      avatar_url: prof?.avatar_url ?? null,
      display_name: prof?.display_name ?? null,
    };
  });
  return res.json({ ok: true, tickets: enriched, member_count: userIds.length });
});

// ---------------------------------------------------------------------------
// GET /tenants/:tenantId/personas — public-safe roster for tenant admins
// ---------------------------------------------------------------------------
// Same data as /personas but strips operator-only fields (system_prompt,
// handoff_keywords) so tenant admins see who Vitana hands off to without
// seeing prompt internals.

router.get('/tenants/:tenantId/personas', async (req: Request, res: Response) => {
  if (!ensureAuth(req, res)) return;
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('agent_personas')
    .select('key, display_name, role, voice_id, voice_sample_url, handles_kinds, status, version, updated_at')
    .eq('status', 'active')
    .order('key');
  if (error) return res.status(502).json({ ok: false, error: 'QUERY_FAILED', details: error.message });
  return res.json({ ok: true, personas: data ?? [] });
});

export default router;
