/**
 * Admin voice tools — Feedback & Support Admin (Wave 3, plan section B15).
 *
 * Thin dispatch layer over routes/feedback-admin.ts (cross-tenant,
 * service-role) and routes/feedback-actions.ts. Per research, these routes
 * only require a valid bearer token today (no server-side admin-role
 * check) — adminGate() is still enforced here so the voice surface itself
 * is admin-only, matching the plan's intent even though the backend is
 * more permissive. There is no human "assign to agent" concept in the
 * schema (only automated resolver_agent stamping via draft-* actions) —
 * flagged honestly rather than invented.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { gatewayApiCall, clampLimit, relAge } from './developer-tools';
import { adminGate, authHeaders, NO_ADMIN_SESSION } from './admin-users-rbac-tools';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

// ---------------------------------------------------------------------------
// 1. admin_list_feedback_tickets — GET /api/v1/admin/feedback/tickets
// ---------------------------------------------------------------------------

export const admin_list_feedback_tickets: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const qs = new URLSearchParams({ limit: String(clampLimit(args.limit, 20, 200)) });
  for (const k of ['status', 'kind', 'priority', 'surface', 'resolver_agent'] as const) {
    if (typeof args[k] === 'string' && args[k]) qs.set(k, args[k] as string);
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/feedback/tickets?${qs.toString()}`, { headers: authHeaders(id) });
  if (!ok || body.ok !== true) return { ok: false, error: `admin_list_feedback_tickets failed (${status}): ${String(body.error ?? 'unknown')}` };
  const tickets = (Array.isArray(body.tickets) ? body.tickets : []) as Array<{ ticket_number?: string; kind?: string; status?: string; priority?: string }>;
  if (tickets.length === 0) return { ok: true, result: { tickets: [] }, text: 'No feedback tickets matched.' };
  const lines = tickets.slice(0, 8).map((t) => `${t.ticket_number ?? '?'} — ${t.kind ?? 'unknown'}, ${t.status ?? 'unknown'} (${t.priority ?? 'normal'})`);
  return { ok: true, result: { tickets }, text: `${tickets.length} tickets: ${lines.join('. ')}` };
};

// ---------------------------------------------------------------------------
// 2. admin_get_feedback_ticket — GET /api/v1/admin/feedback/tickets/:id
// ---------------------------------------------------------------------------

export const admin_get_feedback_ticket: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const ticketId = String(args.ticket_id ?? '').trim();
  if (!ticketId) return { ok: false, error: 'admin_get_feedback_ticket requires ticket_id.' };
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/feedback/tickets/${encodeURIComponent(ticketId)}`, { headers: authHeaders(id) });
  if (!ok) {
    return status === 404
      ? { ok: true, result: { found: false }, text: `No feedback ticket found with id ${ticketId}.` }
      : { ok: false, error: `admin_get_feedback_ticket failed (${status}): ${String(body.error ?? 'unknown')}` };
  }
  const ticket = (body.ticket ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    result: body,
    text: `Ticket ${String(ticket.ticket_number ?? ticketId)} — ${String(ticket.kind ?? 'unknown')}, status ${String(ticket.status ?? 'unknown')}.`,
  };
};

// ---------------------------------------------------------------------------
// 3. admin_feedback_kpis — GET /api/v1/admin/feedback/kpis
// ---------------------------------------------------------------------------

export const admin_feedback_kpis: Handler = async (_args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const { ok, status, body } = await gatewayApiCall('/api/v1/admin/feedback/kpis', { headers: authHeaders(id) });
  if (!ok || body.ok !== true) return { ok: false, error: `admin_feedback_kpis failed (${status}): ${String(body.error ?? 'unknown')}` };
  return { ok: true, result: body, text: `Platform-wide feedback KPIs over the last 30 days retrieved.` };
};

// ---------------------------------------------------------------------------
// 4. admin_list_handoffs — GET /api/v1/admin/feedback/handoffs/recent
// ---------------------------------------------------------------------------

export const admin_list_handoffs: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const limit = clampLimit(args.limit, 20, 200);
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/feedback/handoffs/recent?limit=${limit}`, { headers: authHeaders(id) });
  if (!ok || body.ok !== true) return { ok: false, error: `admin_list_handoffs failed (${status}): ${String(body.error ?? 'unknown')}` };
  const handoffs = (Array.isArray(body.handoffs) ? body.handoffs : []) as Array<{ from_agent?: string; to_agent?: string; ts?: string }>;
  if (handoffs.length === 0) return { ok: true, result: { handoffs: [] }, text: 'No recent handoffs.' };
  const lines = handoffs.slice(0, 8).map((h) => `${h.from_agent ?? '?'} → ${h.to_agent ?? '?'} (${relAge(h.ts)})`);
  return { ok: true, result: { handoffs }, text: `${handoffs.length} recent handoffs: ${lines.join('. ')}` };
};

// ---------------------------------------------------------------------------
// 5. admin_act_on_ticket — POST /api/v1/admin/feedback/tickets/:id/<action>
// ---------------------------------------------------------------------------

const TICKET_ACTIONS: Record<string, { path: string; needsReason?: boolean; needsDuplicateOf?: boolean }> = {
  draft_answer: { path: 'draft-answer' },
  draft_spec: { path: 'draft-spec' },
  draft_resolution: { path: 'draft-resolution' },
  approve: { path: 'approve' },
  send_answer: { path: 'send-answer' },
  resolve: { path: 'resolve' },
  reject: { path: 'reject', needsReason: false },
  mark_duplicate: { path: 'mark-duplicate', needsDuplicateOf: true },
};

export const admin_act_on_ticket: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const ticketId = String(args.ticket_id ?? '').trim();
  const action = String(args.action ?? '').trim();
  if (action === 'assign') {
    return {
      ok: true,
      result: { supported: false },
      text: 'There is no human "assign to agent" concept in the feedback ticket schema — only automated resolver stamping via draft actions (draft_answer, draft_spec, draft_resolution). Use one of those instead.',
    };
  }
  const spec = TICKET_ACTIONS[action];
  if (!ticketId || !spec) {
    return { ok: false, error: `admin_act_on_ticket requires ticket_id and action (one of ${Object.keys(TICKET_ACTIONS).join(', ')}).` };
  }
  if (spec.needsDuplicateOf && typeof args.duplicate_of !== 'string') {
    return { ok: false, error: 'mark_duplicate requires duplicate_of (the uuid of the original ticket).' };
  }
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, ticket_id: ticketId, action },
      text: `About to ${action.replace('_', ' ')} ticket ${ticketId}. Confirm, then call again with confirm=true.`,
    };
  }
  const requestBody: Record<string, unknown> = {};
  if (action === 'reject' && typeof args.reason === 'string') requestBody.reason = args.reason;
  if (action === 'mark_duplicate') requestBody.duplicate_of = args.duplicate_of;
  if (['draft_answer', 'draft_spec', 'draft_resolution'].includes(action) && typeof args.notes === 'string') requestBody.notes = args.notes;
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/feedback/tickets/${encodeURIComponent(ticketId)}/${spec.path}`, {
    method: 'POST',
    headers: authHeaders(id),
    body: requestBody,
  });
  if (!ok) return { ok: true, result: { done: false, status, detail: body }, text: `Could not ${action.replace('_', ' ')} ticket ${ticketId}: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { done: true, detail: body }, text: `Ticket ${ticketId}: ${action.replace('_', ' ')} applied.` };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const ADMIN_FEEDBACK_TOOL_HANDLERS: Record<string, Handler> = {
  admin_list_feedback_tickets,
  admin_get_feedback_ticket,
  admin_feedback_kpis,
  admin_list_handoffs,
  admin_act_on_ticket,
};

export const ADMIN_FEEDBACK_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'admin_list_feedback_tickets',
    description: 'ADMIN ONLY. List support/feedback tickets, filterable by status/kind/priority/surface/resolver_agent.',
    parameters: {
      type: 'object',
      properties: { status: { type: 'string' }, kind: { type: 'string' }, priority: { type: 'string' }, surface: { type: 'string' }, resolver_agent: { type: 'string' }, limit: { type: 'integer' } },
    },
  },
  {
    name: 'admin_get_feedback_ticket',
    description: 'ADMIN ONLY. Full detail for one feedback ticket, including handoff history.',
    parameters: { type: 'object', properties: { ticket_id: { type: 'string', description: 'Required.' } }, required: ['ticket_id'] },
  },
  { name: 'admin_feedback_kpis', description: 'ADMIN ONLY. Platform-wide support KPIs (last 30 days).', parameters: { type: 'object', properties: {} } },
  { name: 'admin_list_handoffs', description: 'ADMIN ONLY. Recent specialist handoffs.', parameters: { type: 'object', properties: { limit: { type: 'integer' } } } },
  {
    name: 'admin_act_on_ticket',
    description: 'ADMIN ONLY. Act on a feedback ticket: draft_answer, draft_spec, draft_resolution, approve, send_answer, resolve, reject, or mark_duplicate. There is no "assign" action — that concept doesn\'t exist in the schema. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string', description: 'Required.' },
        action: { type: 'string', description: 'Required.' },
        reason: { type: 'string', description: 'Required for reject.' },
        duplicate_of: { type: 'string', description: 'Required for mark_duplicate.' },
        notes: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['ticket_id', 'action'],
    },
  },
];
