// Coverage note: test/feedback-pipeline.test.ts exercises this route
// end-to-end against a real functional fake Supabase client (mocks
// '../src/lib/supabase-user' to return a stateful in-memory query
// builder — not a wholesale mock of this repository module), so these
// wrappers get genuine coverage, not a documented zero.
/**
 * routes/feedback.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in feedback.ts now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 *
 * `fetchMyTickets` resolves the terminal await inside an async function
 * (rather than returning a partial builder) so the source's optional
 * cursor-based `.lt()` step still runs before the query executes.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function insertFeedbackTicket(sb: SupabaseClient, insertRow: Record<string, unknown>) {
  return sb
    .from('feedback_tickets')
    .insert(insertRow)
    .select('id, ticket_number, status, kind, created_at')
    .single();
}

export async function fetchMyTickets(sb: SupabaseClient, args: { limit: number; cursor: string | undefined }) {
  let query = sb
    .from('feedback_tickets')
    .select('id, ticket_number, kind, status, priority, surface, created_at, resolver_agent, resolved_at, user_confirmed_at, structured_fields')
    .order('created_at', { ascending: false })
    .limit(args.limit);

  if (args.cursor) {
    query = query.lt('created_at', args.cursor);
  }

  return query;
}
