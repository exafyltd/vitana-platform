// Genuine coverage: test/routes/voice-journey-context.test.ts mocks only
// getSupabase() (via jest.mock('../../src/lib/supabase', ...)), not
// this module — a real functional fake client, not a wholesale mock.
/**
 * routes/voice-journey-context.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in voice-journey-context.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same filter logic, same return
 * shape — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchUserAssistantStateRows(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb
    .from('user_assistant_state')
    .select('signal_name, value, count, confidence, source, expires_at, last_seen_at, created_at, updated_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
}
