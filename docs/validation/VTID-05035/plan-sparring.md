# Plan: Admin › Rewards Shop — manage shop items, shipping fees and orders

<!-- plan:begin -->
## Problem
The member Shop (Wallet › Rewards › Shop, VTID-04983) is live but empty: `reward_shop_items` has no rows
and there is no screen to add any. The gateway already has exafy_admin endpoints
(`services/gateway/src/routes/rewards-shop.ts`): `GET/PUT /admin/rewards/items` (PUT = upsert by slug,
validates slug/titles/positive integer vtna_price/fulfilment), `PUT /admin/rewards/shipping-fees`,
`GET /admin/rewards/orders` (?status), `PATCH /admin/rewards/orders/:id` (status + reason, emits OASIS).
Owner decision 2026-10-10: build an admin screen so the owner adds and edits items himself.

## Change class
standard (both repos; a storage bucket migration and new gateway routes; admin UI).

## Changes

### vitana-platform (gateway)
1. **Photo upload**: `POST /api/v1/admin/rewards/items/image` (requireAuth + requireExafyAdmin), JSON body
   `{ content_type, data_base64 }` — the existing storage-bridge pattern (`routes/storage-bridge.ts`),
   no new dependency. The app shrinks the photo in the browser before sending (longest side 1600 px,
   JPEG/WebP quality ~0.85, typically < 500 KB), so the decoded image is capped at **1.4 MB** and the
   base64 body stays under the gateway's 2 MB `express.json` limit. image/jpeg|png|webp only, checked by
   magic bytes, not just the declared type. Stored through the gateway's storage abstraction
   (`storageUpload` / `storagePublicUrl`, `services/storage/storage-provider.ts`) in the public bucket
   `reward-shop-images` under `items/<uuid>.<ext>`; returns the public URL. Members never write to the
   bucket (no anon/authenticated insert policy).
2. **Shipping fees list**: `GET /api/v1/admin/rewards/shipping-fees` (exafy_admin) — all rows, so the
   admin sees what is configured; and `DELETE /api/v1/admin/rewards/shipping-fees/:country/:currency`
   to remove one.
3. **Migration** `supabase/migrations/<ts>_vtid_<n>_reward_shop_images_bucket.sql`: `insert into
   storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('reward-shop-images',
   …, true, 5242880, '{image/jpeg,image/png,image/webp}') on conflict do nothing`; no member write policy.
   DATABASE_SCHEMA.md note. The bucket is also added to `PUBLIC_BUCKETS` in
   `scripts/aws/setup-storage-buckets.sh` so a later `STORAGE_PROVIDER=s3` switch provisions it too
   (production runs `supabase` today: the deploy workflows do not set `STORAGE_PROVIDER`).
4. Existing PUT items keeps its contract; `ITEM_REJECTED` messages are surfaced to the admin as-is.
5. Jest tests for the three new routes (auth gate 401/403, size/type rejection, happy path with mocked
   storage, fees list/delete); route acceptance evidence (ROUTE_MOUNT/FINAL_URL/CURL_PROOF).

### vitana-v1 (app)
6. **New page `/admin/marketplace/rewards`** (`src/pages/admin/marketplace/RewardsShop.tsx`), route guard
   `ProtectedRoute requiredRole="admin"` like `/admin/marketplace/partner-health`; reached from links on
   Admin › Marketplace Overview and Products (the catalog sub-navigation is at its 5-screen cap, same as
   partner-health). If the API answers 403 (tenant admin who is not exafy_admin) the page shows "Nur für
   Exafy-Admins" instead of a broken form.
7. Three sections (tabs on desktop, a select on phones; mobile-first, RTL-safe):
   - **Artikel (items)**: list of all items, active and inactive (photo, title, VTNA price ≈ €, type,
     active switch, stock). "Neuer Artikel" / edit opens a form: slug (auto from the German title,
     editable, immutable once saved because upsert keys on it), title + description DE (required) and EN,
     photo upload (via the gateway endpoint, preview, remove), VTNA price (integer > 0, shows ≈ € at
     0.01), type (Versand / Event-Ticket / Digital), age limit (toggle + min age, default 18), shipping
     countries (multi-select of ISO codes, only for Versand), stock (empty = unlimited), sort order,
     active. Save → `PUT /admin/rewards/items`; new items are saved **inactive by default** so nothing
     reaches members until the admin switches it on.
   - **Versandkosten (shipping fees)**: table of country × currency (EUR/USD) × fee; add/edit/delete.
     Warning on any active ship item whose countries have no fee (members in those countries could not
     order it).
   - **Bestellungen (orders)**: list with status filter, item, member's shipping address (only for ship
     orders), fee paid, dates; status change limited to what the gateway accepts today
     (`ADMIN_STATUSES` = fulfilling / shipped / delivered, rewards-shop.ts:28) with an optional reason →
     PATCH. Cancelled/refunded orders are shown read-only (they come only from the gateway's own
     expiry/refund paths). Admin-initiated cancel + VTNA refund is **not** in this plan (new DB contract;
     deferred to its own VTID if the owner wants it).
8. Admin UI strings in `src/i18n/<lc>/admin.json` (or the existing admin namespace), DE first, EN, then
   es, sr, fr, pl, pt, ru, tr, zh, ar marked `_pending_review` + stamps; layout checked in Arabic (RTL).
   `npm run i18n:inventory` regenerates `docs/SCREEN_INVENTORY.md`. Registry: no edit — the existing
   `/admin` prefix exclusion (`exclusions.json:5-7`) already covers the new route.
9. No What's New entry (admin-only). When the owner switches the first items on, the member-facing
   "Prämien-Shop" announcement is a separate entry (already noted in VTID-04983's decisions).

## Out of scope
- Admin-initiated order cancellation with VTNA refund (needs a new transition in
  `set_reward_order_status` + refund logic).
- Bulk import, multiple photos per item (the column holds an array; the form manages one main photo,
  keeps any others untouched), stock reservations UI (handled by the gateway sweep).
- Tenant-admin (non-exafy) access: the gateway endpoints stay exafy_admin only.

## Tests
- Gateway Jest: routes above (incl. > 1.4 MB and wrong magic bytes rejected, storage abstraction
  called with the right bucket/path); existing VTID-04982 suites stay green.
- App Vitest: image shrink keeps the result under 1.4 MB and sends base64 + type; form validation (price integer > 0, DE title required, ship items need ≥1 country),
  request body to PUT (no extra fields; inactive by default for a new item), photo upload call and
  preview, fee table add/delete calls, order status change call, 403 state, missing-fee warning.
- Staging (read-only) Playwright: sign in as the test admin, open `/admin/marketplace/rewards`, the three
  sections render from the staging gateway's GET endpoints (lists or empty states), no raw keys, phone
  and desktop, no horizontal overflow. No save is exercised on staging (staging shares the production
  database); writes are proven by Vitest and Jest.
- Screenshots phone + desktop of each section (empty state and a filled form, not saved).

## Files in scope
vitana-platform: services/gateway/src/routes/rewards-shop.ts, scripts/aws/setup-storage-buckets.sh, services/gateway/src/services/rewards/
reward-shop-repository.ts, services/gateway/test/<vtid>-*.test.ts, supabase/migrations/<new>.sql,
DATABASE_SCHEMA.md, docs/validation/<VTID-gw>/*.
vitana-v1: src/pages/admin/marketplace/RewardsShop.tsx (+ components under
src/components/admin/rewards/), src/hooks/useAdminRewardShop.ts, src/App.tsx (one route), links in
src/pages/admin/marketplace/{Overview,Products}.tsx, src/i18n/*/(admin namespace).json + stamps,
tests, tests/e2e/staging/<vtid>-*.spec.ts,
docs/validation/<VTID-app>/*, docs/SCREEN_INVENTORY.md.
<!-- plan:end -->


## Round 1 — planner responses
- F1 [major] admin `cancelled` not supported → ACCEPTED (option a): the admin UI offers only
  fulfilling/shipped/delivered (ADMIN_STATUSES); cancelled/refunded are read-only; admin cancel + refund
  deferred to its own VTID (listed under Out of scope).
- F2 [major] multipart needs a new dependency → ACCEPTED: no multipart, no new dependency; base64 over
  JSON like storage-bridge.
- F3 [major] 5 MB vs 2 MB JSON limit → ACCEPTED: the app shrinks the photo client-side (1600 px, ~0.85
  quality); the server caps the decoded image at 1.4 MB, so the base64 body stays under 2 MB.
- F4 [minor] storage backend → ACCEPTED: upload via `storageUpload`/`storagePublicUrl`; production uses
  `supabase` today (no `STORAGE_PROVIDER` in the deploy workflows); the bucket is also added to
  `PUBLIC_BUCKETS` in setup-storage-buckets.sh for a later S3 switch.
- F5 [minor] locale list / RTL → ACCEPTED: locales listed, Arabic layout checked.
- F6 [minor] SCREEN_INVENTORY → ACCEPTED: `npm run i18n:inventory` named in the changes.
- F7 [minor] exclusions already cover /admin → ACCEPTED: no registry edit; file removed from scope.
- Q1/Q2/Q3: answered by F1 (no admin cancel), F2/F3 (base64 JSON, 1.4 MB), F4 (storage abstraction).

## Round 2 — partner disposition
F1–F7 closed. No new blockers or majors. Observation (implementation detail): a rejected oversize photo must return a clear IMAGE_TOO_LARGE message, not a generic 413.
Verdict: CONVERGED (2 rounds, standard class).

## Owner approval
APPROVED by owner in Claude Code session 2026-10-10 ("Yes") — plan hash d91765931a4baa4fba2efdfeb47b75a819be380953bb191c756eb83e3db85497

VTID: VTID-05035 (gateway part of the approved plan; `<VTID>` placeholders in the plan body left verbatim so the hash matches)
