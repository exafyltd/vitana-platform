# Sparring round 2 — in_progress

Session: `b452b935-bde6-4df0-b1cc-646732601aa8` · plan hash `77acf233d03d934e176f184f42f20138f17624bb7edeec4ed272ac73f39d1a4a`

## Summary

Reviewed the revised plan against the pinned commit. All three prior findings (R2-F1 nullable product_orders.tenant_id, R2-F2 shop-feed-repository path, R2-F3 tenant_catalog_overrides RLS) were accepted and their premises verified as correct in code; the fixes are directionally sound. Two new issues raised: (1) the discovery-reader inventory must correctly resolve the tenant for by-id discovery initiators and health-automation product readers that today carry no tenant filter at all, and the plan's file/line citations for the health repos are imprecise; (2) the RLS backstop and predicate both depend on is_member()/tenant_id_for_policies() which do not yet exist in this repo, so the tenant-scoped RLS must be shipped inert (flag-guarded) or it will throw at first non-Maxina authenticated read.

## Findings

### R3-F1 [major]

The plan's Problem 10 classifies `health-wellness-repository.ts` as reading products at `:91` and health tables at `:28/:32/:44/:50/:55/:68`, and asserts the per-query lineage guard is needed because these modules mix a products read with sibling health reads. The premise holds, but the products reader `fetchActiveProductsByTopicKeys` (health-wellness-repository.ts:90-91) reads `products` filtered ONLY by `is_active = true` and `.overlaps('topic_keys', categories)` — it takes NO tenant parameter and has NO supplier/tenant gate, and it is a member-facing DISCOVERY surface (health-aware product recommendations, AP-0609). This is exactly the kind of global product reader the tenant gate must close, yet the plan's discovery/fulfilment/admin three-way classification has no obvious home for it: it is not an explicit-id hydration (fulfilment) nor an admin/ingestion surface, so it must be tagged `discovery` — but the function does not even receive a tenantId, so applying the discovery predicate here requires threading a resolved tenant into an automation path that the plan does not describe.

- `exafyltd/vitana-platform:services/gateway/src/services/automation-handlers/health-wellness-repository.ts:88` — export async function fetchActiveProductsByTopicKeys(sb: SupabaseClient, categories: string[], limit: number) {
    return sb.from('products').select('id, title, category').eq('is_active', true).overlaps('topic_keys', categories).limit(limit);
  }

Suggestion: In the design 'What exists' table and the generated inventory, classify `fetchActiveProductsByTopicKeys` (health-wellness-repository.ts:90) as `discovery` and specify how the tenant is resolved for the automation path (the automation context already carries `tenantId` for sibling queries, so thread it into this product read and apply the discovery predicate). Verify the inventory sweep includes this reader and that the build-failing lint would fail if it stayed unannotated. Correct the file/line citations for the health repos to the actual automation-handlers path.

### R3-F2 [major]

The tenant-scoped RLS backstop (R1-F2) replaces `products_select`/`merchants_select` with a policy using `current_tenant_id()` and an `EXISTS active supplier_tenant_relationships ... is_member(...)` term, and the predicate relies on mt-identity's `tenant_id_for_policies()`/`is_member()`. Neither `is_member( )` nor `tenant_id_for_policies()` exists as a function in this repo today — the only tenant-membership check in migrations is an inline `EXISTS (SELECT 1 FROM public.user_tenants ...)` (switch_to_tenant_by_slug) and inline `current_tenant_id()` calls. The plan lists these as mt-identity dependencies (landing elsewhere), which is acceptable, but the flag-guard must make the new RLS policy truly inert (fall back to the old `is_active = TRUE`) when mt-identity has not landed, otherwise the first authenticated non-Maxina user-JWT read of products/merchants will either throw (function does not exist) or silently return zero rows — both are regressions. The plan says 'flag-guarded so inert for Maxina', which only guarantees Maxina, not a deploy where the flag is on but the mt-identity functions are not yet applied.

- `exafyltd/vitana-platform:supabase/migrations/20261010180200_vtid_05043_s3_switch_tenant_open_signup_only.sql:65` — v_is_member := EXISTS (
      SELECT 1 FROM public.user_tenants ut
       WHERE ut.tenant_id = tenant_record.tenant_id AND ut.user_id = v_uid
    );
- `exafyltd/vitana-platform:supabase/migrations/20260913000002_vtid_03832_role_functions.sql:66` — v_tenant_id := public.current_tenant_id();

Suggestion: Make the tenant-scoped RLS replacement conditional on the mt-identity functions being present (e.g. guard the new policy body on a feature flag AND on the existence/availability of is_member()/tenant_id_for_policies(), falling back to the previous is_active-only policies otherwise). State explicitly in the migration notes that the new policy must be land-dark and inert until mt-identity ships, and add a pgTAP case asserting the old behaviour is preserved when the flag/function is absent. Note current_tenant_id() may return NULL for a signed-out anon read — the backstop should treat NULL tenant as 'no rows' rather than throw.

### R3-F3 [minor]

The plan's Problem 2 cites the by-id discovery initiator as `discover-recommendations-repository.ts:23` with no directory, and its `fetchActiveProductForRecommendation` reads products filtered only by `is_active = true` (no tenant/merchant gate). The actual file is `services/gateway/src/routes/discover-recommendations-repository.ts` (not under `services/`), and this is the discovery entry for the Recommend & Earn flow (`routes/discover-recommendations.ts` POST /recommendations). As with R2-F2, the path citation must be exact so the generated inventory and lane `paths` sweep the `routes/**` directory and this reader is correctly annotated `discovery` (it is an open-initiation read: a recommender looks up a product by arbitrary id to mint a share link, so it is a real leak surface if left unfiltered).

- `exafyltd/vitana-platform:services/gateway/src/routes/discover-recommendations-repository.ts:22` — export async function fetchActiveProductForRecommendation(sb: SupabaseClient, productId: string) {
    return sb.from('products').select('id, merchant_id, title, is_active').eq('id', productId).eq('is_active', true).maybeSingle();
  }

Suggestion: Cite the correct path `services/gateway/src/routes/discover-recommendations-repository.ts:23` in the 'What exists' table and tasks P2, and confirm this reader is tagged `discovery` (full predicate) in the generated inventory so a recommender in tenant B cannot mint a share link for a tenant-A-only product.

## Acknowledgements of earlier responses

- R2-F1: acknowledged — Verified the nullable tenant_id migration and the Awin sync reading product_clicks.tenant_id; the revised 'reuse existing product_orders.tenant_id + explicit buyer_tenant_source' decision is sound and removes the false NOT NULL premise.
- R2-F2: acknowledged — The full path services/gateway/src/routes/shop-feed-repository.ts is confirmed and the dual-use/anchor=discovery classification is correct; the plan now commits to sweeping all of services/gateway/src/**.
- R2-F3: acknowledged — Confirmed tenant_catalog_overrides_select at :809-811 and service policy at :812; the service-role read with explicit tenant filter approach is correct.

## Next

Planner: answer every finding above in `sparring/s2-responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
