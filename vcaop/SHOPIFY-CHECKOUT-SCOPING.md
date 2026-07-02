# Scoping — In-app checkout for Shopify merchants (VCAOP)

**Status:** scoping / not started · **Author:** Claude Code · **Date:** 2026-06-30
**Initiative:** VCAOP — Vitanaland Commerce
**Relates to:** Discover marketplace (VTID-02000), Shopify sync (VTID-01930), Universal Cart (VTID-03213/03237)

---

## 1. Goal

Give members a **complete in-app journey — select → cart → checkout → confirmation —
without leaving MAXINA**, for the merchants where that is technically and legally
possible. Today every "Buy" is an **affiliate redirect** to the merchant's own site;
the user finishes checkout there. This scopes the one path that can be brought
fully in-app.

## 2. The honest feasibility matrix

| Provider | In-app checkout feasible? | Why |
|----------|---------------------------|-----|
| **Shopify stores** (first-party Vitana store + partner shops) | ✅ **Yes** | Storefront API exposes a headless **Cart** with a `checkoutUrl`; Shopify hosts the PCI-compliant payment step. We can drive cart entirely in-app and hand off to a Shopify-hosted checkout (web view / embedded), with order confirmation back. |
| **Amazon** | ❌ No | No third-party "place order / take payment on the user's behalf" API. SP-API is seller-side. Affiliate/recommendations only. |
| **eBay** | ❌ No | EPN is affiliate-only; no consumer checkout-on-behalf API. |
| **AliExpress / Alibaba (via Admitad)** | ❌ No | Affiliate network; checkout happens on AliExpress. |

**Conclusion:** "select → pay → done, all in MAXINA" is achievable **only for
Shopify-based merchants**. Everything else stays on the existing affiliate-redirect
model (already shipped, rewards-bearing). This initiative is therefore explicitly
**Shopify-scoped**; it does not change the Amazon/eBay/AliExpress flows.

## 3. What already exists (reuse, don't rebuild)

- **Storefront API client + per-merchant credentials.** `services/gateway/src/services/marketplace-sync/providers/shopify.ts` + `shopify-sync.ts` already authenticate to each shop via `domain` + `storefront_access_token` (stored in `marketplace_sources_config`). Currently **read-only catalog sync**. The same token + GraphQL endpoint can run cart/checkout mutations.
- **Catalog.** Shopify products already ingest into `products` (`source_network='shopify'`, real `merchant_id`, `affiliate_url`). The "Vitanaland (Shopify)" merchant + a demo product already exist.
- **Universal Cart.** `universal_carts` / `universal_cart_items` + `services/gateway/src/services/checkout/checkout-service.ts` (`checkoutUniversalCart`) already model a cart and a checkout ladder (first-party wallet debit vs affiliate redirect). This is the natural place to add a "Shopify headless" branch.
- **Discover + cart UI** on the frontend, and the new **Shopping & Rewards** connectors surface.

## 4. Proposed model — Storefront API headless cart → `checkoutUrl`

The modern, supported, low-PCI-burden path (Shopify deprecated the old Checkout API in favour of Cart + hosted checkout):

```
User adds Shopify products to the Universal Cart (in-app, existing)
        │
        ▼  at checkout, for the Shopify merchant_route:
Gateway → Shopify Storefront GraphQL  cartCreate(lines: [{merchandiseId, quantity}])
        │   (merchandiseId = product variant GID; needs variant id in catalog)
        ▼
returns cart.id + cart.checkoutUrl   (Shopify-hosted, PCI handled by Shopify)
        │
        ▼
App opens checkoutUrl in an in-app browser / embedded web view
(prefilled; member completes payment on Shopify's secure page)
        │
        ▼  order confirmation via:
  - Shopify webhook (orders/create) → gateway → mark cart_order converted, credit rewards, OR
  - return/landing deep-link back into MAXINA (thank-you screen)
```

**Why not a fully custom in-app payment form?** That pulls us into PCI-DSS scope and
card handling — explicitly against the guardrails. Shopify-hosted checkout keeps card
data off our systems while still feeling integrated (especially via an in-app web view
in the Appilix wrapper).

## 5. Work breakdown

### Backend (gateway)
1. **Storefront cart service** — extend the existing Shopify client with `cartCreate` / `cartLinesAdd` mutations; return `{ cartId, checkoutUrl }`. (New: `services/gateway/src/services/marketplace-sync/shopify-checkout.ts` or a `ShopifyConnector` cart method.)
2. **Catalog: capture variant GIDs.** Storefront cart needs the **variant** `merchandiseId`, not the product id. Extend Shopify sync to store `source_variant_id` on `products` (schema migration).
3. **Checkout-service branch.** In `checkoutUniversalCart`, for a `merchant_route` whose product `source_network='shopify'`, build a Storefront cart and return `checkoutUrl` instead of (or alongside) the affiliate redirect. Persist `cart_order`/`merchant_route` as `pending_shopify`.
4. **Order confirmation.** Register a Shopify `orders/create` webhook per shop (or poll); on receipt, mark the order converted + run the existing rewards/commission path. (Reuse `connector-webhooks.ts`.)
5. **Secrets/config.** Storefront tokens already in `marketplace_sources_config`; ensure they're treated as secrets (Secret Manager) and never returned to the client.

### Frontend (vitana-v1)
6. **Cart → "Checkout in app".** For Shopify items, call the gateway checkout, receive `checkoutUrl`, open it in an in-app browser (Appilix web view / new tab on desktop).
7. **Return/thank-you screen** + cart clear on success.
8. **Connectors copy.** Flip Shopify tiles from "Coming soon" → live once a real shop is connected; keep non-Shopify tiles on the affiliate-redirect copy.

### Identity (optional, Phase 2)
9. **Shopify customer accounts** — let members link a Shopify customer (Customer Account API / multipass) so checkout is pre-authenticated and order history syncs. Not required for v1 (guest checkout works).

## 6. Guardrails / constraints
- **No card data on our systems** — Shopify hosts payment (keeps us out of PCI-DSS scope).
- **No storing user merchant passwords** — Phase 2 uses OAuth/customer-account tokens, not credentials.
- **Store-owner Storefront tokens** are platform secrets → Secret Manager, never client-exposed.
- **FTC/affiliate disclosure** still shown; rewards attribution continues through the existing ledger.
- **Scope guard:** this never applies to Amazon/eBay/AliExpress — those stay affiliate-redirect.

## 7. Phasing & rough effort (engineering, excludes merchant onboarding)
- **Phase 0 — variant ids** (catalog migration + sync change): ~0.5–1 day.
- **Phase 1 — Storefront cart + `checkoutUrl` + frontend hand-off** (guest checkout, redirect-to-hosted): ~3–5 days. Delivers the "in-app cart → seamless hosted checkout" experience for one connected Shopify shop.
- **Phase 2 — order webhook + rewards reconciliation + thank-you screen**: ~2–3 days.
- **Phase 3 (optional) — Shopify customer-account linking** for pre-auth checkout + order history: ~3–5 days.

## 8. Open decisions (need product input before building)
1. **Which Shopify shop(s) first?** A first-party Vitana store, or an existing partner shop? (Determines whose Storefront token we use + who fulfils.)
2. **Checkout surface:** in-app web view over Shopify-hosted checkout (recommended, lowest risk) vs. a more custom flow? 
3. **Rewards on first-party Shopify sales:** wallet credit %? (Different from affiliate cashback — these are our own margins.)
4. **Guest vs. account-linked** checkout for v1 (recommend guest first).

## 9. Out of scope
- In-app checkout for Amazon / eBay / AliExpress (not possible — affiliate redirect remains).
- Handling card/payment data ourselves (Shopify hosts it).
- Replacing the affiliate-rewards model for non-Shopify merchants.

---

**Recommendation:** start with **Phase 0 + Phase 1 against one first-party Vitana
Shopify store** to prove the seamless cart→hosted-checkout journey end-to-end, then
add webhooks/rewards (Phase 2). This reuses the existing Storefront client, catalog,
and Universal Cart, so it is incremental — not a rebuild.
