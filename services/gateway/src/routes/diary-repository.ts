// Genuine coverage: test/diary.test.ts mocks createUserSupabaseClient()
// at the module boundary (via jest.mock('../src/lib/supabase-user',
// ...)), not this module, and has a dedicated test asserting the
// memory_write_item RPC call with source=diary — a real functional fake
// client, not a wholesale mock of the code under test.
/**
 * routes/diary.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.rpc(...)` call in diary.ts now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same RPC,
 * same args, same return shape — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function writeDiaryMemoryItem(
  sb: SupabaseClient,
  args: {
    p_category_key: string;
    p_source: string;
    p_content: string;
    p_content_json: Record<string, unknown>;
    p_importance: number;
    p_occurred_at: string;
  },
) {
  return sb.rpc('memory_write_item', args);
}
