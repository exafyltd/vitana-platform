// impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior). Coverage note:
// the one referencing test (test/orb-tools/feedback-settings-tools.test.ts)
// wholesale jest.mocks report-to-specialist-core.ts — zero genuine
// coverage today.
/**
 * services/report-to-specialist-core.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in
 * report-to-specialist-core.ts now goes through here instead of being
 * written inline. PURE MOVE, not a rewrite: same calls, same params,
 * same columns, same return shapes — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function pickSpecialistForText(
  sb: SupabaseClient,
  rpcName: 'pick_specialist_for_text' | 'pick_specialist_for_text_tenant',
  rpcArgs: Record<string, unknown>,
) {
  return sb.rpc(rpcName, rpcArgs as never);
}

export async function insertFeedbackTicket(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('feedback_tickets').insert(row).select('id, ticket_number').single();
}

export async function insertFeedbackHandoffEvent(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('feedback_handoff_events').insert(row);
}
