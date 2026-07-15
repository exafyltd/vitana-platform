# Awin Product Activation Runbook

**How real affiliate products get onto `/discover` — and what gates it.**

This is the affiliate-first path: members browse real merchant products, click
through, buy on the merchant's site, Vitana earns commission. No owned
inventory required.

---

## The two gates

| Gate | In our control? | What it is |
|------|-----------------|------------|
| **1. Advertiser approval** | ❌ External (Awin + the merchant) | A product datafeed only exists for advertisers you are **joined/approved** with. Approvals are applied for in the Awin dashboard and granted by each merchant. |
| **2. Feed configuration** | ✅ Ours | Each approved advertiser's `feed_id` must be saved into an Awin source config. The discovery endpoint below removes the manual lookup. |

> As of this writing only **ROCKBROS** (cycling gear) is a joined Awin
> advertiser. A real *health* catalog depends on Gate 1 — approvals for
> DocMorris, Shop Apotheke, MyProtein, Sunday Natural, Otto, etc. There is no
> code path that bypasses an advertiser approval.

---

## One-time prerequisite: the datafeed API key

Awin product-feed downloads authenticate with a **publisher datafeed API key**
(stamped into the `productdata.awin.com` URL path — this is *not* the OAuth
Bearer token used by the programme harvest). Find it in the Awin dashboard
under **Toolbox → Create-a-Feed / Product Feeds**, or **My Account → API
Credentials**.

Provide it one of three ways (checked in this order by the discovery endpoint):
1. `?api_key=` query parameter, or
2. an already-saved Awin source (`marketplace_sources_config.config.api_key`), or
3. the `AWIN_DATAFEED_API_KEY` env var on the gateway (falls back to
   `AWIN_API_TOKEN` as a last resort).

---

## Activation steps

### 1. Discover available feeds (no manual feed_id lookup)

```
GET /api/v1/admin/marketplace/awin/feeds?joined_only=true&api_key=<DATAFEED_KEY>
```
(tenant-admin auth required)

Returns every product feed your key can download, plus a ready-to-save
`suggested_config`:

```json
{
  "ok": true,
  "count": 1,
  "feeds": [
    { "feed_id": "12345", "advertiser_id": "67890",
      "advertiser_name": "ROCKBROS", "primary_region": "DE",
      "membership_status": "joined", "product_count": 480 }
  ],
  "suggested_config": {
    "api_key": "<DATAFEED_KEY>",
    "publisher_id": "<SID>",
    "feeds": [{ "feed_id": "12345", "advertiser_id": "67890", "advertiser_name": "ROCKBROS" }],
    "max_products_per_feed": 500
  }
}
```

### 2. Save the source

POST the `suggested_config` (trim feeds to the advertisers you want):

```
POST /api/v1/admin/marketplace/sources
{ "source_network": "awin", "display_name": "Awin (DE health)",
  "config": <suggested_config>, "is_active": true }
```

Or use the Command Hub **Add source → Awin** form (same provider schema).

### 3. Sync products into the catalog

```
POST /api/v1/admin/marketplace/sync/awin
```
Or wait for the daily `MARKETPLACE-SYNC-CRON.yml` run at 03:00 UTC. Products
land in `products` with `source_network='awin'`.

### 4. Verify on `/discover`

A row is feed-eligible (see `discover-feed.ts`) when:
`is_active=TRUE`, `availability='in_stock'`, ships to the member's
country/region, and the origin passes their scope. Products flagged
`requires_admin_review` wait in the moderation queue
(`/api/v1/admin/marketplace/products?requires_admin_review=true`).

---

## Where the code lives

| Piece | File |
|-------|------|
| Feed discovery (`listAwinFeeds`) | `services/gateway/src/services/marketplace-sync/awin-sync.ts` |
| Discovery endpoint | `services/gateway/src/routes/admin-marketplace.ts` (`GET /awin/feeds`) |
| Product feed sync (`runAwinSync`) | `services/gateway/src/services/marketplace-sync/awin-sync.ts` |
| Provider registration | `services/gateway/src/services/marketplace-sync/providers/awin.ts` |
| Programme harvest (joined → `affiliate_program`) | `services/gateway/src/services/awin-sync.ts` |
| Discover feed query | `services/gateway/src/routes/discover-feed.ts` |
