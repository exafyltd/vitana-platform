# Sparring round 1 — in_progress

Session: `9ba4ff16-6836-4eaa-a3e5-acbc715f4fc3` · plan hash `0c79db96c9b6692cf3a01d9abca38901ff8fe986d364a2443fcc7c1a8c9690a3`

## Summary

Nine premises were verified against the pinned commit. Three require action before implementation. The most critical is a classification error in the discovery-reader inventory: `shop-feed-repository.ts:32` (`fetchProductsByIds`) is dual-use (video-anchor discovery AND saved-products hydration) yet the plan stamps it "fulfilment → unfiltered", leaving a concrete tenant-gate bypass path for anchor-surfaced products. The second blocker is that the plan never specifies a write path for the proposed `product_orders.buyer_tenant_id` column; the table already has `tenant_id` carrying the buyer's tenant context (confirmed from service code), so the new column's semantic purpose and its insertion point both need to be defined. The third finding (major) is that the plan's stated "dual enforcement (RLS + predicate)" risk mitigation doesn't hold: the RLS on `products`/`merchants` enforces only `is_active = TRUE` with no tenant gate, and the gateway passes the service-role client for product reads, bypassing RLS entirely.

## Findings

### R1-F1 [blocker]

`shop-feed-repository.ts:32` (`fetchProductsByIds`) is dual-use — it hydrates both video-anchor products (new discovery surface) and saved products — yet the plan classifies `shop-feed:32` as 'fulfilment → unfiltered'. This leaves a concrete tenant-gate bypass: any product anchored to a shop video is returned without a `supplier_tenant_relationships` check, so a supplier active only for Tenant A is still surfaced to Tenant B users viewing shop videos, defeating the isolation guarantee the plan sets out to deliver.

- `exafyltd/vitana-platform:services/gateway/src/routes/shop-feed-repository.ts:31` — /** Reused for both the anchor-hydration lookup and the saved-products hydration lookup — identical query shape. */
export async function fetchProductsByIds(sb: SupabaseClient, productIds: string[]) {
  return sb
    .from('products')
    .select('id, title, description, brand, category, ... is_active')
    .in('id', productIds);
}

Suggestion: Split `fetchProductsByIds` into two call sites or two functions: one for saved-products hydration (legitimate fulfilment — already-held item) and one for video-anchor hydration (discovery — new product surface). Apply the full tenant-visibility predicate to the anchor path. The generated-inventory lint must flag the anchor path as 'discovery' and assert it goes through the predicate. Alternatively, reclassify the whole function as 'discovery' and accept the tenant check on saved-product hydration as well (safer default).

### R1-F2 [major]

The plan's 'dual enforcement (RLS + predicate)' risk mitigation is false in both respects. (1) The RLS backstop on `products` and `merchants` gates only on `is_active = TRUE` — there is no tenant column in either policy. If the application predicate fails, RLS will not stop cross-tenant product exposure. (2) The `shop-feed-repository.ts` module comment explicitly states that products queries use the service-role client, which bypasses RLS entirely. The Risks section says 'predicate is the single read path, RLS the backstop' and the plan cites 'the isolation suite asserts both' — but the backstop does not exist.

- `exafyltd/vitana-platform:supabase/migrations/20260416120000_vtid_02000_marketplace_foundation.sql:727` — CREATE POLICY merchants_select ON public.merchants FOR SELECT TO authenticated USING (is_active = TRUE);
...
CREATE POLICY products_select ON public.products FOR SELECT TO authenticated USING (is_active = TRUE);
- `exafyltd/vitana-platform:services/gateway/src/routes/shop-feed-repository.ts:14` — call sites that used the user-JWT client (shop_saved_products reads/writes, RLS owner-scoped) still pass that client in; the service-role call sites (shop_videos, shop_video_anchors, shop_video_events, products) still pass the service-role client in, exactly as before.

Suggestion: Either (a) add a tenant-scoped RLS policy to `products` and `merchants` as part of the supplier-relationships-db lane (e.g. `EXISTS (SELECT 1 FROM supplier_tenant_relationships WHERE ... AND tenant_id = current_tenant_id() AND status = 'active')`) so RLS is a genuine second layer, or (b) remove the 'dual enforcement / RLS backstop' language from the plan's Risk section and explicitly document that the application predicate is the sole enforcement layer, then ensure the predicate module is covered by circuit-breaker / fail-closed logic rather than fail-open.

### R1-F3 [major]

`product_orders` already has a `tenant_id` column carrying the buyer's tenant context (used with `.eq('tenant_id', tenantId)` alongside `.eq('user_id', userId)` in `fetchCompletedProductOrders`). The plan proposes adding a separate `buyer_tenant_id uuid` column (migration `20261101120300`) without (a) explaining the semantic difference from the existing `tenant_id`, or (b) specifying which service writes the new column at order-creation time. The commission-attribution code (`credit-recommender-repository.ts:28`) currently selects `id, state, commission_cents, currency, attribution_recommendation_id, merchant_id, product_id, user_id, click_id` — `tenant_id` is not even read there, and `buyer_tenant_id` will be NULL for every pre-migration order and for any order where no write path is implemented. D26 (referral attribution across tenants) will silently return NULL for all historical and newly-placed orders until the missing write path is added — violating the 'no silent fallback' governance rule.

- `exafyltd/vitana-platform:services/gateway/src/services/automation-handlers/health-action-initiative-repository.ts:69` — export async function fetchCompletedProductOrders(sb: SupabaseClient, tenantId: string, userId: string, limit: number) {
  return sb
    .from('product_orders')
    .select('id, product_id, purchased_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('state', 'completed')
    ...
- `exafyltd/vitana-platform:services/gateway/src/services/recommendation-commissions/credit-recommender-repository.ts:26` — export async function fetchProductOrderForCommission(sb: SupabaseClient, orderId: string) {
  return sb
    .from('product_orders')
    .select('id, state, commission_cents, currency, attribution_recommendation_id, merchant_id, product_id, user_id, click_id')
    .eq('id', orderId)
    .maybeSingle();
}

Suggestion: Before adding `buyer_tenant_id`: (1) Confirm whether `product_orders.tenant_id` is already the buyer's tenant. If yes, use it — extend `fetchProductOrderForCommission` to select `tenant_id` and use that for D26 attribution rather than introducing a redundant column. If the semantics genuinely differ (e.g. `tenant_id` = operator/seller context), document the distinction in the migration comment and add a dedicated write path in the checkout/postback service (`vcaop-postback` or equivalent) that populates `buyer_tenant_id` at order-creation time. The migration and the write path must ship in the same lane; the column must never be relied upon while it can still be universally NULL.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
