# VTID-05174 — plan sparring record (Health Hub Phase 0 / WP4 remainder: mobile health-sharing switches, erasure of webhook log, vendor links and partner inbox, STATUS reconciliation)

| | |
|---|---|
| VTID | **VTID-05174** — package PLAT-D5R (vitana-platform: internal member-residue erasure endpoint, webhook log `user_id`, STATUS.md) |
| Sibling VTIDs (same sparred plan) | V1-D4M VTID-05173 (vitana-v1 mobile Settings › Privacy › Data), V1-D5R VTID-05175 (vitana-v1 `request-account-deletion` Step 0b) |
| Program | VTID-05020 (Health Hub plan) §1 D4/D5, §5 Phase 0 |
| Sparring session | `479ce517-270c-4371-bee5-e1551011689b` |
| Partner | `plan-sparring-partner` agent (independent, read-only) |
| Change class | standard |
| Rounds | 2 |
| Verdict | **CONVERGED** |
| Plan hash, final | `71f0455f1480bec72c7506fabcba6247ddd3f37201b81da03656f36a42785930` |

Plan hash = sha256 of the UTF-8 text strictly between the `plan:begin` and `plan:end` HTML-comment markers in the
"Final plan" section below.

Owner approval: Gate 1 2026-10-13: owner delegated decisions ("Continue and make the decisions yourself"; "build in parallel … quickest possible"); planner defaults taken

Planner defaults taken at Gate 1 (open questions of the plan): V1-D4M ships separately from D10 (VTID-05093); an
unreachable or missing endpoint counts as not erased (account kept for a retry); a vendor revoke failure never blocks
deletion; confirmed partner-inbox rows are deleted; the inert non-health switches stay for a STATUS follow-up and the
mobile AI-consent note i18n fix is included; facts not checkable from the repo are confirmed read-only in Gate 2.

## Rounds

| Round | Finding | Severity | Answer | Where in the final plan |
|---|---|---|---|---|
| R1 | F1 | informational | no plan change | — |
| R1 | F2 — the webhook-log JSONB payload filters are unindexed (sequential scan per call) | major | ACCEPTED — scale note; `CONNECTOR_WEBHOOK_LOG_PURGE_ENABLED=true` in production is a precondition for V1-D5R's production deploy, else an expression index in a follow-up VTID first | Change 5b (scale note); Rollout 3; Change 7 follow-up 7 |
| R1 | F3 — partner-inbox array removal has no compare-and-swap | major | ACCEPTED — plain read-then-write per row, single serialized caller, 0 live rows; a post-write residual re-select catches a concurrent re-add and reports `complete:false` | Change 5c; Tests (simulated concurrent re-add) |
| R1 | F4 — new OASIS types | minor | REJECTED — `CicdEventType` is the catch-all union; the plan already adds both event types to it | Change 5 (OASIS) |
| R1 | F5 | — | VERIFIED by the partner against the code; no plan change | — |
| R1 | F6 — the design manifest must be rerun for `MobileSettings` | minor | ACCEPTED — `npm run design:manifest` added to the V1-D4M checks | Tests (vitana-v1) |
| R1 | F7 | informational | no plan change | — |
| R2 | — | — | CONVERGED; every R1 finding closed | — |

The partner's verbatim output for both rounds is kept in the sparring session
`479ce517-270c-4371-bee5-e1551011689b`; this table records each finding's answer as the planner gave it.

## Final plan

<!-- plan:begin -->

## Meta
- **Change class:** standard. No migration. Three PRs, three VTIDs:
  - **V1-D4M** (vitana-v1): mobile Settings › Privacy › Data — the three data-sharing switches become off and disabled, and the export button becomes disabled. Frontend only.
  - **PLAT-D5R** (vitana-platform): a service-only internal erasure endpoint (vendor revoke, webhook log rows, partner inbox references); webhook log rows carry `user_id` from now on; STATUS.md reconciliation.
  - **V1-D5R** (vitana-v1): `request-account-deletion` calls the PLAT-D5R endpoint before any table is erased. Deploys only after PLAT-D5R is in production.
- **Program:** Health Hub plan (VTID-05020) §1 D4/D5 (`HEALTH-HUB-PLAN.md:40-43`) and §5 Phase 0 row (`:168`): "D4 health switches off by default … D5 bucket/inbox/webhook-log erasure + purge". Neighbours not duplicated: D1 VTID-05030 (`revokeAtVendor`, token sealing); D10 VTID-05092/05093 (consent-bound switches, desktop only, see F4); A1 VTID-05158 (Aurora-safe `erase_user_data()`, untouched); A3 VTID-05160 (same edge function, see Rollout).
- **Files in scope:**
  - vitana-v1, V1-D4M: `src/pages/MobileSettings.tsx` (the `privacy.data` case only); new `src/pages/__tests__/mobile-settings-privacy-data.<VTID>.test.tsx`; new `tests/e2e/staging/<vtid>-mobile-privacy-data.staging.spec.ts`; regenerated `docs/SCREEN_INVENTORY.md`; `docs/validation/<VTID>/…`.
  - vitana-platform, PLAT-D5R: new `services/gateway/src/routes/health-erasure-internal.ts`; new `services/gateway/src/routes/health-erasure-internal-repository.ts` (data-access seam convention, as in `connector-webhooks-repository.ts:1-15`); `services/gateway/src/index.ts` (one `mountRouterSync`); `services/gateway/src/orb/developer/domain-atlas.ts` (route claim); `services/gateway/src/routes/connector-webhooks.ts` (`user_id` on the success log row); `services/gateway/src/types/cicd.ts` (OASIS types); tests; `docs/programs/health-hub/STATUS.md`; `docs/validation/<VTID>/…`.
  - vitana-v1, V1-D5R: new `supabase/functions/_shared/erase-health-residue.ts`; `supabase/functions/request-account-deletion/index.ts` (one new step); a Vitest for the shared module; `docs/validation/<VTID>/…`.
- **No What's New entry:** fixes, not new features (vitana-v1 CLAUDE.md §"What's New cards", VTID-04733).
- **i18n:** no new keys. V1-D4M reuses eight existing `screens.settings.*` keys, verified present in all 11 shipped locales (de en es sr fr pl pt ru tr zh ar); the parity gate is unaffected. PLAT-D5R has no member-facing text.

## Facts (file:line, origin/main)
**Status of the original WP4 items**
- F1 **D3 done.** `src/hooks/useWearableProviders.ts:31` reads `GET /api/v1/wearables/providers`. In `integrationData.ts` every `fitnessIntegrations`/`healthIntegrations` entry is `connected: false` (`:186-265`); the remaining `connected: true` are shopping/social (`:66-159`), outside the program (VTID-05032 Not in scope). `/settings/connected-apps` redirects to `/connectors` → `ConnectedApps` (`App.tsx:1440-1450`).
- F2 **D4 desktop done.** `Privacy.tsx` switches are `checked={false} disabled` (`:115, :120, :125, :420, :427, :434`); export button disabled (`:513`); test `src/pages/settings/__tests__/privacy-data-sharing.test.tsx:52-61`.
- F3 **D7 done.** AP-0607 sends nothing and emits only OASIS `health.lab_report.parse_unavailable` (`health-wellness.ts:75-97`). No code emits `health.biomarkers.stored` (only the registry subscription, `automation-registry.ts:539`); `health.lab_report.uploaded` is never dispatched (`automation-registry.ts:581-583`). The lab UI says "saved", not "analyzed" (`HealthReportUploadSheet.tsx:121, :127`; `toasts.json` DE `:570`). AP-0608's English notice remains (`health-wellness.ts:125-128`) but cannot be reached.
- F3b **D8 done.** confirm-match only proposes and the member confirms (`admin-partner-health.ts:500`, `partner-health-member.ts:53, :84, :116`, migration `20261010190000_vtid_05055_…sql`); staff reads audited (`admin-partner-health.ts:136, :225, :312, :343, :358`); `partner_key` from the order, no doctorbox default (`:381-428`).

**Open defect 1 — mobile D4 (live)**
- F4 On mobile, `/settings/privacy` renders `MobileSettings`: `App.tsx:1420-1422` → `MobileSettingsSection` (`:699-713`) → `/settings?mode=privacy[.<section>]`. The `privacy.data` mode is a pill (`MobileSettings.tsx:41, :87`) and a case (`:307`).
  - `:316-320` is a static list with hardcoded English: "Health Data Analytics" and "Community Insights" `defaultChecked: true`, "Third-party Integrations" `false`, rendered as uncontrolled `<Switch defaultChecked={item.defaultChecked} />` (`:326`) with no handler and no consent record behind them. This is D4 ("they display health-data sharing as on without consent") on the surface phone members actually use (Appilix WebView, D11).
  - `:371` `<Button …>{t('screens.mobilesettings.requestDataExport')}</Button>` has no handler and is not disabled.
  - `:356` hardcoded English "Consent granted. Toggle off to revoke." / "AI features disabled until consent is granted." The desktop keys exist: `screens.settings.consentGrantedYouCanRevokeAt` and `screens.settings.aiFeaturesVoiceAssistantProactiveMessages` (DE du-form, `de/screens.json:7540-7541`).
  - Reusable DE keys: `screens.settings.healthDataAnalytics` (`:7157`), `shareAnonymizedHealthDataImproveAi` (`:7158`), `communityInsights` (`:7159`), `allowYourProgressContributeCommunityStatistics` (`:7160`), `thirdpartyIntegrations` (`:7161`), `shareDataWithConnectedAppsServices` (`:7162`).
  - The open D10 WP2 branch (`-d10w2`, VTID-05093) replaces only the desktop `Privacy.tsx` switches with `HealthConsentSwitch`; its diff does not touch `MobileSettings.tsx` (`git diff --name-only origin/main...origin/claude/health-data-integration-plan-dbxyld-d10w2`).
  - Test harness to reuse: `src/pages/__tests__/mobile-settings-privacy-phone.vtid-05096.test.tsx` (mocks plus `MemoryRouter` on `/settings?mode=…`).
- F5 The same pattern exists outside the health-data card, all hardcoded English, uncontrolled and inert: mobile `privacy.visibility` (`MobileSettings.tsx:280-293`: "VITANA Index Score", "Progress Sharing", both default off), desktop `Privacy.tsx:288, :343`, mobile security (`:480`). None shows health sharing as on. Out of scope, recorded in STATUS (Open question 5).

**Open defect 2 — webhook log never erased**
- F6 `connector_webhooks_log.user_id UUID` is nullable, no FK (migration `20260417000000…:223-233`). `erase_user_data()` deletes from every table with a uuid `user_id` (`20261001120000…:178`; Aurora-safe copy `20261014100000…:27-134`), so a row would be erased only if `user_id` were set.
- F7 No insert site sets `user_id`: `connector-webhooks.ts:49-56` (unknown connector), `:75`, `:90-97` (invalid), `:250-256` (ok). Every logged payload survives account erasure. The payloads identify the member: Terra `payload.user.reference_id` is our user id, set at connect (`terra.ts:215`, read `:57-69`), `payload.user.user_id` is the Terra id; Vital `payload.client_user_id` is our user id (`vital.ts:54, :214`), `payload.user_id` is the Vital id.
- F8 The 90-day purge exists (`services/connector-webhook-log-purge.ts:1-48`, scheduled `index.ts:1800-1819`) but is off unless `CONNECTOR_WEBHOOK_LOG_PURGE_ENABLED==='true'`; no workflow or task-def file in the repo sets it (production env is set through `AWS-PROD-DEPLOY-GATEWAY.yml` `env_overrides`, `:221-`). Unverifiable from the repo: whether the production task def has the flag (VTID-05054 plan: "set only on production at publish"). Live row count (3 rows from 2026-04, `user_id` NULL) is from the VTID-05054 plan (2026-10-10), not re-checked.

**Open defect 3 — no vendor revoke on account deletion**
- F9 `revokeAtVendor` (`wearables.ts:325-357`, 5 s bound) is called only by `POST /disconnect/:connector` (`:278-307`). `user_connections` has no FK on `user_id` (`20260417000000…:44-47`), so `erase_user_data()` deletes the rows, and with them `provider_user_id` and the sealed tokens, without telling Terra, Vital or the OAuth vendors. Terra keeps sending webhooks tagged with the erased member's id (F7). Live connection count not re-checked (STATUS D6b: Oura, Fitbit, Strava 0 connections; Terra/Vital unverified).

**Open defect 4 — partner inbox not erased**
- F10 `partner_health_result_inbox` has no `user_id` (`20260914090000…:152-163`). Since VTID-05055 it holds member ids in `candidate_user_ids UUID[]`, `proposed_user_id`, `member_declined_user_ids UUID[]` (`20261010190000…:19-29`), and for confirmed rows that member's results in `raw_payload`. `resolved_order_id` is `ON DELETE SET NULL` (`20260914090000…:160`), so the erased order leaves the row orphaned with the payload. Service-role only. Live: 0 rows (VTID-05054 plan, 2026-10-10; not re-checked).

**Account-deletion flow (vitana-v1)**
- F11 `supabase/functions/request-account-deletion/index.ts`: Step 1 hand-kept tables (`:176-182`, list `:19-41`, no `user_connections`) → Step 1b `erase_user_data` (`:184-208`) → Step 2 Storage walk + residual check → `storage_incomplete` (`:210-231`) → Step 3 auth user delete (`:233-`). Precedents for a gateway call: the A3 branch adds `_shared/erase-health-raw.ts` (bearer `GATEWAY_SERVICE_TOKEN`, `GATEWAY_URL` default `https://gateway.vitanaland.com/api/v1`, fail closed unless verified) as Step 1c; the storage bridge uses the same secret (`_shared/storage-bridge-client.ts:35-69`). `erase_user_data` not deployed is tolerated (`_shared/erase-user-data.ts:41-47`); any other failure keeps the account.
- F12 Gateway conventions: `requireServiceOrAdmin` (`middleware/require-service-or-admin.ts:71`); internal mounts `/api/v1/internal/<x>` (`index.ts:1254-1255`); `mountRouterSync(…, { owner })` with a domain-atlas claim (VTID-05055 AC route mount). The only processor of `account_deletion_requests` is that edge function (grep both repos).

**STATUS.md drift**
- F13 `STATUS.md:19` still says row 4 `queued`; the deferred table (`:36-44`) has none of the follow-ups promised by VTID-05032/05053/05054 (`covers` bucket — `_shared/erase-user-storage.ts:42-44` says "STATUS.md"; AP-0608 English notice; non-health fake cards and raw English; export job). `intent-covers` (`CoverLibraryDrawer.tsx:101-102`, path `${userId}/…` per `CoverPhotoPicker.tsx:111` comment) is also missing from `USER_STORAGE_BUCKETS` (`erase-user-storage.ts:45-55`); not health data. Every open `dbxyld-*` platform branch carries the same row 4 text, so expect a rebase conflict on that row.

## Changes
**V1-D4M (vitana-v1)**
1. **`privacy.data` data-sharing card** (`MobileSettings.tsx:316-327`): replace the static English list with three rows using `t('screens.settings.healthDataAnalytics' | 'communityInsights' | 'thirdpartyIntegrations')` and their description keys (F4). Each switch is `<Switch checked={false} disabled aria-label={t(<title key>)} />`, exactly as VTID-05032 did on desktop. A comment points to D10 (VTID-05093 replaces these with `HealthConsentSwitch`). No `defaultChecked` remains in this card.
2. **Export button** (`:371`): `disabled`, same as desktop `Privacy.tsx:513`, until an export job exists (STATUS follow-up).
3. **AI consent note** (`:356`): the two hardcoded English sentences become `t('screens.settings.consentGrantedYouCanRevokeAt')` / `t('screens.settings.aiFeaturesVoiceAssistantProactiveMessages')` (Open question 5b). No behaviour change; the AI switch (`:342-348`) is untouched.
4. Nothing else in `MobileSettings.tsx` changes (F5 stays out of scope).

**PLAT-D5R (vitana-platform)**
5. **New router `health-erasure-internal.ts`**, mounted once with `mountRouterSync(app, '/api/v1/internal/health-erasure', …, { owner: 'health-erasure-internal' })` and claimed in `domain-atlas.ts`. Route `POST /member-residue { user_id }`, `requireServiceOrAdmin`; a non-uuid `user_id` → 400. On staging it answers `409 { error: 'STAGING_READ_ONLY' }` and touches nothing (staging shares the production database; same staging detection as A2's `health-store-internal.ts` on branch `-a2`, helper name confirmed at implementation). It runs three parts in order and always answers 200 with a per-part report when the database is reachable, else 503 `DB_UNAVAILABLE`:
   a. **Vendor revoke (best effort, never blocking).** Read every `user_connections` row of the member (id, connector_id, access/refresh token, provider_user_id, provider_username) through the repository seam; group by connector; call the existing `revokeAtVendor(getConnector(id), rows)` (`wearables.ts:325`), each connector with its 5 s bound and a 20 s total cap; then wipe the token columns with the same update `disconnectUserConnection` uses, so tokens are gone even if Step 1b fails later. Report `vendor_revoke: [{ connector_id, status }]`; OASIS `health.erasure.vendor_revoke` with connector ids and statuses only, never tokens.
   b. **Webhook log** (`connector_webhooks_log`): delete rows where `user_id = $uid` OR `payload->user->>reference_id = $uid` (Terra) OR `payload->>client_user_id = $uid` (Vital) OR `payload->user->>user_id` ∈ the member's Terra `provider_user_id`s OR `payload->>user_id` ∈ the member's Vital `provider_user_id`s (taken from part a's rows, read **before** they are erased). One PostgREST `.delete().or(…)` per id set, then re-select the same filter for `residual`. Report `webhook_log: { deleted, residual }`. **Scale note (sparring R1-F2):** the JSONB path filters are unindexed (only `(connector_id, received_at DESC)` and the unprocessed partial index exist, migration `20260417000000…:235-238`), so each call is a sequential scan. That is acceptable only while the table stays small (3 rows per the VTID-05054 plan) — i.e. while the 90-day purge runs. Gate 2 therefore treats `CONNECTOR_WEBHOOK_LOG_PURGE_ENABLED=true` in production as a **precondition for V1-D5R's production deploy**, not just a status line; if the owner prefers not to enable it, an expression index on the four member-id paths is added in a follow-up VTID before V1-D5R ships.
   c. **Partner inbox** (`partner_health_result_inbox`, service role, no migration): rows with `member_link_status='confirmed' AND proposed_user_id=$uid` are deleted (they hold this member's result; Open question 4); rows with `proposed_user_id=$uid` and status `pending_member`/`declined` keep the row but clear `proposed_*`, `member_link_status`, `member_decided_at`; `$uid` is removed from `candidate_user_ids` and `member_declined_user_ids` by a plain read-then-write per row (`select` the rows whose arrays contain `$uid`, then `.update({ candidate_user_ids: filtered, member_declined_user_ids: filtered }).eq('id', id)`). No compare-and-swap (sparring R1-F3): PostgREST has no native CAS on array columns, the endpoint has a single caller (the account-deletion edge function, one call per member, serialized), and there are 0 live rows; the post-write residual re-select below catches any concurrent re-add and reports `complete:false`, which keeps the account for a retry. Then re-select (`proposed_user_id=$uid` OR either array contains `$uid`) for `residual`. Report `partner_inbox: { deleted, scrubbed, residual }`.
   - Response `{ ok: true, vendor_revoke, webhook_log, partner_inbox, complete }`, `complete = webhook_log.residual===0 && partner_inbox.residual===0`; vendor revoke never affects `complete` (Open question 3). OASIS `health.erasure.member_residue` with counts only (no `raw_payload`, no tokens). New `CicdEventType` entries for both events. Idempotent: a retry finds nothing and reports zeros.
6. **Webhook log rows carry `user_id` from now on.** At the success site (`connector-webhooks.ts:250-256`), after signature verification, set `user_id` when every normalized event in the batch resolved to the same non-null member. Mixed or unknown batches stay NULL (part 5b's payload match still covers them). The three failure sites (`:49, :75, :90`) stay NULL: their payload is unauthenticated and its claimed user id must not be trusted. Effect: `erase_user_data()` erases these rows directly, even without part 5b.
7. **STATUS.md:** row 4 → "done — vitana-v1 #1317 (VTID-05032), #1322 (VTID-05053), #1324 (VTID-05056); vitana-platform #4006 (VTID-05054), #4008 (VTID-05055); remainder in row N"; a new row N for this plan (V1-D4M / PLAT-D5R / V1-D5R); deferred follow-ups gain: (1) `covers` bucket (event-ownership decision); (2) `intent-covers` bucket not in `USER_STORAGE_BUCKETS`; (3) AP-0608 hardcoded English notice (`health-wellness.ts:125-128`), with the lab-parser WP; (4) member data export job (Art. 15/20) for desktop `Privacy.tsx:513` and mobile; (5) inert non-health privacy switches and raw English on desktop and mobile (F5); (6) non-health fake `connected: true` cards (`integrationData.ts:66-159`); (7) `CONNECTOR_WEBHOOK_LOG_PURGE_ENABLED` production state, confirmed in Gate 2. Only these lines change, so the rebase against the open `dbxyld-*` branches stays small.

**V1-D5R (vitana-v1)**
8. **`_shared/erase-health-residue.ts`**, modelled line for line on A3's `erase-health-raw.ts`: `POST ${GATEWAY_URL}/internal/health-erasure/member-residue`, bearer `GATEWAY_SERVICE_TOKEN`, 30 s timeout; `healthResidueErased(r)` is true only for a 200 with `complete === true` and numeric zero residuals; a missing token, network error, 404, 409, 5xx or malformed body all count as not erased.
9. **`request-account-deletion/index.ts`**: new **Step 0b, before Step 1** (`user_connections` is erased in Step 1b, F9/F11). Not erased → request row `status: 'storage_incomplete'`, answer 500, account kept for a retry (as at `:220-231`). The summary gains `health_residue: { vendor_revoke_failed, webhook_log_deleted, partner_inbox_deleted, partner_inbox_scrubbed }`. Vendor revoke failures are logged and reported, never blocking.

## Tests
**vitana-v1 (Vitest)**
- V1-D4M `mobile-settings-privacy-data.<VTID>.test.tsx` (reuses the VTID-05096 mocks, renders `/settings?mode=privacy.data`): all three switches are `role="switch"`, unchecked (`aria-checked=false`), disabled, with the `t()` aria-labels; the export button is disabled; a source scan of the `privacy.data` case finds no `defaultChecked` and none of "Health Data Analytics", "Community Insights", "Consent granted. Toggle off to revoke."; the VTID-05096 test stays green.
- V1-D5R `erase-health-residue.test.ts` with a fake fetch: complete 200 → erased; `complete:false`, residual > 0, 404, 409, 500, malformed JSON, no token, timeout → not erased; correct bearer and URL. A source-order test asserts the Step 0b call appears before `rpc("erase_user_data"` in `index.ts`.
- `npm test`, `npm run lint` (incl. the `design/*` ratchet, VTID-05107: the change touches switch state and text only, no layout), `npm run design:manifest` (sparring R1-F6; `MobileSettings` keeps its archetype), `npm run i18n:gate`, `npm run build`, `npm run i18n:inventory` (commit `docs/SCREEN_INVENTORY.md`).

**vitana-platform (Jest; every database call mocked; nothing writes to the shared database)**
- `test/health-erasure-internal.test.ts`: auth (no token 401, member JWT 403, service token passes); non-uuid body 400; staging guard 409 with no Supabase call; part a wipes and calls `revokeAtVendor` per connector, tokens never logged or emitted; a vendor failure still gives `complete:true`; part b builds the `or` filter with `reference_id`, `client_user_id` and the provider ids, reading the provider ids before any delete; part c deletes confirmed rows, clears the proposal on pending/declined rows, removes the id from both arrays, leaves no `$uid` in either array after a read-then-write, and reports `complete:false` when a re-select still finds `$uid` (simulated concurrent re-add); residual > 0 → `complete:false`; OASIS payloads contain no `raw_payload`, `access_token` or `refresh_token`; mounted exactly once; the domain-atlas drift guard passes.
- `connector-webhooks` test: a single-member Terra batch logs `user_id`; mixed/unknown batches and the three failure paths log NULL.
- Existing suites stay green: `vtid-05054-lab-notice-and-webhook-purge.test.ts`, `admin-partner-health.test.ts`, `partner-health-member.test.ts`, `partner-health/link-confirmation.test.ts`, the wearables disconnect suite (VTID-05030), the VTID-05025 boundary suite, `npm run test:roles`, `tsc --noEmit`, lint.

**Staging verification (read-only; `docs/validation/<VTID>/staging-tests.json` per VTID)**
- V1-D4M: Playwright on preview-aws at 390×844 with the staging guard on (every non-GET aborted except sign-in): sign in as the test user, open `/settings?mode=privacy.data`, assert the three switches unchecked and disabled and the export button disabled, screenshot; `/settings/privacy` at 390×844 lands on the same mode (redirect, F4).
- PLAT-D5R: `GET /api/v1/admin/build-info` reports the verified commit; `GET /alive` 200. The endpoint is `kind: existing` (Jest), reason: every call is a POST that deletes data in the database staging shares with production, and on staging it answers 409 by design.
- V1-D5R: Vitest only, `kind: existing` (invoking the function deletes a real account, same reason as VTID-05053).

## Rollout
1. Spar this plan → Gate 1 → allocate the three VTIDs citing the sparring record.
2. **V1-D4M** depends on nothing: merge → staging → STAGING-VERIFY → Gate 2 → production frontend deploy pinned to the verified commit. If VTID-05093 merges first, V1-D4M still lands as planned and VTID-05093's follow-up swaps the mobile switches to `HealthConsentSwitch` (Open question 1).
3. **PLAT-D5R** has no migration and no flag; the endpoint is inert until V1-D5R calls it: merge → staging → STAGING-VERIFY → Gate 2 (every commit between production and the verified one) → gateway production deploy. Gate 2 also reports the read-only state of `CONNECTOR_WEBHOOK_LOG_PURGE_ENABLED` in the production task def (`aws ecs describe-task-definition`, read-only) and, if unset, asks to set it via `env_overrides` (VTID-05054 intent).
4. **V1-D5R** only after PLAT-D5R is live in production (otherwise every deletion stops at `storage_incomplete`; Gate 2 states this ordering). The edge-function deploy to the production Supabase project is itself a production change listed in Gate 2. If A3 (VTID-05160) merges first: rebase, Step 0b before Step 1, A3's Step 1c stays after 1b; they do not overlap.
5. **No migration in this plan**; nothing to apply via `RUN-MIGRATION.yml`.
6. **Rollback:** V1-D4M and V1-D5R → redeploy the previous frontend / edge function; PLAT-D5R → redeploy the previous gateway. An erasure already run cannot be undone (it is the member's request).

## Out of scope
- The export job itself, `covers`/`intent-covers` erasure, AP-0608 copy, non-health inert switches and fake cards — recorded in STATUS (Change 7).
- Consent-binding the mobile switches — VTID-05093 or its follow-up (Open question 1).
- `social_connections` tokens and revoke (existing STATUS deferral).
- Purging webhook log rows of members who are not erasing (the 90-day purge).
- The AI-recipients disclosure text ("Google Gemini / Lovable AI Gateway", `de/screens.json:7167, :9660`) — a D10/legal accuracy question, noted for the D10 owner, not changed here.

<!-- plan:end -->

## Open questions (planner defaults, outside the hashed block)

1. Mobile vs D10: ship V1-D4M separately now, or fold it into VTID-05093? **Default:** separately (the defect is live; VTID-05093 waits on its consent-store migration). Note to VTID-05093 to cover `MobileSettings` with `HealthConsentSwitch`.
2. Endpoint missing/unreachable: not erased (keep the account), or proceed with a warning? **Default:** not erased, matching A3 and VTID-05053; Rollout step 4 guarantees the order.
3. Vendor revoke failure blocks deletion? **Default:** no — local tokens and rows are gone, the failure is reported in OASIS and the deletion summary.
4. Confirmed inbox rows: delete, or keep with `raw_payload` blanked as a staff audit trail? **Default:** delete (staff reads already audited in OASIS, VTID-05055; the payload is the member's health result).
5. Mobile width: (a) leave the inert "VITANA Index Score"/"Progress Sharing" switches (default off) for the STATUS follow-up — **yes**; (b) include the AI-consent note i18n fix (`:356`) in the same card — **yes**.
6. Facts not checkable from the repo (production `CONNECTOR_WEBHOOK_LOG_PURGE_ENABLED`; whether VTID-05053/05054/05055/05056 reached production; whether the VTID-05055 migration is applied; live Terra/Vital connection and webhook-log counts). **Default:** confirm read-only (task def, workflow runs, `supabase_migrations` select) before Gate 1 or in Gate 2. No production write.
