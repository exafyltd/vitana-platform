// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrapper, no independent request-handling behavior). Coverage note: no
// test file references routes/public-profile-og.ts — zero coverage
// today.
/**
 * routes/public-profile-og.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in public-profile-og.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same return shape — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 *
 * `buildPublicProfileOgQuery` returns only the query-initiating
 * `.from('profiles').select(...)` builder, `: any` typed, so the source
 * file's isUuid-vs-handle branch (`.or(...)` vs `.eq('handle', ...)`,
 * both terminated with `.maybeSingle()`) keeps mutating it in place
 * exactly as before — the same reasoning already applied to
 * discover-search-repository.ts's buildProductSearchQuery and its
 * siblings.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export function buildPublicProfileOgQuery(sb: SupabaseClient): any {
  return sb
    .from('profiles')
    .select(
      'id, user_id, handle, display_name, first_name, last_name, longevity_archetype, bio, avatar_url, cover_url',
    );
}
