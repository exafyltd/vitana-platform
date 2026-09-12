// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note:
// both referencing test files (memory-facts-service.test.ts,
// orb-memory-bridge.test.ts) wholesale jest.mock mem-tier2-writer.ts
// itself — zero genuine coverage of these queries today.
/**
 * services/mem-tier2-writer.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in mem-tier2-writer.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function insertMemEpisode(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('mem_episodes').insert(row);
}

export async function supersedeActiveMemFact(sb: SupabaseClient, tenantId: string, userId: string, entity: string, factKey: string, now: string) {
  return sb
    .from('mem_facts')
    .update({ valid_to: now, superseded_at: now })
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('entity', entity)
    .eq('fact_key', factKey)
    .is('valid_to', null);
}

export async function insertMemFact(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('mem_facts').insert(row);
}

export async function insertMemGraphEdge(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('mem_graph_edges').insert(row);
}

export async function insertMemoryWriteDlqRow(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('memory_write_dlq').insert(row);
}
