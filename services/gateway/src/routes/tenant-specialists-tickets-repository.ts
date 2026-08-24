/**
 * routes/tenant-specialists.ts (ticket-actions section) — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The /:tenantId/specialists/* overlay routes already go through
 * services/specialists/tenant-specialists-repository.ts. This seam covers
 * the separate ticket-action routes further down the same file (approve-all,
 * ticket detail, reject, rollback, draft-spec, activate, reclassify), which
 * used a raw getServiceClient() call inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return shapes —
 * no behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== app_users / user_tenants ====================

export async function fetchAppUserIdByVitanaId(sb: SupabaseClient, vitanaId: string) {
  return sb.from('app_users').select('user_id').eq('vitana_id', vitanaId).maybeSingle();
}

export async function fetchTenantMembership(sb: SupabaseClient, userId: string, tenantId: string) {
  return sb.from('user_tenants').select('user_id').eq('user_id', userId).eq('tenant_id', tenantId).maybeSingle();
}

// ==================== feedback_tickets ====================

export async function fetchActionableFeedbackTickets(sb: SupabaseClient, userId: string, statuses: string[]) {
  return sb
    .from('feedback_tickets')
    .select('id, ticket_number, kind, status, vitana_id, resolver_agent')
    .eq('user_id', userId)
    .in('status', statuses);
}

export async function advanceSpecReadyTicketToInProgress(sb: SupabaseClient, ticketId: string) {
  return sb
    .from('feedback_tickets')
    .update({ status: 'in_progress' })
    .eq('id', ticketId)
    .eq('status', 'spec_ready')
    .select('id, ticket_number, kind, status, vitana_id, resolver_agent')
    .single();
}

export async function advanceAnswerReadyTicketToResolved(sb: SupabaseClient, ticketId: string, nowIso: string) {
  return sb
    .from('feedback_tickets')
    .update({ status: 'resolved', resolved_at: nowIso, auto_resolved: false })
    .eq('id', ticketId)
    .eq('status', 'answer_ready')
    .select('id, ticket_number, kind, status, vitana_id, resolver_agent, draft_answer_md')
    .single();
}

export async function fetchFeedbackTicketById(sb: SupabaseClient, ticketId: string) {
  return sb.from('feedback_tickets').select('*').eq('id', ticketId).maybeSingle();
}

export async function updateFeedbackTicketRejected(sb: SupabaseClient, ticketId: string, reason: string | null) {
  return sb
    .from('feedback_tickets')
    .update({ status: 'rejected', supervisor_notes: reason })
    .eq('id', ticketId)
    .select('id, ticket_number, kind, status, vitana_id')
    .single();
}

export async function updateFeedbackTicketRollback(sb: SupabaseClient, ticketId: string, patch: Record<string, unknown>) {
  return sb.from('feedback_tickets').update(patch).eq('id', ticketId);
}

export async function updateFeedbackTicketDraft(sb: SupabaseClient, ticketId: string, patch: Record<string, unknown>) {
  return sb.from('feedback_tickets').update(patch).eq('id', ticketId);
}

export async function dispatchFeedbackTicketToInProgress(sb: SupabaseClient, ticketId: string, findingId: string | null) {
  return sb
    .from('feedback_tickets')
    .update({ status: 'in_progress', linked_finding_id: findingId })
    .eq('id', ticketId);
}

export async function resolveSupportQuestionTicket(sb: SupabaseClient, ticketId: string, nowIso: string) {
  return sb
    .from('feedback_tickets')
    .update({ status: 'resolved', resolved_at: nowIso, auto_resolved: false })
    .eq('id', ticketId)
    .select('status')
    .single();
}

export async function advanceTicketToInProgressSimple(sb: SupabaseClient, ticketId: string) {
  return sb.from('feedback_tickets').update({ status: 'in_progress' }).eq('id', ticketId).select('status').single();
}

export async function reclassifyFeedbackTicket(sb: SupabaseClient, ticketId: string, patch: Record<string, unknown>) {
  return sb.from('feedback_tickets').update(patch).eq('id', ticketId);
}

// ==================== feedback_handoff_events ====================

export async function fetchFeedbackHandoffEvents(sb: SupabaseClient, ticketId: string) {
  return sb
    .from('feedback_handoff_events')
    .select('id, from_agent, to_agent, reason, detected_intent, matched_keyword, confidence, ts')
    .eq('ticket_id', ticketId)
    .order('ts', { ascending: true });
}

// ==================== dev_autopilot_executions ====================

export async function fetchLatestExecutionByFindingId(sb: SupabaseClient, findingId: string) {
  return sb
    .from('dev_autopilot_executions')
    .select('id, status, pr_url, pr_number, branch, failure_stage, created_at, updated_at, completed_at')
    .eq('finding_id', findingId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function fetchLatestCompletedExecutionByFindingId(sb: SupabaseClient, findingId: string) {
  return sb
    .from('dev_autopilot_executions')
    .select('id, status, pr_url, pr_number, metadata')
    .eq('finding_id', findingId)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

// ==================== agent_audit_log ====================

export async function insertAgentAuditLog(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('agent_audit_log').insert(row);
}
