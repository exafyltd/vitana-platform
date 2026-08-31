// Coverage note: test/orb/teacher/teacher-content-resolver.test.ts
// exercises this module against a hand-built functional fake Supabase
// client passed directly as `inputs.supabase` (not a jest.mock of this
// repository module), so these wrappers get genuine coverage, not a
// documented zero.
/**
 * orb/teacher/teacher-content-resolver.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in teacher-content-resolver.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchEnabledSystemCapabilities(sb: SupabaseClient) {
  return sb
    .from('system_capabilities')
    .select('capability_key, display_name, description, manual_path, enabled, pedagogical_order, teacher_intro_de, teacher_intro_en')
    .eq('enabled', true);
}

export async function fetchKnowledgeDocByPath(sb: SupabaseClient, path: string) {
  return sb.from('knowledge_docs').select('content').eq('path', path).maybeSingle();
}

export async function fetchUserCapabilityAwarenessLedger(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb
    .from('user_capability_awareness')
    .select('capability_key, awareness_state, dismiss_count, last_introduced_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId);
}
