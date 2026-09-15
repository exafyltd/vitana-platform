// impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior); exercised indirectly
// by routes/feedback-intake.ts's existing test suite (test/feedback-pipeline.test.ts),
// which covers every call site here.
/**
 * routes/feedback-intake.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in routes/feedback-intake.ts
 * now goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes `sb` as
 * a param).
 *
 * The feedback_handoff_events writes in the same file go through raw
 * fetch() to PostgREST directly (service-role, bypassing RLS) rather than
 * a supabase-js client call — out of scope for this seam, which only
 * covers `.from()`/`.rpc()` calls on a client instance.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function pickSpecialistForText(sb: SupabaseClient, text: string) {
  return sb.rpc('pick_specialist_for_text', { p_text: text });
}

export async function insertFeedbackTicketForIntake(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('feedback_tickets').insert(row).select('id, ticket_number, kind, status').single();
}

export async function fetchAgentPersonaForHandoff(sb: SupabaseClient, personaKey: string) {
  return sb
    .from('agent_personas')
    .select('key, display_name, role, voice_id, system_prompt, intake_schema_ref, max_questions, max_duration_seconds')
    .eq('key', personaKey)
    .maybeSingle();
}

export async function fetchTicketForTurn(sb: SupabaseClient, ticketId: string) {
  return sb.from('feedback_tickets').select('id, intake_messages, status').eq('id', ticketId).maybeSingle();
}

export async function updateTicketIntakeMessages(sb: SupabaseClient, ticketId: string, messages: unknown[]) {
  return sb.from('feedback_tickets').update({ intake_messages: messages }).eq('id', ticketId);
}

export async function updateTicketComplete(sb: SupabaseClient, ticketId: string, patch: Record<string, unknown>) {
  return sb.from('feedback_tickets').update(patch).eq('id', ticketId).select('id, ticket_number, status, kind, vitana_id').single();
}
