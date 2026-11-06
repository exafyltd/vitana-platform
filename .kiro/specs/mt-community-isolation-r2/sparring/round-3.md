# Sparring round 3 — escalated

Session: `e768aae5-43ac-4bc7-9426-703e913aa5f2` · plan hash `edc3ace868bbe870d318efc69486a81b244ac5eeb6acb8f5372e7edf89664b78`

## Summary

Round 3 review of mt-community-isolation. All six previously accepted findings (R1-F1 through R1-F4, R2-F1, R2-F2) are properly addressed in the revised plan. I verified key premises and found one new potential gap and one minor inaccuracy. The plan is substantially solid.

## Findings

### R3-F1 [major]

The plan enumerates exactly three callers of `resolvePersonByName`: `intent-find-match.ts:277`, `p0-gap-tools.ts:71` (via `resolveMember`), and `person-context-builder.ts:52`. However, a code search for `resolveMember` also returns a hit in `services/gateway/src/services/orb-tools/wallet-payments-tools.ts`. Since `resolveMember` in `p0-gap-tools.ts` is a non-exported private function (line 70), `wallet-payments-tools.ts` likely has its own `resolveMember` (or direct `resolvePersonByName` import) that resolves community members for payment-related tool functions. If that file calls `resolvePersonByName`, it is a missed caller that needs the `tenantId` parameter threaded through, and its tool functions need to be enumerated the same way `tool_follow_member`/`tool_like_post`/`tool_comment_on_post` are.

- `exafyltd/vitana-platform:services/gateway/src/services/orb-tools/p0-gap-tools.ts:70` — async function resolveMember(name: string): Promise<ResolvedPerson | null> {
    const { resolvePersonByName } = await import('../social-memory/social-memory-repository');
    const person = await resolvePersonByName(name);
    if (!person) return null;
    return { user_id: person.user_id, display_name: person.display_name ?? null };
  }

Suggestion: Read `wallet-payments-tools.ts` and confirm whether it calls `resolvePersonByName` (directly or via its own `resolveMember`). If yes, add it to the caller enumeration in fix (e) and ensure it threads `tenantId`/`id` the same way the p0-gap-tools callers do.

### R3-F2 [minor]

The plan states `fetchFollowFlags` (`:622`) reads 'only the viewer's own rows (`.eq('user_id', userId)`)'. This is factually inaccurate: `fetchFollowFlags` (lines 622-642) queries `user_follows` with both the viewer AND a `personId` — `.eq('follower_id', userId).eq('following_id', personId)` and vice versa. The function is practically safe because `personId` is always pre-resolved through a tenant-scoped path (either `fetchPersonById` or `resolvePersonByName`), so no cross-tenant person_id can reach it when the flag is on. The out-of-scope justification should be corrected from 'reads only the viewer's own rows' to 'both columns are fixed (viewer + already-scoped personId), returning only a boolean about the viewer's direct relationship — no tenant-unscoped person ids reach this function'.

- `exafyltd/vitana-platform:services/gateway/src/services/social-memory/social-memory-repository.ts:622` — export async function fetchFollowFlags(
    userId: string,
    personId: string,
  ): Promise<{ you_follow: boolean; follows_you: boolean }> {
    const supabase = getSupabase();
    if (!supabase) return { you_follow: false, follows_you: false };
    const [a, b] = await Promise.all([
      supabase
        .from('user_follows')
        .select('id')
        .eq('follower_id', userId)
        .eq('following_id', personId)
        .limit(1),
      supabase
        .from('user_follows')
        .select('id')
        .eq('follower_id', personId)
        .eq('following_id', userId)
        .limit(1),
    ]);
    return { you_follow: (a.data || []).length > 0, follows_you: (b.data || []).length > 0 };
  }
- `exafyltd/vitana-platform:services/gateway/src/services/social-memory/person-context-builder.ts:49` —     if (input.person_id) {
      person = await fetchPersonById(input.person_id);
    } else if (input.person_hint) {
      person = await resolvePersonByName(input.person_hint);
    }
    ...
    const [flags, matches, interests, groups, events, posts, lastChatAt] = await Promise.all([
      fetchFollowFlags(input.user_id, person.user_id),

Suggestion: Correct the out-of-scope rationale for `fetchFollowFlags` to: 'both query columns are fully constrained (viewer + a personId that was already resolved through a scoped path); no member enumeration possible'. The function does not need a code change, but the justification should be accurate.
