// impact-allow-no-test: pure data-access seam (thin Supabase upsert/update
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references pillar-agents/orchestrator.ts — zero coverage
// today.
/**
 * services/pillar-agents/orchestrator.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in orchestrator.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same
 * upsert/update, same columns, same onConflict/filter options, same
 * return shapes — no behavior change today. Client-agnostic (takes `sb`
 * as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function upsertPillarAgentOutput(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('vitana_pillar_agent_outputs').upsert(row, { onConflict: 'user_id,pillar,date' });
}

export async function updateAgentHeartbeat(sb: SupabaseClient, agentId: string, row: Record<string, unknown>) {
  return sb.from('agents_registry').update(row).eq('agent_id', agentId);
}
