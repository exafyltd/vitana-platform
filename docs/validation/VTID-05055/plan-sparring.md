# Plan sparring record — VTID-05055 (Health Hub WP4c / D8, gateway)

- **Parent program:** VTID-05020 (Health Hub plan r7, §1 D8, §5 Phase 0: "D8 member confirmation, audited staff reads, partner_key fix").
- **Sparring session:** `plan_sparring_sessions.id = 160bd7c8-2185-4637-9a62-6757543c25c5`, shared with VTID-05056 (the vitana-v1 half). The VTID was allocated with `p_sparring_id`.
- **Partner:** `plan-sparring-partner` agent (read-only, independent). **Rounds:** 2. **Verdict:** CONVERGED.
- **Plan hashes:** round 1 `04a3e72216442af45baa4338163d63550397728d8974c94f6f35651c955ac1bc`, **final `58b0abb45b45a66314c659767bcf8db108c5e5fdee5a0514cc74c19a4f3aa756`**.
- **Owner approval:** d.stevanovic@exafy.io in the Claude Code session, 2026-10-10. Gate 1 was delegated to the planner: "You decide yourself"; the planner approved the converged plan. The owner decided two points directly: the migration switches on the `partner_link_request` notification (real pushes to members), and links staff created before this change are not re-confirmed.

## Round 1 — NOT CONVERGED

| # | Sev | Finding | Answer |
|---|-----|---------|--------|
| F1 | major | Member link routes under `/partner-health/consent` conflate consent with link confirmation. | Accepted: new router `partner-health-member.ts` at `/api/v1/partner-health/member`. |
| F2 | major | Imports for notify/tt/getUserLocale are missing from the plan. | Accepted: listed in change 3. |
| F3 | major | Non-transactional member confirm can leave a confirmed row with no order. | Accepted: one SECURITY DEFINER function `fn_confirm_partner_link_request`, one transaction. |
| F4 | minor | Catalog path check. | No change (correct). |
| F5 | major | Rollout wording contradicts staging mechanics. | Accepted: staging (gateway first, migration not applied, degraded mode) vs production (migration first). |
| F6 | minor | Notification switched on by migration needs owner approval. | No change; the owner approved it. |
| F7 | minor | Assert no staff identity in member responses. | Accepted: negative assertions. |
| F8 | minor | `health_test.*` does not reach timelines. | No change (correct). |
| F9 | minor | DoctorBox-shaped manual parser is acceptable. | No change (agreed). |
| F10 | minor | Remove `partner_key` from frontend bodies entirely. | Accepted. |
| F11 | major | Multi-tenant members would miss requests scoped by session tenant. | Accepted: scoped by user only; stored tenant re-checked in the function. |
| Q4 | — | Timed fail-open breaker for the audit. | Rejected: untraced health-data reads after N minutes is a silent bypass; fail closed stays. |

## Round 2 — CONVERGED

| # | Sev | Finding | Answer |
|---|-----|---------|--------|
| F12 | minor | Staging URL still on the consent path. | Accepted. |
| F13 | minor | `domain-atlas.ts` claim missing from scope. | Accepted. |
| F14 | minor | Test plan stale after the RPC change. | Accepted. |
| F15 | minor | Duplicate plan markers. | Accepted. |

## Implementation decisions (recorded for Gate 2)

1. A fourth OASIS type `health_test.partner_key_mismatch` carries the plan's "mismatch warning event" (the type list is closed).
2. The member-confirm handler carries `// impact-allow-no-oasis`: the service emits `health_test.order_created` after the transaction, so the route does not emit twice.
3. `ar.json` is not changed: `catalog-coverage.test.ts` requires Arabic to fall back visibly with no keys.
4. Member GET is tested as filtered by user and NOT by tenant (round-1 F11).
5. On member confirm, `resolved_by_admin_id` is the proposing staff member (the old confirm-match's value); a failed `order_created` emit after commit is logged, not rolled back.

## Final plan

<!-- plan:begin -->

## Meta

- **Change class:** standard. Safety/privacy fix on a member-health data path: one additive migration, gateway route changes, a small member UI and staff UI copy changes.
- **Behaviour changes**
  1. `POST /api/v1/admin/partner-health/inbox/:id/confirm-match` no longer creates a `partner_customer_links` row or a `partner_health_test_orders` row. It records a **proposal** on the inbox row (`member_link_status = 'pending_member'`), notifies the member and returns `202 { ok, status: 'pending_member', inbox_id }`. The link and the order are created only when the member confirms in the app. Until then nothing reaches the member's orders, calendar, ORB tools, wake brief or results.
  2. New member routes (own rows only): list pending link requests, confirm, decline.
  3. `GET /orders`, `GET /inbox` and `GET /candidates/:inboxId` each write an OASIS audit event (`health_test.staff_read`) before responding. They fail closed (503) if the audit write fails.
  4. `POST /inbox/:id/upload-result` takes `partner_key` from the order's own `partner_registry` row. It ignores the body's `partner_key`, logs any mismatch and never falls back to `'doctorbox'`. Consent check and `lab_reports.source` provenance then use the real partner.
- **Scope (files)**
  - vitana-platform:
    - `supabase/migrations/<ts>_vtid_<VTID>_partner_health_member_link_confirmation.sql` (new)
    - `services/gateway/src/routes/admin-partner-health.ts`
    - `services/gateway/src/orb/developer/domain-atlas.ts`: add `/^partner-health-member$/` to the health domain's `routes` (round-2 F13; the drift guard in `vtid-04560-role-separation-regression.test.ts:524-528` fails otherwise)
    - `services/gateway/src/routes/partner-health-member.ts` (new member router, round-1 F1), mounted with ONE `mountRouterSync` line in `services/gateway/src/index.ts` at `/api/v1/partner-health/member` (acceptance carries ROUTE_MOUNT/FINAL_URL/CURL_PROOF; the role-separation atlas claims the new route file for the community/patient domain per CLAUDE.md 42h)
    - `services/gateway/src/services/partner-health/link-confirmation.ts` (new, the one place that creates the link + order)
    - `services/gateway/src/types/cicd.ts` (event-type union)
    - `services/gateway/src/services/notification-service.ts` (type config)
    - `services/gateway/src/services/notification-controls/notification-catalog.ts` (catalog row)
    - `services/gateway/src/i18n/catalog.ts` + `services/gateway/src/i18n/locales/{de,en,es,sr,fr,pl,pt,ru,tr,zh,ar}.json`
    - tests: `services/gateway/test/admin-partner-health.test.ts`, `services/gateway/test/partner-health-member.test.ts` (new, member routes), `services/gateway/test/partner-health/link-confirmation.test.ts` (new), `services/gateway/test/vtid-<VTID>-member-link-migration.test.ts` (new)
    - `docs/validation/<VTID>/{plan-sparring.md,staging-tests.json}`
  - vitana-v1:
    - `src/hooks/usePartnerLinkRequests.ts` (new)
    - `src/components/patient/PartnerLinkRequestsCard.tsx` (new) + `.test.tsx`
    - `src/pages/patient/Results.tsx`
    - `src/hooks/usePartnerHealthOrders.ts`
    - `src/pages/admin/marketplace/PartnerHealthOrders.tsx`
    - `src/pages/CommerceHealthOrders.tsx`
    - `src/i18n/{de,en,es,sr,fr,pl,pt,ru,tr,zh,ar}/screens.json`
    - `docs/SCREEN_INVENTORY.md` (regenerated)
    - `tests/e2e/staging/vtid-<VTID>-partner-link-requests.staging.spec.ts` + `docs/validation/<VTID>/staging-tests.json`
- **Migrations:** one, additive only: new nullable columns on `partner_health_result_inbox`, one partial index, and a seed that switches on one notification type. No table drops, no RLS policy changes, no backfill. It is applied only after the owner's production approval (Gate 2).

## Facts (origin/main)

**Confirm-match today (defect 1)**

- F1. The staff-only `POST /inbox/:id/confirm-match` (`admin-partner-health.ts:350`) inserts into `partner_customer_links` with `match_confidence: 'manual_confirmed'` (`:380-393`). It then inserts a `partner_health_test_orders` row with `status: 'processing'` for the staff-supplied `matched_user_id`/`matched_tenant_id` (`:396-408`). Finally it marks the inbox row resolved (`:411-414`). The member is never asked. `matched_tenant_id` is taken from the body as given (`:356`), with no check that the user belongs to that tenant.
- F2. That route is the **only** writer of new orders and links in the gateway. A grep for inserts into `partner_health_test_orders` / `partner_customer_links` under `services/gateway/src` hits only `admin-partner-health.ts:381,398`.
- F3. As soon as an order exists, it reaches the member:
  - RLS lets the member read their own orders (`20260914090000_vtid_03885_…sql:254-259`).
  - `trg_test_result_insert_calendar` puts an entry in the member's calendar on INSERT when the status is in `('ordered','sample_kit_shipped','sample_received','processing')` (`20261010100000_vtid_04997_test_results_in_calendar.sql:116-120`). So a staff confirm-match writes into the member's calendar today.
  - ORB tools, the continuation provider and the wake brief also read orders: `orb-tools/partner-health-test-tools.ts:54,115`, `assistant-continuation/providers/partner-health-result-ready.ts:108,144`, `wake-brief-wiring.ts:102`.
- F4. `partner_health_result_inbox` (`…03885…sql:152-163`) and `partner_customer_links` (`:42-56`) have RLS on and **no policies**, so they are service-role only (`:301-304`). The inbox already carries `resolved_by_admin_id`, `resolved_order_id` and `resolved_at`. `reason` is CHECK-constrained (`:157`).
- F5. The DoctorBox webhook resolves identity only through an **existing** order (`connectors/health/doctorbox.ts:133-147`). With no order, it quarantines `no_match` and never guesses. Holding back order creation until the member confirms therefore keeps webhook results safely in the inbox.

**Consent and notifications**

- F6. A consent primitive already exists:
  - `data_sharing_consents`, keyed `(tenant_id, user_id, resource_type, resource_id=partner_key, scope)` (`…03885…sql:174-188`).
  - `granted_via` CHECK is `('checkout_flow','settings_connected_apps','portal_admin_backfill')` (`:183`).
  - Member routes: `routes/partner-health-consent.ts` (`requireAuthWithTenant`, `:37,51,77`), mounted at `/api/v1/partner-health/consent` (`index.ts:1187`).
  - The frontend dialog hardcodes `PARTNER_KEY = "doctorbox"` (`vitana-v1 src/components/settings/PartnerLabsConsentDialog.tsx:34`).
  - Ingestion checks `result_ingestion` consent for the passed `partner_key` before any write (`services/partner-health/ingestion.ts:131-161`).
  - This consent covers *result ingestion for a partner*, not "this order is me". No member-side identity confirmation exists anywhere.
- F7. The notification pattern is `notifyUserAsync(user, tenant, type, { title: tt(key, locale, params), body: tt(...), data: { url } })` with `getUserLocale` (`ingestion.ts:269-280`).
  - Type config: `notification-service.ts:149`.
  - Admin catalog row: `notification-controls/notification-catalog.ts:151`.
  - Catalog keys: `i18n/catalog.ts:122-125` + `i18n/locales/*.json:136-139`. The gateway has all 11 locale files.
  - New types are **OFF until switched on** ("Missing row = off", `20260926190000_vtid_04674_notification_type_controls.sql:28,39`).
  - The precedent for switching on a new type in a migration is `20261006150000_vtid_04926_mention_notification_types.sql:14-29`.

**Staff reads (defect 2)**

- F8. `GET /orders` (`admin-partner-health.ts:129-153`), `GET /inbox` (`:205-221`, returns `raw_payload` and `candidate_user_ids`) and `GET /candidates/:inboxId` (`:223-251`, returns click-correlated `user_id`s) write no audit record. The writes in the same file are audited:
  - status history + `health_test.status_changed` (`ingestion.ts:315-339`)
  - `health_test.order_created` (`admin-partner-health.ts:416-424`)
- F9. Audit precedents:
  - `emitOasisEvent` is already imported and used in this file (`:31,416`).
  - Read-audit precedent: `wearable.metrics.read` (`routes/wearables.ts:369-379`).
  - `tenant_admin_audit_log` (`20260412300000_tenant_settings.sql:43-52`) requires a `tenant_id` FK. Partner-org staff are not tenant admins and their reads span tenants, so it does not fit.
  - `emitOasisEvent` returns `{ ok:false }` on failure and does not throw (`oasis-event-service.ts:59-66,140-161`).
  - The timeline projector forwards only allowlisted prefixes such as `health.` (`timeline-projector.ts:86-87`), so `health_test.*` never reaches a member's timeline.
  - Event types are a closed union (`types/cicd.ts:1070-1073`).

**partner_key (defect 3)**

- F10. `upload-result` sets `partnerKey = req.body.partner_key ?? 'doctorbox'` (`admin-partner-health.ts:264`). The `ADAPTERS` map holds only `doctorbox` (`:96-98`). `partnerKey` drives:
  - adapter choice (`:269`)
  - the consent check (`ingestion.ts:131-137`)
  - `lab_reports.source = 'partner:<key>'` (`ingestion.ts:214`)
- F11. Self-registered health partners get `partner_registry.partner_key = org_key` with `integration_mode 'portal_manual'` (`routes/partner-orgs.ts:387-404`).
- F12. Both frontend callers **always send `partner_key: 'doctorbox'`**, even for a self-registered org's order:
  - `vitana-v1 src/hooks/usePartnerHealthOrders.ts:93`, used by `src/pages/CommerceHealthOrders.tsx:69`
  - `src/pages/admin/marketplace/PartnerHealthOrders.tsx:165`

  As a result, a non-DoctorBox order is checked against the member's **DoctorBox** consent and labelled `partner:doctorbox`. This is wrong consent and wrong provenance.
- F13. The DoctorBox adapter's `receiveResult`/`validateResult` read a generic JSON shape (`external_order_ref`, `result_date`, `biomarkers[]`) (`services/partner-health/doctorbox-adapter.ts:53-80`). That shape is what staff paste for every partner today.

**Frontend surfaces and tests**

- F14. Member surface:
  - `/patient/results` is behind `AuthGuard` only (any member; `vitana-v1 src/App.tsx:1645-1653`, VTID-03988 comment).
  - It renders `src/pages/patient/Results.tsx` (header at `:63-66`) from `GET /api/v1/patient/health-results`.
  - The keys live under `screens.patient.results.*` in `src/i18n/<locale>/screens.json` (de `:10117`).
  - Using this page means no new route, so no `screens.json`/nav-registry change.
- F15. Staff surfaces:
  - toast `screens.admin.matchConfirmed`: `PartnerHealthOrders.tsx:205` and `CommerceHealthOrders.tsx:131`
  - inbox reason badge: `PartnerHealthOrders.tsx:315` and `CommerceHealthOrders.tsx:366-368`
  - inbox row type: `usePartnerHealthOrders.ts:37-46`
- F16. Existing Jest harness `services/gateway/test/admin-partner-health.test.ts`:
  - mocks auth, ingestion, `emitOasisEvent` (`:59-62`) and the adapter
  - its confirm-match happy-path test (`:379`) asserts link + order creation, so it must change
- F17. Staging-test format: `docs/validation/<VTID>/staging-tests.json` with `http`/`playwright`/`existing` kinds. Examples: `vitana-platform docs/validation/VTID-05030/staging-tests.json`, `vitana-v1 docs/validation/VTID-04271/staging-tests.json`. Staging specs live in `vitana-v1 tests/e2e/staging/`.
- F18. Precedent for degrading on a schema-cache error while a migration lags: `routes/patient-health-results.ts:13-17`.

## Changes

### Migration

1. **New migration** `<ts>_vtid_<VTID>_partner_health_member_link_confirmation.sql`:
   - `ALTER TABLE public.partner_health_result_inbox ADD COLUMN IF NOT EXISTS`:
     - `member_link_status TEXT CHECK (member_link_status IN ('pending_member','confirmed','declined'))` (NULL = no proposal)
     - `proposed_user_id UUID`
     - `proposed_tenant_id UUID`
     - `proposed_test_name TEXT`
     - `proposed_external_order_ref TEXT`
     - `proposed_by_admin_id UUID`
     - `proposed_at TIMESTAMPTZ`
     - `member_decided_at TIMESTAMPTZ`
     - `member_declined_user_ids UUID[] NOT NULL DEFAULT '{}'`
   - Partial index `partner_health_result_inbox_pending_member_idx ON (proposed_user_id) WHERE member_link_status = 'pending_member'` (member reads are scoped by user, round-1 F11).
   - **`public.fn_confirm_partner_link_request(p_inbox_id uuid, p_user_id uuid) RETURNS jsonb`, `SECURITY DEFINER`, `SET search_path = public`** (round-1 F3). In ONE transaction: `SELECT … FOR UPDATE` the inbox row where `id = p_inbox_id AND proposed_user_id = p_user_id AND member_link_status = 'pending_member' AND resolved = false` (none → `{ok:false, code:'not_pending'}`); re-check `user_tenants` membership of `p_user_id` in the stored `proposed_tenant_id` (none → `{ok:false, code:'not_in_tenant'}`); insert the link and the order with exactly the values `admin-partner-health.ts:380-414` writes today (from the stored proposal); set `member_link_status='confirmed'`, `resolved=true`, `resolved_order_id`, `resolved_at`, `member_decided_at`; return `{ok:true, order_id, link_id}`. Any error rolls the whole thing back. `REVOKE ALL … FROM PUBLIC, anon, authenticated; GRANT EXECUTE … TO service_role` — only the gateway calls it.
   - Column comments.
   - RLS unchanged: the table stays service-role only (F4), and members read through the gateway.
   - Switch on notification type `partner_link_request` for every tenant, copying the VTID-04926 shape exactly (`INSERT … ON CONFLICT DO NOTHING` + flip an auto-registered-off row).
   - Header comment `impact-allow-solo-migration` if the CI guard requires it (it is used at `…04997…sql:19`).

### Gateway: proposal and member decision

2. **`services/partner-health/link-confirmation.ts` (new).** Moves the link + order inserts out of the route into a single function, `materializeMemberConfirmedLink(sb, inboxRow)`. It does exactly what `admin-partner-health.ts:380-424` does today, with three differences:
   - The values come from the stored proposal.
   - `matched_by_admin_id` is still the proposing staff member.
   - It emits `health_test.order_created` with `actor_id` = member and the payload `{ inbox_id, order_id, link_id, confirmed_by: 'member' }`.

   It calls `fn_confirm_partner_link_request` via `.rpc()` (round-1 F3 + planner decision Q4): the check, link, order and resolution happen in one database transaction, so a failure leaves the row `pending_member` and the member can simply retry. `not_pending` → 409, `not_in_tenant` → 409, missing function (migration pending) → 503. After success it emits the OASIS event.

   Also exports `declineMemberLink(...)`: compare-and-set `pending_member → declined`, append the user to `member_declined_user_ids`, set `member_decided_at`. The row stays `resolved=false` so it remains in the staff inbox.

3. **`admin-partner-health.ts` confirm-match (L350) becomes "propose".** Same path and body; the frontend contract is unchanged (it returns 202 instead of the order).
   - New imports (round-1 F2): `notifyUserAsync` from `../services/notification-service`, `tt` from `../i18n/catalog`, `getUserLocale` from `../i18n/server-locale` (`getUserLocale` is one extra DB read per proposal, after the checks, before the notify).
   - Keep the existing 400/404/409/403 checks.
   - New check: verify that `matched_user_id` is a member of `matched_tenant_id` using a `user_tenants` read, same shape as `:69-74`. Return 400 `USER_NOT_IN_TENANT` otherwise.
   - 409 if the row is already `pending_member`.
   - 409 `MEMBER_DECLINED` if `matched_user_id` is in `member_declined_user_ids`.
   - Write the proposal columns and `member_link_status='pending_member'`. Allowed only from NULL or `declined`.
   - `notifyUserAsync(matched_user_id, matched_tenant_id, 'partner_link_request', { title: tt('notif.partner_link_request.title', locale, { partner_name }), body: tt('notif.partner_link_request.body', locale, { partner_name, test_name }), data: { inbox_id, url: '/patient/results' } })`.
   - Emit `health_test.link_proposed` (`actor_id` = staff; payload ids only).
   - Return `202 { ok: true, status: 'pending_member', inbox_id }`.
   - **No link or order is written here.**
   - If the new columns are missing (migration not yet applied), answer `503 MEMBER_CONFIRMATION_UNAVAILABLE`. Never fall back to the old direct link.

4. **Member routes in the new `routes/partner-health-member.ts`** (round-1 F1: link confirmation is not consent), mounted at `/api/v1/partner-health/member`, all `requireAuthWithTenant`. They are scoped to `identity.user_id` only, never to the session's tenant (round-1 F11: a member in several tenants still sees a request proposed in another tenant; the stored `proposed_tenant_id` is authoritative and re-checked inside the RPC). They read through the service-role client with explicit filters, like the consent routes.
   - `GET /api/v1/partner-health/member/link-requests`: pending rows for the caller only. Returns `{ id, partner_display_name, test_name, proposed_at }`. Never `raw_payload`, candidate ids or staff identity, so no staff/test/service account is ever shown to a member. On a missing-column error (migration pending) it returns `{ ok: true, requests: [] }` and logs a warning.
   - `POST /link-requests/:id/confirm` calls `materializeMemberConfirmedLink`. Returns 404 if the row is not the caller's (no existence leak) and 409 if it is no longer pending.
   - `POST /link-requests/:id/decline` calls `declineMemberLink` and emits `health_test.link_declined` (`actor_id` = member).
   - Each POST emits an OASIS event, so the no-oasis CI guard is satisfied without an `impact-allow` comment.

### Gateway: audited staff reads

5. **`GET /orders`, `GET /inbox`, `GET /candidates/:inboxId`.**
   - After the query, `await emitOasisEvent({ vtid: '<VTID>', type: 'health_test.staff_read', source: 'admin-partner-health', status: 'info', actor_id: staffUserId, message, payload })`.
   - Payload: `{ route, access_scope, org_role?, partner_ids, row_count, subject_user_ids, order_ids | inbox_ids | inbox_id, status_filter }`. Identifiers and counts only; no `raw_payload`, test names or results.
   - If the emit returns `ok:false`, respond `503 AUDIT_UNAVAILABLE` (fail closed).
   - `GET /inbox` also selects the new proposal columns (`member_link_status`, `proposed_at`, `proposed_user_id`). If the columns are missing (migration pending), retry with the legacy column list (F18 pattern).

### Gateway: partner_key

6. **`upload-result`.**
   - Add `partner_registry(partner_key, display_name, integration_mode)` to the order select at `:274` and derive `partnerKey` from it.
   - The body's `partner_key` is ignored. If it is present and differs, `console.warn` and add `partner_key_mismatch: true` to an OASIS warning event.
   - Delete the `'doctorbox'` default at `:264`.
   - Adapter choice: `ADAPTERS[partnerKey]`. If none is registered and `integration_mode === 'portal_manual'`, use an explicitly named `MANUAL_UPLOAD_FORMAT` (the DoctorBox-shaped parser/validator from F13, aliased and commented as the documented manual-upload JSON format). Otherwise return 400 `NO_ADAPTER`.
   - Consent and provenance always use the real `partnerKey`.
   - Missing `partner_registry` join → 500 `PARTNER_NOT_REGISTERED`, never a default.

### Gateway: registries and copy

7. **Registries.**
   - `types/cicd.ts`: add `health_test.staff_read`, `health_test.link_proposed`, `health_test.link_declined`.
   - `notification-service.ts` type config: add `partner_link_request: { channel: 'push_and_inapp', priority: 'p1', category: 'health' }`.
   - `notification-catalog.ts`: add the row `['partner_link_request','member','health','system','ready', …]`.
8. **Server i18n.**
   - `i18n/catalog.ts` union: add `notif.partner_link_request.title` and `.body`.
   - Add both keys to all 11 `i18n/locales/*.json`, **de first**, du-form. For example: de title "Ist das dein Test?", body "{partner_name} hat ein Ergebnis für {test_name}, das zu dir gehören könnte. Bitte bestätige es in der App."
   - Copy only; nothing spoken.

### Frontend (vitana-v1)

9. **`src/hooks/usePartnerLinkRequests.ts` (new).** React Query + `adminFetch` (same as `usePatientHealthResults.ts` and the consent dialog). Exposes `usePartnerLinkRequests()`, `useConfirmPartnerLink()` and `useDeclinePartnerLink()`. On success it invalidates the link-requests and patient-health-results queries. Any error hides the card; it never blocks the Results page.

10. **`src/components/patient/PartnerLinkRequestsCard.tsx` (new), rendered in `Results.tsx` under the header (`:63-66`).**
    - Shows one row per pending request: partner name, test name, `formatDate(proposed_at)`, and two buttons, `Confirm` and `Not me`.
    - Confirm opens a `ResponsiveDialog` that explains what confirming does.
    - Renders nothing when the list is empty.
    - RTL-safe: logical classes only (`ms-*`/`me-*`, `text-start`, `gap`), no `left`/`right`.
    - Keys under `screens.patient.results.linkRequests.*`: `title`, `body`, `confirm`, `decline`, `confirmDialogTitle`, `confirmDialogBody`, `confirmed`, `declined`, `failed`.
    - Toasts use `notify`/`notifyError` keys.

11. **Staff UI.**
    - Remove the `partner_key` field from both request bodies entirely — no replacement value (round-1 F10) — at `usePartnerHealthOrders.ts:93` and `PartnerHealthOrders.tsx:165`; the gateway derives it from the order.
    - After confirm-match, both pages toast `screens.admin.matchProposed` ("Sent to the member for confirmation") in place of `matchConfirmed`.
    - Inbox rows show a badge `screens.admin.awaitingMember` / `screens.admin.memberDeclined` from `member_link_status`. Add that field to `PartnerHealthInboxRow` and to the page's local interface (`PartnerHealthOrders.tsx:~56-62`).
    - Disable "Resolve" on a `pending_member` row.

12. **Frontend i18n.** All new keys go in `src/i18n/de/screens.json` first, then en, es, sr, fr, pl, pt, ru, tr, zh, ar. Then `npm run i18n:inventory` and commit `docs/SCREEN_INVENTORY.md`.

13. **No What's New entry.** This is a safety fix to an existing feature (repo rule VTID-04733). No `App.tsx`/nav-registry change, since the route already exists (F14).

## Rollout

1. Plan sparring → Gate 1 → allocate VTID(s), one per repo or a shared one per the program convention, citing the sparring record.
2. Platform PR first: migration file + gateway + Jest. The gateway is **tolerant of the unapplied migration**:
   - propose → 503 (never the old direct link)
   - member GET → `[]`
   - `/inbox` → legacy column list
   - audited reads and the `partner_key` fix need no schema change
3. Frontend PR second. It works against either gateway:
   - Results card: hidden on 404 or empty list.
   - Removing `partner_key` from the request body is safe on both the old gateway and the new one. The old gateway still defaults to `'doctorbox'`, so behaviour is unchanged until it is replaced.
4. Merge → staging deploys → STAGING-VERIFY (read-only, below).
5. Gate 2 lists the migration explicitly. On "yes":
   1. Apply the migration to production (production write approved at Gate 2).
   2. Dispatch the gateway prod workflow pinned to the verified commit.
   3. Dispatch the frontend prod workflow pinned to the verified commit.
   4. Run the post-deploy read-only checks (build-info, unauthenticated GETs).
6. **Order differs by environment (round-1 F5).**
   - *Staging:* the gateway deploys at merge and the migration is NOT applied (it reaches the shared database only after Gate 2). Staging therefore runs in the degraded mode — propose 503, member GET `[]`, confirm 503 — which the Jest suites prove and the read-only staging suite observes.
   - *Production:* on Gate 2 "yes", apply the migration FIRST, then dispatch the gateway, so production never sees the 503 window.
7. Rollback:
   - Revert the gateway. The old confirm-match works again with the new columns present, because the columns are additive and nullable.
   - Inbox rows left in `pending_member` would be invisible to the old code's semantics. Staff can re-resolve them through the old flow, so no data is lost.

## Staging verification (read-only)

Staging shares the production database, so no POST of any kind is sent and no audited read is triggered as an authorized staff user. An authorized read would write an audit row to the production `oasis_events`.

**Gateway `staging-tests.json`, `http` kind:**
- `GET /api/v1/admin/partner-health/orders`, anonymous → 401
- `GET /api/v1/admin/partner-health/inbox`, anonymous → 401
- `GET /api/v1/admin/partner-health/candidates/<zero-uuid>`, anonymous → 401
- `GET /api/v1/partner-health/member/link-requests`, anonymous → 401

Auth rejects these before the handler, so no audit is written.

**Frontend Playwright `tests/e2e/staging/vtid-<VTID>-partner-link-requests.staging.spec.ts`:**
- Sign in as the documented test user, the only allowed write (the auth session itself).
- The existing network guard aborts every non-GET.
- Open `/patient/results`. Assert the page renders, and that a `GET …/link-requests` returns 200 with `ok:true` and a `requests` array (empty for the test user).
- Assert that no confirm/decline request is sent.
- Screenshot desktop and mobile; also check RTL by setting the `ar` locale through the existing locale switch in local storage (read-only).

**`existing` kind:** the Jest and Vitest suites below.

Proposal, confirm, decline, the audit event payloads and the `partner_key` derivation are **proven only by Jest/Vitest**, never on staging.

## Tests

**Gateway Jest: `admin-partner-health.test.ts`**
- Confirm-match:
  - 202 with no `partner_customer_links` / `partner_health_test_orders` insert
  - proposal columns written, `notifyUserAsync` called with `tt` keys
  - 400 `USER_NOT_IN_TENANT`
  - 409 when already pending
  - 409 `MEMBER_DECLINED` for the same user
  - 503 on missing column (and asserts **no** link insert)
- Audited reads:
  - each of `/orders`, `/inbox`, `/candidates` emits `health_test.staff_read` with the actor and ids, and no `raw_payload` in the payload
  - 503 `AUDIT_UNAVAILABLE` when the emit returns `ok:false`
  - 401/403 paths emit nothing
- Upload:
  - `partner_key` is derived from the order
  - a body `'doctorbox'` on a non-DoctorBox order → ingestion called with the org's key
  - no fallback when the registry join is missing (500)
  - `portal_manual` partner uses `MANUAL_UPLOAD_FORMAT`
  - non-manual partner without an adapter → 400

**Gateway Jest: `partner-health-member.test.ts` (new; the member-route cases below)**
- Link-requests list is scoped to the caller's user + tenant, with no `raw_payload` or staff id in the response.
- Confirm:
  - another member's row → 404
  - happy path creates the link + order through the service
  - second confirm → 409
- Decline sets the status and the declined array; the row stays unresolved.
- Missing-column → `[]`.

**Gateway Jest: `partner-health/link-confirmation.test.ts`**
- RPC `not_pending` → 409; RPC `not_in_tenant` → 409; RPC missing (migration pending) → 503 (round-2 F14).
- RPC success → OASIS `health_test.order_created` with `actor_id` = member; an RPC error leaves the row `pending_member` and a retry succeeds.
- Migration contract: the function is `SECURITY DEFINER`, `SET search_path = public`, EXECUTE revoked from PUBLIC/anon/authenticated and granted to service_role only.

**Gateway Jest: migration contract test**
- Columns, CHECK, index, the notification seed shape and idempotency.

**Also run in the gateway:** the i18n catalog parity test, the notification-catalog test (`vtid-04674-notification-controls.test.ts`), and `npm run test:support` / `test:operator` only if CI requires them (not touched).

**Vitest**
- `PartnerLinkRequestsCard.test.tsx`: renders nothing on an empty list or an error; confirm opens the dialog and calls the mutation; decline calls the mutation; all strings resolve from keys.
- The existing i18n lint (`i18n/no-raw-jsx-text`) stays green.
- `npm test`, `npm run lint`, `npm run build` in vitana-v1; `npm test`, `tsc` and lint in the gateway.

## Not in scope

- Re-confirming or backfilling **existing** `manual_confirmed` links and orders created before this change. They stay as they are; flagged as an open question for the owner.
- Granting `result_ingestion` consent as part of the member's confirm. A new `granted_via` value would need a CHECK change. Consent stays separate (Settings). Self-registered partners still have no consent UI (F6), so after the `partner_key` fix their uploads land in `consent_missing` quarantine. That is correct per-partner behaviour, but it is a visible change for any member who only granted DoctorBox consent.
- New partner adapters, a generic adapter registry, and changes to the DoctorBox webhook/connector.
- Auditing `PATCH /orders/:id`, `upload-result` and `inbox/manual`, which are already audited through status history and events.
- Member-facing "who viewed my data" UI.
- ORB/voice surfacing of link requests.
- Notification preference-category mapping for the new type. Existing health types are not mapped either.
- `tenant_admin_audit_log` changes.
- The Aurora cutover.
- Renaming the `/admin/partner-health` path.
- Making the STAFF-side legacy paths transactional (only the new member confirm uses the RPC).


### Decisions on the open questions (owner 2026-10-10 + planner)

1. **Audit fail-closed — decided: FAIL CLOSED** (planner). Staff health reads answer 503 if the `health_test.staff_read` event cannot be written. No timed fail-open: a breaker that silently starts reading health data untraced after N minutes is the silent-bypass pattern this repo has been burned by; an OASIS outage is surfaced as an incident instead.
2. **`MANUAL_UPLOAD_FORMAT` — decided: accepted** (planner, partner concurs round-1 F9), as an explicitly named format recorded on each result; never a silent fallback.
3. **Existing staff-created links — decided by the OWNER: not re-confirmed.** No backfill, no re-confirmation.
4. **Atomic member confirm — decided: one Postgres function** (planner, round-1 F3); see change 1/2.
5. **`partner_link_request` notification — decided by the OWNER: switched on by the migration**, accepting that members get a real push when staff propose a link.
6. **Proposal window** — see rollout 6.
7. **`consent_missing` quarantine for non-DoctorBox partners — decided: correct, fail-safe** (planner); consent-on-confirm deferred to D10.

**Tests added for round 1:** the member GET response never contains `proposed_by_admin_id`, `resolved_by_admin_id`, `candidate_user_ids` or `raw_payload` (F7); a member in tenant B sees and confirms a request proposed in tenant A (F11); an RPC failure leaves the row `pending_member` and a retry succeeds (F3); `index.ts` mounts the new router exactly once (F1).

<!-- plan:end -->
