# Sparring round 1 — in_progress

Session: `b452b935-bde6-4df0-b1cc-646732601aa8` · plan hash `67557698b7dff5a954e70837671a46289d53e6b531b388dea286d4356f2c2416`

## Summary

The plan is well-researched and most reader-classification premises verified accurately. However, one core data-model premise is now FALSE and undermines the D26 decision: `product_orders.tenant_id` was made NULLABLE by migration 20260929120200 (VTID-04740, anonymous buyers), directly contradicting the plan's twice-stated claim that it is `UUID NOT NULL` and that a nullable column would be a never-written regression. The plan's reasoning for reusing the existing column relies on that NOT NULL premise; for anonymous referral orders the existing `tenant_id` IS now NULL, which collides with the plan's own "never silently NULL" test requirement and the D26 attribution design. This must be corrected before implementation: either accept NULL tenant for anonymous orders in the D26 read-path (and define fallback attribution), or add a separate write path/buyer-tenant column as the plan explicitly rejected. RLS premises, dual-use fetchProductsByIds, mixed-module health repos, and the free-text partner_tenant.tenant_id all verified correct.

## Findings

### R2-F1 [blocker]

The plan's central D26 premise is false: `product_orders.tenant_id` is no longer `UUID NOT NULL`. Migration `20260929120200_vtid_04740_product_orders_tenant_nullable.sql` runs `ALTER TABLE public.product_orders ALTER COLUMN tenant_id DROP NOT NULL` because VTID-04740 makes anonymous (signed-out) referral buyers' orders carry NULL tenant. The plan twice asserts `tenant_id UUID NOT NULL` (Problem 8 and the supplier-relationships-db fix), and uses that to justify dropping a new `buyer_tenant_id` column on the grounds that 'a nullable buyer_tenant_id would be NULL for all historical/new orders until a write path existed (silent-fallback, R1-F3)'. But the EXISTING column already is that nullable column with NULL for anonymous/new orders right now. Reusing it therefore produces exactly the silent-NULL outcome the plan claims to avoid, and contradicts the plan's own test requirement that referral attribution 'is never silently NULL'. The D26 read-path (fetchProductOrderForCommission not selecting tenant_id) and the 'no new column' decision must be reconsidered for the anonymous-buyer case.

- `exafyltd/vitana-platform:supabase/migrations/20260929120200_vtid_04740_product_orders_tenant_nullable.sql:1` — ALTER TABLE public.product_orders ALTER COLUMN tenant_id DROP NOT NULL; ... NULL is the honest value for an unknown buyer's tenant; the recommender's tenant is not the buyer's.
- `exafyltd/vitana-platform:supabase/migrations/20260416120000_vtid_02000_marketplace_foundation.sql:529` — user_id UUID NOT NULL, tenant_id UUID NOT NULL,

Suggestion: Re-verify D26 against the nullable `product_orders.tenant_id`. Decide and document the attribution for anonymous referral orders where tenant_id is NULL (e.g. attribute to platform tenant, or to the recommender's tenant, or explicitly accept NULL and encode it in the read-path AND the 'never silently NULL' test). Do not rely on the NOT NULL invariant, which no longer holds. If a non-null buyer tenant is required for commissions, the plan needs a real write path/population strategy for that column rather than assuming historical-new orders all have it.

### R2-F2 [major]

The plan cites `shop-feed-repository.ts` as `shop-feed-repository.ts:32` and `:43` without a directory, and in Problem-2 classifies the dual-use fetchProductsByIds 'module comment :31'. The actual file is `services/gateway/src/routes/shop-feed-repository.ts` (not under `services/`). The lane `paths` and the build-failing inventory/lint must target the correct path, otherwise Lane-scope CI fails on the first touch or the lint silently misses this reader, leaking the shop-video-anchor discovery path. The classification itself (dual-use, anchor=discovery, saved-products=fulfilment) is correct.

- `exafyltd/vitana-platform:services/gateway/src/routes/shop-feed-repository.ts:31` — /** Reused for both the anchor-hydration lookup and the saved-products hydration lookup — identical query shape. */ export async function fetchProductsByIds(sb: SupabaseClient, productIds: string[]) {

Suggestion: Reference the correct path `services/gateway/src/routes/shop-feed-repository.ts` in the design 'What exists' table, the lane `paths`, and the generated inventory. Verify the inventory glob/sweep includes `routes/**` (not just `services/**`).

### R2-F3 [minor]

Premise #3 claims `tenant_catalog_overrides` RLS `_select` policy is 'bare `tenant_id = current_tenant_id()`'. The table is created at foundation `:326-336`, but its RLS SELECT policy is NOT defined in the RLS section of that migration (lines 700-800 define policies for merchants/products/catalog_sources/geo_policy/etc. but no `tenant_catalog_overrides` policy). The predicate v1 depends on 'no tenant_catalog_overrides hide', so the unverified premise that this table has a working per-tenant RLS read policy is material to whether the predicate can even read overrides for the resolved tenant via user-JWT (or whether it must use service-role).

- `exafyltd/vitana-platform:supabase/migrations/20260416120000_vtid_02000_marketplace_foundation.sql:326` — CREATE TABLE IF NOT EXISTS public.tenant_catalog_overrides ( id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, target_type TEXT ...)

Suggestion: Confirm where `tenant_catalog_overrides` RLS policy lives (possibly a later migration) and which role the predicate uses to read it. If no per-tenant policy exists, the predicate must read overrides with service-role (bypassing RLS) — document that and ensure the override-hide is itself tenant-scoped by the predicate's own `tenant_id` filter, not by RLS.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
