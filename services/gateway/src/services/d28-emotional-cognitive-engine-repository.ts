// impact-allow-no-test: pure data-access seam (thin Supabase RPC
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references d28-emotional-cognitive-engine.ts — zero
// coverage today.
/**
 * services/d28-emotional-cognitive-engine.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.rpc(...)` call in d28-emotional-cognitive-engine.ts
 * now goes through here instead of being written inline. PURE MOVE, not
 * a rewrite: same RPCs, same params, same return shapes — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Reused across all 4 public functions' dev-sandbox bootstrap step. */
export async function devBootstrapRequestContext(sb: SupabaseClient, tenantId: string, activeRole: string) {
  return sb.rpc('dev_bootstrap_request_context', { p_tenant_id: tenantId, p_active_role: activeRole });
}

export async function computeEmotionalCognitiveSignals(
  sb: SupabaseClient,
  params: {
    p_message: string;
    p_session_id: string | null;
    p_turn_id: string | null;
    p_response_time_seconds: number | null;
    p_correction_count: number;
    p_interaction_count: number;
  },
) {
  return sb.rpc('emotional_cognitive_compute', params);
}

export async function fetchCurrentEmotionalCognitiveSignals(sb: SupabaseClient, sessionId: string | null) {
  return sb.rpc('emotional_cognitive_get_current', { p_session_id: sessionId });
}

export async function overrideEmotionalCognitiveSignal(sb: SupabaseClient, signalId: string, override: unknown) {
  return sb.rpc('emotional_cognitive_override', { p_signal_id: signalId, p_override: override });
}

export async function explainEmotionalCognitiveSignal(sb: SupabaseClient, signalId: string) {
  return sb.rpc('emotional_cognitive_explain', { p_signal_id: signalId });
}
