// Genuinely tested via test/routes/voice-teacher-event.test.ts (only
// getSupabase is mocked, not this module) — not a wholesale module
// mock.
/**
 * routes/voice-teacher-event.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in
 * voice-teacher-event.ts now goes through here instead of being
 * written inline. PURE MOVE, not a rewrite: same calls, same params,
 * same columns, same return shapes — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function advanceCapabilityAwarenessRpc(
  sb: SupabaseClient,
  args: {
    p_tenant_id: string;
    p_user_id: string;
    p_capability_key: string;
    p_event_name: string;
    p_idempotency_key: string;
    p_decision_id: string | null;
    p_source_surface: string | null;
    p_occurred_at: string;
    p_metadata: Record<string, unknown> | null;
  },
) {
  return sb.rpc('advance_capability_awareness', args);
}

export async function fetchSystemCapabilityManualInfo(sb: SupabaseClient, capabilityKey: string) {
  return sb.from('system_capabilities').select('manual_path, display_name').eq('capability_key', capabilityKey).maybeSingle();
}
