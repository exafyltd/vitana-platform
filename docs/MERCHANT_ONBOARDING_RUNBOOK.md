# Merchant onboarding runbook — VTID-02000

Step-by-step for adding a new supply source to the Vitana Discover marketplace. Written for operators (no code changes required after the infra shipped on 2026-04-19).

## Prerequisites

- Tenant-admin or Exafy-admin role on the Command Hub.
- The merchant already exists (a live Shopify store, or a CJ publisher account with advertiser approval).
- You have the relevant credentials (Shopify Storefront token, or CJ developer key).

## Option A — Onboard a Shopify shop

### On the merchant side (once per shop)

1. In the merchant's Shopify Admin → **Apps** → **Develop apps** → **Create an app**.
2. Open the new app → **Configuration** → **Storefront API access scopes**. Enable at minimum:
   - `unauthenticated_read_product_listings`
   - `unauthenticated_read_product_inventory`
   - `unauthenticated_read_product_tags`
3. **Install** the app on the shop. Copy the **Storefront access token** (starts with `shpat_…`).
4. Confirm the shop's public URL resolves (e.g. `https://acme.myshopify.com`). That's the *domain*.
5. (Optional) agree an affiliate URL template, e.g. `https://acme.myshopify.com/products/{handle}?ref=vitana&sid={click_id}`. Leave blank if the merchant doesn't use referrer tracking — Vitana will fall back to the canonical product URL.

### On the Vitana side

1. Open Command Hub → **Admin** → **Marketplace Shops**.
2. Click **+ Add shop**. Pick **Shopify**, fill in:
   - Display name (shown in the shop list — e.g. "Acme Supplements DE")
   - Merchant country (ISO-2 — e.g. `DE`, `US`)
   - Shopify domain (without `https://`)
   - Storefront access token
   - Affiliate URL template (optional)
   - Internal notes (commission %, contact, etc. — not shown to end users)
3. **Save shop**. The row appears with `Active`.
4. Click **Sync Shopify now** to force a first run. Takes 30s–3min depending on catalog size. You'll get a toast with `inserted/updated/errors` totals.
5. If `errors > 0`, open Command Hub → **Admin** → **Marketplace Review** — products the analyzer flagged will be listed there with the reason.

### Verification

- Open the community app → `/discover/supplements`. Products from the new shop should appear in the grid.
- Click a product card → drawer opens → click **Buy** → should land on the merchant's checkout page with `sid`/`sub3` parameters attached (check the URL in the merchant's analytics to confirm attribution is flowing).

## Option B — Onboard CJ Affiliate advertisers

### On the CJ side (one-time for the whole network)

1. Sign up at https://www.cj.com/publisher as a **publisher** (if not already).
2. In the CJ dashboard, go to **Account** → **Developer Key** and copy the value.
3. Note your **Website ID** (CJ assigns this when you list the website during signup).
4. Apply to advertisers (go to **Advertisers** → search by category → click **Apply**). Supplement advertisers typically auto-approve in 24–72h. For each approved advertiser, note the **Advertiser ID** (numeric, e.g. `1234567`).

### On the Vitana side

1. Command Hub → **Admin** → **Marketplace Shops** → **+ Add shop** → pick **CJ Affiliate**:
   - Display name (e.g. "CJ Publisher Vitana EU")
   - Developer key
   - Website ID
   - Advertiser IDs: comma-separated list of approved advertisers (e.g. `1234567,2345678,3456789`). Leave blank to ingest from **all** approved advertisers (not recommended — products will be noisy).
   - Keyword filter (optional): limits to products matching these words. Example: `supplement,vitamin,omega-3`.
2. **Save shop**, then **Sync CJ now**. This is slower than Shopify — expect 2–10 minutes for a full catalog run across multiple advertisers.
3. Review queue will likely light up — CJ has less-structured metadata than Shopify, so the analyzer flags more products for human QA.

### Verification

- Same as Shopify. Pick a CJ-origin product in the grid, click Buy. The redirect should go through `anrdoezrs.net` or `dpbolvw.net` (CJ's click-tracking domains) with your `sid=<click_id>` stamped — that's how commission attribution works.

## Scheduled sync

- Daily cron runs at **03:00 UTC** via `.github/workflows/MARKETPLACE-SYNC-CRON.yml`.
- Manual force-run: GitHub → Actions → **Marketplace Sync Cron** → **Run workflow** (choose network: `shopify`, `cj`, or `all`).
- Or in Command Hub: **Admin** → **Marketplace Shops** → **Sync Shopify/CJ now** buttons at the top of the page.

## When things go wrong

| Symptom | Likely cause | Where to look |
|---|---|---|
| "0 inserted, 0 updated" after sync | Shop added but credentials wrong, or no advertisers approved on CJ | Command Hub → toast message; Cloud Run logs for `[shopify-sync]` / `[cj-sync]` |
| Products not showing in /discover/supplements | Products have `is_active=false`, or stuck in review queue | **Marketplace Review** tab; or SQL: `SELECT count(*), is_active, requires_admin_review FROM products GROUP BY 1,2,3` |
| Buy button 302s to a dead URL | Merchant changed their shop domain; affiliate_url is stale | Trigger a fresh sync; the ingestion re-reads `onlineStoreUrl` |
| "Scheduler secret invalid" in workflow logs | `MARKETPLACE_SYNC_SECRET` drifted between GH and Cloud Run | Generate new secret, update GH secret AND redeploy the gateway — EXEC-DEPLOY.yml pulls the latest GH secret into Cloud Run env |
| CJ sync returns "401" | Developer key rotated or advertiser status changed | Regenerate in CJ dashboard; PATCH the source via admin UI or SQL: `UPDATE marketplace_sources_config SET config = jsonb_set(config, '{developer_key}', '"NEW_KEY"') WHERE …` |

## Security notes

- Storefront access tokens and CJ developer keys are stored **in plain text** in `marketplace_sources_config.config` (JSONB column). That column is protected by RLS — only tenant admins can read it via the gateway. Not encrypted at rest beyond Supabase's default. Rotate if a laptop is lost.
- The `/api/v1/internal/marketplace/sync/:network` endpoint is authed by `MARKETPLACE_SYNC_SECRET` only. It has no user context, so it bypasses tenant scoping — it syncs **all** configured sources. Keep the secret out of commits.
- Vitana acts as an affiliate — we never capture the shopper's card details or personal checkout data. The merchant handles the transaction entirely.

## Legal checklist (before going live with real traffic)

- [ ] Affiliate disclosure footer present on all product surfaces (shipped in vitana-v1 PR #150).
- [ ] FTC-compliant language: "Vitana may earn a commission from purchases made via these links."
- [ ] Merchant's terms of affiliate program reviewed — commission rate, cookie window, return policy.
- [ ] If tenant operates in the EU: cookie-consent banner covers the click-tracking `ip_hash` / `user_agent_hash` fields in `product_clicks`.
- [ ] Health-product disclaimer present on the detail page (shipped — "Always consult a qualified practitioner…").
