# Sparring round 1 — in_progress

Session: `2772d043-41a6-46ed-8e76-e676a560d911` · plan hash `b7d381f2e11063ecbdf6265d2a6db0a2a969b2b210ab8390281d720a9fff3726`

## Summary

The plan is generally well-structured with good fail-closed reasoning and a clear owner decision. Most premises about the existing code check out. I found one major issue around the deploy-vs-migration ordering for the `explicit-intro-choice` lane and one concern about tenant scoping in the new gateway endpoint.

## Findings

### R1-F1 [major]

The `explicit-intro-choice` lane's code changes (modifying `setCommunityIntroOptIn` to write both `community_intro_opt_in` and `community_intro_choice_at`) will deploy before the migration that creates `community_intro_choice_at` is applied (the migration is an owner stop). During this window, every call to `setCommunityIntroOptIn` will fail because PostgREST rejects writes to non-existent columns. This breaks the existing Settings → Privacy community intro toggle for ALL users, not just new signups. The plan acknowledges the window but characterises it as 'fail safe, nobody is introduced', which understates the impact: the toggle that existing users already have stops working entirely. The OnboardingNameForm path catches the error non-fatally (line 168), but the CommunityIntroToggle mutation (line 28-34) surfaces a toast error and silently drops the write, so no user can change their setting until the migration is applied.

- `exafyltd/vitana-v1:src/lib/community-intro.ts:27` — export async function setCommunityIntroOptIn(userId: string, value: boolean): Promise<void> {
  const { error } = await supabase
    .from("global_community_profiles")
    .update({ [COMMUNITY_INTRO_COLUMN]: value })
    .eq("user_id", userId);
  if (error) throw error;
}
- `exafyltd/vitana-v1:src/components/settings/CommunityIntroToggle.tsx:27` — const mutation = useMutation({
  mutationFn: async (next: boolean) => {
    if (!userId) throw new Error("Not authenticated");
    await setCommunityIntroOptIn(userId, next);
    return next;
  },
  onSuccess: (next) => queryClient.setQueryData(queryKey, next),
  onError: () => notifyError("screens.settings.communityIntroSaveFailed"),
});

Suggestion: Either (a) apply the migration BEFORE deploying the code changes (reverse the current implied ordering), or (b) make the code change backward-compatible: write `community_intro_choice_at` only if the column exists (e.g. catch column-not-found errors and retry writing only `community_intro_opt_in`), or (c) split the code change into two deploys — first the migration, then the code that writes the new column. The plan should specify a concrete ordering guarantee.

### R1-F2 [major]

The plan's endpoint spec says the query includes 'member's tenant' as a filter, but the existing browser queries in useAllNewsFeed.ts and useNewsFeed.ts do NOT explicitly filter by tenant — they query `global_community_profiles` under client-side RLS without any tenant_id filter. The new gateway endpoint will use the service-role Supabase client (no RLS), so it must either replicate the tenant scoping that RLS provides or intentionally omit it. The plan does not specify how tenant_id filtering is applied in the endpoint. If the table is truly global (no tenant RLS), adding a tenant filter changes visible membership. If RLS does restrict by tenant, omitting the filter in the gateway leaks cross-tenant data.

- `exafyltd/vitana-v1:src/hooks/useAllNewsFeed.ts:201` — supabase
  .from("global_community_profiles")
  .select("user_id, display_name, avatar_url, bio, created_at, community_intro_opt_in")
  .eq("is_visible", true)
  .eq(COMMUNITY_INTRO_COLUMN, true)
  .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
  .order("created_at", { ascending: false })
  .limit(5)
- `exafyltd/vitana-platform:services/gateway/src/routes/community-members.ts:20` — import { Router, Request, Response } from 'express';
import { requireAuth, requireTenant, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { fetchExcludedTestServiceAccountIds } from '../lib/excluded-test-service-accounts';

Suggestion: Determine the RLS policy on `global_community_profiles` and state explicitly whether the gateway endpoint filters by `tenant_id` or not. If the table is truly global and all tenants see all profiles today, the endpoint must NOT filter by tenant (and the spec should remove 'member's tenant'). If RLS does restrict by tenant, the endpoint must add an explicit `.eq('tenant_id', identity.tenant_id)` filter since it uses the service-role client.

### R1-F3 [minor]

The plan references `search_mention_candidates` in vitana-v1 migration `20261006140000` as a precedent for SECURITY DEFINER database functions, but code search found no results for this migration or function name in vitana-v1. The reference may be stale or wrong. This is used only as a justification for the alternative approach (endpoint over migration), not as something being modified, so it doesn't affect correctness.

- `exafyltd/vitana-v1:src/hooks/useAllNewsFeed.ts:201` — supabase
  .from("global_community_profiles")
  .select("user_id, display_name, avatar_url, bio, created_at, community_intro_opt_in")
  .eq("is_visible", true)
  .eq(COMMUNITY_INTRO_COLUMN, true)
  .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
  .order("created_at", { ascending: false })
  .limit(5)

Suggestion: Verify the migration name/number and correct the reference if needed, or remove it if the migration was never merged.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
