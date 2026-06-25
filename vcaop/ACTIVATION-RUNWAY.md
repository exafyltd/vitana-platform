# VCAOP — Affiliate Catalog Activation Runway

> **Goal:** real, buyable affiliate products on `/discover`.
> **Audience:** operator (you). These are the steps Claude **cannot** do — they
> need Secret-Manager access, the Admitad/Awin panels, and advertiser approvals.
> **Status as of 2026-06-25:** code is in place (Admitad PR #2786, Awin #2784);
> `/discover` still shows only Shopify (26) + demo-seed (10). Zero affiliate
> products until the steps below run.

The two halves of "products on /discover":
1. **Catalog ingestion** (code — done): pulls products into the `products` table.
2. **Activation** (operator — this doc): credentials + an approved advertiser
   with a feed + a verified first sync.

---

## 0. Prerequisites (one-time)

- [ ] **Merge + deploy the catalog code.** #2786 (Admitad) and #2784 (Awin
      discovery) merge to `main` → auto-deploy to **staging**; then **PUBLISH**
      in the Command Hub to reach prod. (Per CLAUDE.md §16 — push never reaches
      prod directly post-cutover.)
- [ ] **`MARKETPLACE_SYNC_SECRET`** is set on the gateway (Cloud Run env /
      Secret Manager). Required to trigger a manual sync. Confirm:
      `gcloud run services describe gateway --region=us-central1 --project=lovable-vitana-vers1 --format='value(spec.template.spec.containers[0].env)' | tr ',' '\n' | grep MARKETPLACE_SYNC_SECRET`

Prod gateway base URL: `https://gateway-86804897789.us-central1.run.app`
(staging: `https://preview-gateway.vitanaland.com`). Resolve dynamically if unsure
(CLAUDE.md §11).

---

## 1. ADMITAD — closest to live

**Already joined (rewards-allowed) advertisers** (`affiliate_program`):

| id | merchant | fit | gotolink |
|----|----------|-----|----------|
| `admitad_bodylab24_de` | **Bodylab24 DE** | ★ German sports nutrition / supplements — best /discover fit | `https://ad.admitad.com/g/q51r4zfcu5…` |
| `admitad_alibaba_ww` | Alibaba WW | general marketplace | `https://rzekl.com/g/pm1aev55cl…` |
| `admitad_aliexpress` | AliExpress | general marketplace | `https://rzekl.com/g/1e8d114494…` |

### Step 1.1 — Confirm Admitad Products API access
The Products API (scope `products`) is **account-gated** on Admitad — on some
publisher tiers it must be explicitly enabled/requested. Verify before anything else:
- In the Admitad panel, confirm the Products/Product-feeds product is enabled for
  the publisher account, **or** test the token mints with `scope=products`:
  ```bash
  curl -s -X POST https://api.admitad.com/token/ \
    -H "Authorization: Basic $VCAOP_ADMITAD_BASE64_HEADER" \
    -d "grant_type=client_credentials&client_id=<CLIENT_ID>&scope=products"
  # Expect: {"access_token":"…"}. If it errors on scope → request Products API access first.
  ```
> ⚠️ **If `scope=products` is not granted, Admitad catalog ingestion cannot run**
> regardless of code. This is the single biggest unknown — check it first.

### Step 1.2 — Bind credentials (if not already on the gateway)
Secrets already exist in Secret Manager as `VCAOP_ADMITAD_*`. Ensure they're
exposed to the **gateway** service as env:
`VCAOP_ADMITAD_CLIENT_ID`, `VCAOP_ADMITAD_CLIENT_SECRET` (or `VCAOP_ADMITAD_BASE64_HEADER`).

### Step 1.3 — Get the numeric campaign IDs
The Products API filters by **numeric campaign (advertiser) id** — the
`affiliate_program` rows store gotolinks, not the numeric ids. From the Admitad
panel (Programs → joined) note the campaign id for **Bodylab24 DE** (and any
others you want). *(Or skip filtering — see Step 1.4 note.)*

### Step 1.4 — Create the source config row
```sql
insert into marketplace_sources_config (source_network, display_name, config, is_active)
values (
  'admitad',
  'Admitad — Bodylab24 DE',
  '{
     "campaign_ids": ["<BODYLAB24_CAMPAIGN_ID>"],
     "gotolink_base": "https://ad.admitad.com/g/q51r4zfcu52fafe74eabfad1369401/",
     "merchant_country": "DE",
     "max_products": 1000,
     "page_size": 200
   }'::jsonb,
  true
);
```
- Omit `client_id`/`client_secret` → falls back to the `VCAOP_ADMITAD_*` env.
- **`campaign_ids` blank** → pulls the whole connected catalog (all advertisers).
  In that case prefer per-product deeplinks from the API; a single `gotolink_base`
  only attributes one advertiser, so use **one config row per advertiser** when
  mixing networks/gotolinks.

### Step 1.5 — Run the first sync + VERIFY (critical)
```bash
curl -s -X POST "$GW/api/v1/internal/sync/admitad" \
  -H "X-Scheduler-Secret: $MARKETPLACE_SYNC_SECRET" | jq .
```
Then **verify the field mapping** (the Admitad product schema is defensively
mapped but unverified live):
1. **Sample-key log** — in gateway logs find:
   `[admitad-sync] campaign=<id> fetched=<n> sample_keys=[...]`
   Confirm the real field names line up with the normalizer's candidates
   (`name/title`, `price/search_price`, `picture/image_url`, `deeplink/gotolink`,
   `available/in_stock`, `vendor/brand`, …). If they differ → tell Claude the
   `sample_keys` and a sample row; the normalizer candidates get adjusted + redeployed.
2. **Spot-check the rows**:
   ```sql
   select count(*) from products where source_network='admitad';
   select title, price_cents, currency, availability, affiliate_url,
          (raw->>'name') as raw_name
   from products where source_network='admitad' limit 5;
   ```
   - Titles/prices populated? `affiliate_url` a real deeplink? `availability='in_stock'`?
   - If `affiliate_url` is just the bare product URL (no gotolink), the API didn't
     return per-product deeplinks → set/verify `gotolink_base`.

### Step 1.6 — Confirm on /discover
Products appear when `is_active=true` AND `availability='in_stock'` AND they pass
the shipping/region + health-limitation filters (discover-feed.ts). Check a DE user.

---

## 2. AWIN — code ready (#2784), needs a feed

Only **ROCKBROS** is joined on Awin today (not wellness). Awin needs a per-advertiser
**product feed** (feed_id + advertiser_id), unlike Admitad.

### Step 2.1 — Datafeed API key
Awin My Account → API Credentials → the **product-feed** key (distinct from the
publisher API token). Bind as `AWIN_DATAFEED_API_KEY` (per #2784) or put `api_key`
in the config row.

### Step 2.2 — Discover available feeds
#2784 adds feed discovery — list the feeds this publisher can download
(advertisers you're joined to that offer a datafeed) to get `feed_id` + `advertiser_id`.

### Step 2.3 — Source config row
```sql
insert into marketplace_sources_config (source_network, display_name, config, is_active)
values ('awin','Awin',
  '{"api_key":"<DATAFEED_KEY>","publisher_id":"<SID>",
    "feeds":[{"feed_id":"<FID>","advertiser_id":"<MID>","advertiser_name":"<name>"}],
    "merchant_country":"DE","max_products_per_feed":500}'::jsonb, true);
```

### Step 2.4 — Sync + verify
```bash
curl -s -X POST "$GW/api/v1/internal/sync/awin" -H "X-Scheduler-Secret: $MARKETPLACE_SYNC_SECRET" | jq .
```
Same verification as Admitad (counts + sample rows in `products`).

### Step 2.5 — Approvals (the real bottleneck)
Apply on Awin to wellness/German advertisers with datafeeds (DocMorris, Shop
Apotheke, MyProtein, Sunday Natural, Otto, …). As each approval lands, add its
`{feed_id, advertiser_id}` to the config `feeds` array.

---

## 3. Go-live (both networks)

- [ ] First manual sync verified (Step 1.5 / 2.4) — rows present, mapping correct.
- [ ] `/discover` shows the products for a matching-region user.
- [ ] The **daily cron** (`MARKETPLACE-SYNC-CRON.yml`, 03:00 UTC) runs all
      providers — once a network verifies, it stays fresh automatically.
- [ ] Per-user rewards: the existing `/api/v1/vcaop/affiliate-link` layer wraps the
      catalog deeplink with the member SubID at click time (already built); Admitad
      postback (#earlier) and Awin conversion worker (#2774) credit the ledger.

---

## Biggest risks / unknowns (call these out first)

1. **Admitad Products API scope access** (Step 1.1) — gated; may need requesting.
2. **Admitad product field names** — defensively mapped, **unverified live**;
   confirm via the sample-key log on first sync.
3. **Awin advertiser approvals** — only ROCKBROS joined; wellness advertisers are
   applications-in-flight, the true gate on useful Awin inventory.
