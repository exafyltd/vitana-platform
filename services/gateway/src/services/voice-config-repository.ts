// Coverage note: test/services/voice-config.test.ts exercises this
// module against a mocked '../../lib/supabase' client (a functional
// fake, not a wholesale mock of this repository module), so these
// wrappers get genuine coverage, not a documented zero.
/**
 * services/voice-config.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in voice-config.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same upsert options, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchSystemConfigRows(sb: SupabaseClient, keys: string[]) {
  return sb.from('system_config').select('key, value').in('key', keys);
}

export async function upsertSystemConfigRow(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('system_config').upsert(row, { onConflict: 'key' });
}
