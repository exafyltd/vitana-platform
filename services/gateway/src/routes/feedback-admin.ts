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
 * Auth: requires exafy_admin (Command Hub operator). Enforced via
 * requireAdminAuth, which verifies the JWT signature and app_metadata.
 * exafy_admin=true — see SECURITY note below.
 */

import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { requireAdminAuth } from '../middleware/auth-supabase-jwt';
import * as repo from './feedback-admin-repository';

const router = Router();
const VTID = 'VTID-02605';

// SECURITY (post-audit hardening): every route below reads cross-tenant
// data via the service-role client (support transcripts, persona system
// prompts, handoff events). Previously gated by ensureAuth(), which only
// checked that an Authorization header was PRESENT — the token itself was
// never verified, so `Authorization: Bearer anything` was sufficient to
// dump every tenant's feedback tickets. requireAdminAuth verifies the JWT
// signature and requires exafy_admin, matching this file's own stated
// intent ("The Command Hub is operator-only").
router.use(requireAdminAuth);

function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE missing');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// VTID-02659: produce a short, readable excerpt for the tenant ticket list.
// raw_transcript may be a structured JSON-string of message turns or plain
// text. Pull the first user-spoken sentence (or the leading text) and clamp
// to ~200 chars so the supervisor can prioritise without opening the drawer.
function excerptFromTranscript(raw: string | null): string | null {
  if (!raw) return null;
  let text = raw.trim();
  if (!text) return null;
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      const turns = Array.isArray(parsed) ? parsed : [parsed];
      const first = turns.find(
        (t: any) => t && (t.role === 'user' || t.speaker === 'user' || t.from === 'user'),
      ) ?? turns[0];
      const candidate = first?.text ?? first?.content ?? first?.message ?? null;
      if (typeof candidate === 'string' && candidate.trim()) text = candidate.trim();
    } catch {
      // fall through with raw text
    }
  }
  text = text.replace(/\s+/g, ' ');
  if (text.length <= 200) return text;
  return text.slice(0, 197) + '…';
}

// ---------------------------------------------------------------------------
// GET /tickets
// ---------------------------------------------------------------------------

router.get('/tickets', async (req: Request, res: Response) => {
  const supabase = getServiceClient();

  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  const status = req.query.status as string | undefined;
  const kind = req.query.kind as string | undefined;
  const priority = req.query.priority as string | undefined;
  const surface = req.query.surface as string | undefined;
  const resolverAgent = req.query.resolver_agent as string | undefined;

  const { data, error } = await repo.fetchFeedbackTicketsList(supabase, {
    limit,
    status,
    kind,
    priority,
    surface,
    resolverAgent,
  });
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
  const id = req.params.id;
  const supabase = getServiceClient();

  const { data: ticket, error } = await repo.fetchFeedbackTicketById(supabase, id);

  if (error || !ticket) {
    return res.status(404).json({ ok: false, error: 'NOT_FOUND', details: error?.message });
  }

  const { data: handoffs, error: handoffsErr } = await repo.fetchFeedbackHandoffEventsForTicket(supabase, id);
  if (handoffsErr) console.error(`[feedback-admin] fetchFeedbackHandoffEventsForTicket error for ticket=${id}: ${handoffsErr.message}`);

  const { data: similar } = ticket.duplicate_of
    ? await repo.fetchSimilarTicketById(supabase, ticket.duplicate_of).then(r => {
        if (r.error) console.error(`[feedback-admin] fetchSimilarTicketById error for ticket=${ticket.duplicate_of}: ${r.error.message}`);
        return { data: r.data ? [r.data] : [] };
      })
    : { data: [] };

  return res.json({ ok: true, ticket, handoffs: handoffs ?? [], similar: similar ?? [] });
});

// ---------------------------------------------------------------------------
// GET /handoffs/recent
// ---------------------------------------------------------------------------

router.get('/handoffs/recent', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  const supabase = getServiceClient();

  const { data, error } = await repo.fetchRecentHandoffEvents(supabase, limit);

  if (error) {
    return res.status(502).json({ ok: false, error: 'QUERY_FAILED', details: error.message });
  }
  return res.json({ ok: true, handoffs: data ?? [] });
});

// ---------------------------------------------------------------------------
// GET /personas
// ---------------------------------------------------------------------------

router.get('/personas', async (req: Request, res: Response) => {
  const supabase = getServiceClient();
  const { data, error } = await repo.fetchAgentPersonasRoster(supabase);
  if (error) return res.status(502).json({ ok: false, error: 'QUERY_FAILED', details: error.message });
  return res.json({ ok: true, personas: data ?? [] });
});

// ---------------------------------------------------------------------------
// GET /kpis
// ---------------------------------------------------------------------------

router.get('/kpis', async (req: Request, res: Response) => {
  const supabase = getServiceClient();

  // Total counts by status
  const window30dIso = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const { data: byStatus, error: byStatusErr } = await repo.fetchFeedbackTicketsByStatusWindow(supabase, window30dIso);
  if (byStatusErr) console.error(`[feedback-admin] fetchFeedbackTicketsByStatusWindow error: ${byStatusErr.message}`);

  const { data: byKind, error: byKindErr } = await repo.fetchFeedbackTicketsByKindWindow(supabase, window30dIso);
  if (byKindErr) console.error(`[feedback-admin] fetchFeedbackTicketsByKindWindow error: ${byKindErr.message}`);

  const { data: byResolver, error: byResolverErr } = await repo.fetchFeedbackTicketsByResolverWindow(supabase, window30dIso);
  if (byResolverErr) console.error(`[feedback-admin] fetchFeedbackTicketsByResolverWindow error: ${byResolverErr.message}`);

  const { data: handoffCount, error: handoffCountErr } = await repo.fetchHandoffCountByAgentWindow(
    supabase,
    new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(),
  );
  if (handoffCountErr) console.error(`[feedback-admin] fetchHandoffCountByAgentWindow error: ${handoffCountErr.message}`);

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
// Gated by the router-level requireAdminAuth (exafy_admin) above. Per-tenant
// scoping to the requested tenantId's own admins (vs. any exafy_admin) is a
// separate, lower-severity follow-up — see require-tenant-admin.ts for the
// pattern to adopt here.

router.get('/tenants/:tenantId/tickets', async (req: Request, res: Response) => {
  const tenantId = req.params.tenantId;
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  const supabase = getServiceClient();

  // Get the user_ids in this tenant
  const { data: members, error: memErr } = await repo.fetchTenantMemberUserIds(supabase, tenantId);

  if (memErr) {
    return res.status(502).json({ ok: false, error: 'TENANT_LOOKUP_FAILED', details: memErr.message });
  }

  const userIds = (members ?? []).map(m => m.user_id);
  if (userIds.length === 0) {
    return res.json({ ok: true, tickets: [] });
  }

  const { data, error } = await repo.fetchTenantFeedbackTickets(supabase, userIds, limit);

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
    const { data: profiles, error: profilesErr } = await repo.fetchProfilesByVitanaIds(supabase, uniqueVitanaIds);
    if (profilesErr) console.error(`[feedback-admin] fetchProfilesByVitanaIds error: ${profilesErr.message}`);
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
    const { raw_transcript, ...rest } = t as typeof t & { raw_transcript?: string | null };
    return {
      ...rest,
      avatar_url: prof?.avatar_url ?? null,
      display_name: prof?.display_name ?? null,
      raw_transcript_excerpt: excerptFromTranscript(raw_transcript ?? null),
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
  const supabase = getServiceClient();
  // Return ALL non-archived personas including 'disabled' so the admin UI's
  // per-card on/off toggle reflects the real state (a disabled persona must
  // still appear in the list, just dimmed). Filtering to status='active' here
  // made disabled cards vanish from the UI, which made the toggle look broken
  // because the user flipped it once and the card disappeared.
  const { data, error } = await repo.fetchTenantPersonasRoster(supabase);
  if (error) return res.status(502).json({ ok: false, error: 'QUERY_FAILED', details: error.message });
  return res.json({ ok: true, personas: data ?? [] });
});

export default router;
