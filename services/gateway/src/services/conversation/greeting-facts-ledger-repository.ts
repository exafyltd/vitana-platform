// Genuinely tested via test/services/conversation/greeting-continuity.test.ts,
// which drives a real functional fake SupabaseClient scoped to the
// `user_assistant_state` table (asserts on the table name, filters rows
// by tenant_id/user_id/signal_name, records upserts) — not a wholesale
// module mock.
/**
 * services/conversation/greeting-facts-ledger.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in greeting-facts-ledger.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchGreetingLedgerSignals(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
  signalNames: string[],
) {
  return sb
    .from('user_assistant_state')
    .select('signal_name, value')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .in('signal_name', signalNames);
}

export async function fetchExistingGreetingFactsSignal(sb: SupabaseClient, tenantId: string, userId: string, signalName: string) {
  return sb
    .from('user_assistant_state')
    .select('value')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('signal_name', signalName)
    .maybeSingle();
}

export async function upsertUserAssistantStateSignal(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('user_assistant_state').upsert(row, { onConflict: 'tenant_id,user_id,signal_name' });
}
