/**
 * routes/voice-feedback.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/voice-feedback.ts (against
 * user_feedback_reports and vtid_ledger) now goes through here instead of
 * being written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same `{ data, error }` shapes — no behavior change today.
 *
 * vtid_ledger is included here (not treated as a generic shared table)
 * because POST /reports/:id/approve writes to it directly as its own
 * core behavior (creating the Command Hub task), not as an incidental
 * cross-cutting lookup.
 *
 * Repository functions are client-agnostic (take whichever SupabaseClient
 * the caller already resolved) since this route splits between the
 * user-JWT-scoped client (reports a user reads/creates for themselves)
 * and the service-role client (admin approve/reject) — same pattern as
 * universal-cart-repository.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== user_feedback_reports ====================

export async function insertFeedbackReport(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('user_feedback_reports').insert(row).select('id, created_at').single();
}

export interface FeedbackReportsFilters {
  status?: string;
  offset: number;
  limit: number;
}

export async function fetchFeedbackReports(supabase: SupabaseClient, f: FeedbackReportsFilters) {
  let query = supabase.from('user_feedback_reports').select('*').order('created_at', { ascending: false }).range(f.offset, f.offset + f.limit - 1);
  if (f.status) query = query.eq('status', f.status);
  return query;
}

export async function fetchFeedbackReportById(supabase: SupabaseClient, id: string) {
  return supabase.from('user_feedback_reports').select('*').eq('id', id).single();
}

export async function fetchFeedbackReportStatus(supabase: SupabaseClient, id: string) {
  return supabase.from('user_feedback_reports').select('id, status').eq('id', id).single();
}

export async function updateFeedbackReport(supabase: SupabaseClient, id: string, fields: Record<string, unknown>) {
  return supabase.from('user_feedback_reports').update(fields).eq('id', id);
}

// ==================== vtid_ledger ====================

export async function fetchMaxVtid(supabase: SupabaseClient) {
  return supabase.from('vtid_ledger').select('vtid').order('vtid', { ascending: false }).limit(1).single();
}

export async function insertVtidLedgerTask(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('vtid_ledger').insert(row);
}
