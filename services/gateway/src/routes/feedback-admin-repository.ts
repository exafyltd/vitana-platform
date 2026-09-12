// impact-allow-no-test: pure data-access seam (thin Supabase query wrappers,
// no independent request-handling behavior); exercised indirectly by
// routes/feedback-admin.ts's existing test suite (test/feedback-pipeline.test.ts),
// which covers every call site here.
/**
 * routes/feedback-admin.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/feedback-admin.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== feedback_tickets ====================

export async function fetchFeedbackTicketsList(
  sb: SupabaseClient,
  filters: { limit: number; status?: string; kind?: string; priority?: string; surface?: string; resolverAgent?: string },
) {
  let q = sb
    .from('feedback_tickets')
    .select(
      'id, ticket_number, vitana_id, kind, status, priority, surface, raw_transcript, screen_path, app_version, classifier_meta, duplicate_of, resolver_agent, created_at, triaged_at, resolved_at, user_confirmed_at',
    )
    .order('created_at', { ascending: false })
    .limit(filters.limit);

  if (filters.status) q = q.eq('status', filters.status);
  if (filters.kind) q = q.eq('kind', filters.kind);
  if (filters.priority) q = q.eq('priority', filters.priority);
  if (filters.surface) q = q.eq('surface', filters.surface);
  if (filters.resolverAgent) q = q.eq('resolver_agent', filters.resolverAgent);

  return q;
}

export async function fetchFeedbackTicketById(sb: SupabaseClient, id: string) {
  return sb.from('feedback_tickets').select('*').eq('id', id).maybeSingle();
}

export async function fetchSimilarTicketById(sb: SupabaseClient, duplicateOfId: string) {
  return sb.from('feedback_tickets').select('id, ticket_number, kind, status').eq('id', duplicateOfId).maybeSingle();
}

export async function fetchFeedbackTicketsByStatusWindow(sb: SupabaseClient, sinceIso: string) {
  return sb.from('feedback_tickets').select('status').gte('created_at', sinceIso);
}

export async function fetchFeedbackTicketsByKindWindow(sb: SupabaseClient, sinceIso: string) {
  return sb.from('feedback_tickets').select('kind').gte('created_at', sinceIso);
}

export async function fetchFeedbackTicketsByResolverWindow(sb: SupabaseClient, sinceIso: string) {
  return sb.from('feedback_tickets').select('resolver_agent').not('resolver_agent', 'is', null).gte('created_at', sinceIso);
}

export async function fetchTenantFeedbackTickets(sb: SupabaseClient, userIds: string[], limit: number) {
  return sb
    .from('feedback_tickets')
    .select(
      'id, ticket_number, vitana_id, kind, status, priority, surface, raw_transcript, screen_path, app_version, resolver_agent, created_at, resolved_at, user_confirmed_at',
    )
    .in('user_id', userIds)
    .order('created_at', { ascending: false })
    .limit(limit);
}

// ==================== feedback_handoff_events ====================

export async function fetchFeedbackHandoffEventsForTicket(sb: SupabaseClient, ticketId: string) {
  return sb
    .from('feedback_handoff_events')
    .select('id, from_agent, to_agent, reason, detected_intent, matched_keyword, confidence, ts')
    .eq('ticket_id', ticketId)
    .order('ts', { ascending: true });
}

export async function fetchRecentHandoffEvents(sb: SupabaseClient, limit: number) {
  return sb
    .from('feedback_handoff_events')
    .select('id, conversation_id, ticket_id, vitana_id, from_agent, to_agent, reason, detected_intent, matched_keyword, confidence, ts')
    .order('ts', { ascending: false })
    .limit(limit);
}

export async function fetchHandoffCountByAgentWindow(sb: SupabaseClient, sinceIso: string) {
  return sb.from('feedback_handoff_events').select('to_agent', { count: 'exact', head: false }).gte('ts', sinceIso);
}

// ==================== agent_personas ====================

export async function fetchAgentPersonasRoster(sb: SupabaseClient) {
  return sb
    .from('agent_personas')
    .select(
      'id, key, display_name, role, voice_id, voice_sample_url, system_prompt, intake_schema_ref, handles_kinds, handoff_keywords, max_questions, max_duration_seconds, status, version, updated_at',
    )
    .order('key');
}

export async function fetchTenantPersonasRoster(sb: SupabaseClient) {
  return sb
    .from('agent_personas')
    .select('key, display_name, role, voice_id, voice_sample_url, handles_kinds, status, version, updated_at')
    .neq('status', 'archived')
    .order('key');
}

// ==================== user_tenants / profiles ====================

export async function fetchTenantMemberUserIds(sb: SupabaseClient, tenantId: string) {
  return sb.from('user_tenants').select('user_id').eq('tenant_id', tenantId);
}

export async function fetchProfilesByVitanaIds(sb: SupabaseClient, vitanaIds: string[]) {
  return sb.from('profiles').select('vitana_id, avatar_url, display_name').in('vitana_id', vitanaIds);
}
