# Sparring round 1 (session 9ba4ff16) — responses

All three findings verified at the cited file:line against the pinned commit and ACCEPTED.

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Verified `shop-feed-repository.ts:32 fetchProductsByIds` and its module comment at `:31`: it is explicitly reused for BOTH video-anchor hydration AND saved-products hydration. The video-anchor call site is a discovery surface (products anchored to shop videos a member browses), so stamping the whole function 'fulfilment → unfiltered' left a real tenant-gate bypass — a supplier active only for Tenant A would surface to Tenant B via a shop-video anchor. Fix: split the function/call sites — anchor path = DISCOVERY through the predicate; saved-products path = FULFILMENT (unfiltered). The generated-inventory lint classifies by call site, never the whole function. Updated plan.md Problem 2 + Fix + Tests, tasks.md P2/P5, lane discover-shared-predicate body.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Verified `products_select`/`merchants_select` at `supabase/migrations/20260416120000_vtid_02000_marketplace_foundation.sql:729/:735` — both USING (`is_active = TRUE`) with no tenant column; and the shop-feed module comment at `:14` confirms products reads use the service-role client (RLS bypassed). The plan's 'dual enforcement (RLS + predicate)' / 'RLS the backstop' Risk language was therefore false. Fix (option a): the DB lane's 4th migration now replaces those two policies with tenant-scoped policies (`is_active AND (distribution='network' OR EXISTS active supplier_tenant_relationships for current_tenant_id())`), flag-guarded so inert for Maxina (D7); this backstops authenticated/user-JWT reads. Documented that the predicate remains the sole enforcement layer for service-role reads and is fail-CLOSED (unresolved tenant/predicate error → no rows). Updated plan.md Risks + DB Fix + Migrations + Tests, tasks.md D4/D6, lane supplier-relationships-db path+body.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Verified `product_orders` already has `tenant_id UUID NOT NULL` in its CREATE TABLE (`...foundation.sql`), the buyer's tenant, filtered `.eq('tenant_id', tenantId)` in `health-action-initiative-repository.ts:71` and `admin-scanners/marketplace-repository.ts:42`; and `fetchProductOrderForCommission` (`credit-recommender-repository.ts:28`) does not select it. A new nullable `buyer_tenant_id` would be NULL for every historical and new order until a write path existed — a silent-fallback for D26. Fix: dropped the `buyer_tenant_id` column entirely; D26 reuses the existing `product_orders.tenant_id` by extending `fetchProductOrderForCommission` to select it (code change in the `supplier-onboarding-communities` S4 task, whose paths already include credit-recommender). Updated plan.md Problem 8 + Fix + Migrations + Tests, tasks.md D4/S4.",
    "deferred_to": null
  }
]
```
