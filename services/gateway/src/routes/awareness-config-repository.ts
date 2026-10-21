// Genuinely tested via test/routes/awareness-config.test.ts, which
// drives a functional table-keyed fake Supabase client for the route's
// own adminClient() — not a wholesale module mock.
/**
 * routes/awareness-config.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in awareness-config.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchAwarenessConfigAudit(sb: SupabaseClient, limit: number) {
  return sb
    .from('awareness_config_audit')
    .select('id, key, prev_enabled, new_enabled, prev_params, new_params, changed_by, changed_at')
    .order('changed_at', { ascending: false })
    .limit(limit);
}

export async function fetchAwarenessConfigByKey(sb: SupabaseClient, key: string) {
  return sb.from('awareness_config').select('enabled, params').eq('key', key).maybeSingle();
}

export async function upsertAwarenessConfig(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('awareness_config').upsert(row, { onConflict: 'key' });
}

export async function insertAwarenessConfigAuditRow(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('awareness_config_audit').insert(row);
}
