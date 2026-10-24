# Responses to sparring round 1 (session 2, `b452b935-bde6-4df0-b1cc-646732601aa8`)

```json
[
  {
    "finding_id": "R2-F1",
    "disposition": "accepted",
    "rationale": "Verified: 20260929120200_vtid_04740_product_orders_tenant_nullable.sql:12 runs ALTER TABLE public.product_orders ALTER COLUMN tenant_id DROP NOT NULL, with the column comment 'Buyer's tenant. NULL when the buyer was signed out (anonymous referral sale, VTID-04740)'; the foundation definition (20260416120000…sql:529) is no longer the live shape. The NOT NULL premise is removed everywhere. Decision: still no new column (a second buyer_tenant_id would duplicate a column checkout and the Awin sync already write), and the anonymous case is now explicit: buyer_tenant_id = product_orders.tenant_id with buyer_tenant_source 'order' when non-NULL and 'anonymous_buyer' when NULL; a NULL is kept as the honest value (as the VTID-04740 comment requires) and never replaced by the recommender's, the platform or DEFAULT_TENANT_ID; recommender earnings follow recommender_tenant_id = resolvePrimaryTenant(recommender_user_id) (services/tenancy/tenant-context.ts:43). M2 carries the three fields on the commission OASIS events and the credit result; ledger columns on recommendation_commissions belong to the per-tenant money work (M3, already Out of scope). The 'never silently NULL' test is replaced by: signed-in order => 'order' + tenant; anonymous order => null + 'anonymous_buyer'. Also corrected the fetchProductOrderForCommission citation to credit-recommender-repository.ts:26-32 and fetchMerchantCommissionEligibility to :112. Updated plan.md Problem 8 + Fix (supplier-relationships-db) + Tests, design.md, tasks.md S4/S6, supplier-relationships-db lane log.",
    "deferred_to": null
  },
  {
    "finding_id": "R2-F2",
    "disposition": "accepted",
    "rationale": "Verified the file is services/gateway/src/routes/shop-feed-repository.ts (comment :31, fetchProductsByIds :32, fetchRankedShopVideosPage :43). The lane paths (discover-shared-predicate.md:14) and tasks.md Allowed paths (:44) already carry this full path, so Lane-scope CI is unaffected; plan.md used the short form. plan.md now cites the full path at every mention, and states that the generated inventory sweeps ALL of services/gateway/src/** (routes/** and services/** alike) for .from('products')/.from('merchants'), so this reader cannot be missed.",
    "deferred_to": null
  },
  {
    "finding_id": "R2-F3",
    "disposition": "accepted",
    "rationale": "The policy does exist, in the same foundation migration: 20260416120000_vtid_02000_marketplace_foundation.sql:807 enables RLS on tenant_catalog_overrides, :809-811 create tenant_catalog_overrides_select FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id()), :812 tenant_catalog_overrides_service FOR ALL TO service_role, and :857 grants SELECT to authenticated — plan.md Problem 3 now cites these lines. The role question is adopted: the predicate reads on the gateway's service-role client (getSupabase()), which bypasses RLS, so it reads overrides with an explicit .eq('tenant_id', resolvedTenantId) filter and never relies on current_tenant_id(); the policy remains only a user-JWT backstop. A Jest case asserts the override read carries the tenant filter. Updated plan.md Problem 3 + Fix (discover-shared-predicate) + Tests, design.md, supplier-relationships-db lane log.",
    "deferred_to": null
  }
]
```
