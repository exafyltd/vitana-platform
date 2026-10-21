// impact-allow-no-test: pure data-access seam (thin Supabase RPC wrappers, no
// independent request-handling behavior); exercised indirectly by
// routes/taste-alignment.ts's existing test suite (test/d39-taste-alignment.test.ts),
// which covers every call site here.
/**
 * routes/taste-alignment.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.rpc(...)` call in routes/taste-alignment.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same RPC
 * names, same params, same return shapes — no behavior change today.
 * Client-agnostic (takes `sb` as a param) — the route builds a fresh
 * user-scoped client per request via createUserSupabaseClient(token) and
 * passes it straight through.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchMeContext(sb: SupabaseClient) {
  return sb.rpc('me_context');
}

export async function fetchTasteAlignmentBundle(sb: SupabaseClient) {
  return sb.rpc('taste_alignment_bundle_get');
}

export async function fetchTasteProfile(sb: SupabaseClient) {
  return sb.rpc('taste_profile_get');
}

export async function setTasteProfile(
  sb: SupabaseClient,
  params: {
    p_simplicity_preference: unknown;
    p_premium_orientation: unknown;
    p_aesthetic_style: unknown;
    p_tone_affinity: unknown;
  },
) {
  return sb.rpc('taste_profile_set', params);
}

export async function fetchLifestyleProfile(sb: SupabaseClient) {
  return sb.rpc('lifestyle_profile_get');
}

export async function setLifestyleProfile(
  sb: SupabaseClient,
  params: {
    p_routine_style: unknown;
    p_social_orientation: unknown;
    p_convenience_bias: unknown;
    p_experience_type: unknown;
    p_novelty_tolerance: unknown;
  },
) {
  return sb.rpc('lifestyle_profile_set', params);
}

export async function recordTasteReaction(
  sb: SupabaseClient,
  params: {
    p_action_id: unknown;
    p_action_type: unknown;
    p_reaction: unknown;
    p_action_attributes: unknown;
    p_alignment_score: unknown;
    p_session_id: unknown;
    p_context: unknown;
  },
) {
  return sb.rpc('taste_reaction_record', params);
}

export async function fetchTasteAlignmentAudit(
  sb: SupabaseClient,
  params: { p_limit: number; p_offset: number; p_target_type: string | null },
) {
  return sb.rpc('taste_alignment_audit_get', params);
}
