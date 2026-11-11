# Sparring round 2 — converged

Session: `2772d043-41a6-46ed-8e76-e676a560d911` · plan hash `be1e29771527a2f52bacac3a8a248bf11b35c4ffaa38738f49b6c6edd47d3ecd`

## Summary

All three R1 findings were accepted and properly addressed in the revised plan. The backward-compatible write pattern (retry on PGRST204/42703) is well-precedented in the codebase. The tenant filter clarification is correct: `global_community_profiles` has no `tenant_id` and its RLS is not tenant-scoped. The mentions migration reference is now accurate. One new minor finding regarding the backfill interaction with the pre-migration window.

## Findings

### R2-F1 [minor]

The backfill in the `explicit-intro-choice` migration (`SET community_intro_opt_in = false WHERE community_intro_choice_at IS NULL AND community_intro_opt_in = true`) will silently revert any explicit opt-in made by a user during the window between code deploy and migration apply. During that window, the backward-compatible fallback writes only `community_intro_opt_in = true` (no `community_intro_choice_at` marker). The backfill then treats those rows as 'no recorded choice' and sets them to false. A user who taps 'Yes, introduce me 👋' during registration or toggles ON in Settings during this window loses their explicit choice when the migration is applied. The plan §6 acknowledges the window but does not explicitly state that explicit opt-ins (not just defaults) are reverted. With the current community size (253 rows, 2 true) the blast radius is small and bounded by the owner stop.

- `exafyltd/vitana-v1:src/lib/community-intro.ts:27` — export async function setCommunityIntroOptIn(userId: string, value: boolean): Promise<void> {
  const { error } = await supabase
    .from("global_community_profiles")
    .update({ [COMMUNITY_INTRO_COLUMN]: value })
    .eq("user_id", userId);
  if (error) throw error;
}
- `exafyltd/vitana-platform:services/gateway/src/routes/chat-repository.ts:116` — /** A column this lane adds does not exist yet (migration not applied). */
export function isMissingColumn(err: PgError, column: string): boolean {
  if (!err) return false;
  if (err.code !== 'PGRST204' && err.code !== '42703') return false;
  return (err.message || '').includes(column);
}

Suggestion: Explicitly document in the plan §6 and the lane PR that any explicit opt-in during the pre-migration window will be reverted by the backfill, so the owner is aware when approving the apply. Alternatively, consider having the backfill check `updated_at > created_at` as a heuristic for 'user touched this row' to preserve those rows, though this adds complexity for a very small window.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Accepted and addressed. The backward-compatible retry pattern (PGRST204/42703) is well-precedented in chat-repository.ts:116-121 and the plan now specifies both the fallback behavior and test coverage for both paths.
- R1-F2: acknowledged — Accepted and addressed. The plan correctly removed 'member's tenant' from the spec and confirmed `global_community_profiles` has no tenant_id column and no tenant-scoped RLS. requireTenant stays as auth gate only, matching the existing community-members.ts:78 pattern.
- R1-F3: acknowledged — Accepted and addressed. The reference is now precise: `20261006140000_vtid_04926_mentions.sql:22-24`, confirmed to exist with SECURITY DEFINER and tenant restriction via user_tenants at lines 49-53.
