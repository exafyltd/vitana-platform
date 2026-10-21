// Genuinely tested via test/services/conversation/new-facts-detector.test.ts,
// which drives a real functional fake Supabase client (chain-method
// agnostic, records calls) — not a wholesale module mock.
/**
 * services/conversation/new-facts-detector.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in new-facts-detector.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchNewMemoryFacts(
  sb: SupabaseClient,
  args: { userId: string; tenantId?: string; sinceIso: string; limit: number },
) {
  let query = sb
    .from('memory_facts')
    .select('fact_key, fact_value')
    .eq('user_id', args.userId)
    .is('superseded_at', null)
    .gt('extracted_at', args.sinceIso)
    .order('extracted_at', { ascending: false })
    .limit(args.limit);
  if (args.tenantId) query = query.eq('tenant_id', args.tenantId);
  return query;
}

export async function fetchLearningSurfacedSignal(sb: SupabaseClient, tenantId: string, userId: string, signalName: string) {
  return sb
    .from('user_assistant_state')
    .select('value')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('signal_name', signalName)
    .maybeSingle();
}

export async function upsertLearningSurfacedSignal(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('user_assistant_state').upsert(row, { onConflict: 'tenant_id,user_id,signal_name' });
}
