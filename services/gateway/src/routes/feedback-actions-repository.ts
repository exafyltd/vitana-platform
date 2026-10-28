// impact-allow-no-test: pure data-access seam (thin Supabase query wrappers,
// no independent request-handling behavior); exercised indirectly by
// routes/feedback-actions.ts's existing test suite (test/feedback-pipeline.test.ts),
// which covers every call site here.
/**
 * routes/feedback-actions.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/feedback-actions.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param) — the admin routes pass the service client, the user routes pass
 * a per-request user-scoped client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchTicketSnapshot(sb: SupabaseClient, id: string) {
  return sb
    .from('feedback_tickets')
    .select('id, ticket_number, kind, raw_transcript, intake_messages, structured_fields, classifier_meta, screen_path, app_version, vitana_id, priority')
    .eq('id', id)
    .maybeSingle();
}

export async function updateTicketDraftAnswer(sb: SupabaseClient, id: string, patch: Record<string, unknown>) {
  return sb.from('feedback_tickets').update(patch).eq('id', id).select('id, ticket_number, kind, status, vitana_id').single();
}

export async function updateTicketDraftSpec(sb: SupabaseClient, id: string, patch: Record<string, unknown>) {
  return sb.from('feedback_tickets').update(patch).eq('id', id).select('id, ticket_number, kind, status, vitana_id').single();
}

export async function updateTicketDraftResolution(sb: SupabaseClient, id: string, patch: Record<string, unknown>) {
  return sb.from('feedback_tickets').update(patch).eq('id', id).select('id, ticket_number, kind, status, vitana_id').single();
}

export async function approveTicket(sb: SupabaseClient, id: string) {
  return sb
    .from('feedback_tickets')
    .update({ status: 'in_progress' })
    .eq('id', id)
    .in('status', ['spec_ready', 'answer_ready'])
    .select('id, ticket_number, kind, status, vitana_id, resolver_agent')
    .single();
}

export async function sendAnswerTicket(sb: SupabaseClient, id: string, patch: Record<string, unknown>) {
  return sb
    .from('feedback_tickets')
    .update(patch)
    .eq('id', id)
    .eq('status', 'answer_ready')
    .select('id, ticket_number, kind, status, vitana_id, resolver_agent, draft_answer_md')
    .single();
}

export async function resolveTicket(sb: SupabaseClient, id: string, patch: Record<string, unknown>) {
  return sb.from('feedback_tickets').update(patch).eq('id', id).select('id, ticket_number, kind, status, vitana_id, resolver_agent').single();
}

export async function rejectTicket(sb: SupabaseClient, id: string, patch: Record<string, unknown>) {
  return sb.from('feedback_tickets').update(patch).eq('id', id).select('id, ticket_number, kind, status, vitana_id').single();
}

export async function markDuplicateTicket(sb: SupabaseClient, id: string, patch: Record<string, unknown>) {
  return sb.from('feedback_tickets').update(patch).eq('id', id).select('id, ticket_number, kind, status, vitana_id, duplicate_of').single();
}

export async function confirmUserTicket(sb: SupabaseClient, id: string, userId: string, patch: Record<string, unknown>) {
  return sb
    .from('feedback_tickets')
    .update(patch)
    .eq('id', id)
    .eq('user_id', userId)
    .select('id, ticket_number, kind, status, vitana_id')
    .single();
}

export async function reopenUserTicket(sb: SupabaseClient, id: string, userId: string, patch: Record<string, unknown>) {
  return sb
    .from('feedback_tickets')
    .update(patch)
    .eq('id', id)
    .eq('user_id', userId)
    .in('status', ['resolved', 'user_confirmed'])
    .select('id, ticket_number, kind, status, vitana_id')
    .single();
}
