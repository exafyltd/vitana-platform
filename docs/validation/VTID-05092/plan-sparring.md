# Plan sparring record — VTID-05092 (Health Hub D10 WP1, consent backend)

- **Parent program:** VTID-05020 (Health Hub plan r7, §1 D10). One plan, three work packages: WP1 VTID-05092 (this PR, backend), WP2 VTID-05093 (vitana-v1 Privacy switches), WP3 VTID-05094 (enforcement E1–E8).
- **Sparring session:** `plan_sparring_sessions.id = 2a3c0062-41d0-4b84-819d-0def763c80ef`, shared by the three VTIDs.
- **Partner:** `plan-sparring-partner` agent (read-only, independent). **Rounds:** 2. **Verdict:** CONVERGED.
- **Plan hashes:** round 1 `134d56b81fa282b36eb3292a692b1f5a0d322c686107ccf09883bab391366488`, **final `7be2a9874f3765e6094d610243884b6a4b7553cf917ffc93850f2426df1724eb`** (sha256 of the text between the plan markers below).
- **Owner approval:** d.stevanovic@exafy.io in the Claude Code session, 2026-10-12 — "Yes approved" (Gate 1 for D6a, D9 and D10), then "Yes approved and you decide for me 1 and 3" for open questions 1 and 3.
- **Owner input still open:** the DE + EN consent wording for the five categories (WP2 ships it as draft, gated off) and whether consent proof is retained after account erasure (nothing changes until counsel answers).

## Round 1 — NOT CONVERGED

| # | Sev | Finding | Answer |
|---|-----|---------|--------|
| F1 | blocker | The wearable-analyzer batch path (E7) was not covered by the enforcement list. | Accepted: E7 filters the batch by consent (WP3). |
| F2 | blocker | Automation handlers (E8) analyse health data without a consent check. | Accepted: E8 added (WP3). |
| F3, F4 | major | The member's own read-back of their data must not be blocked by a missing consent. | Accepted: member read-back is documented as ungated (GDPR Art. 15). |
| F5 | major | Revoke at the route and re-check at ingestion overlap. | Confirmed: the revoke path is defense in depth, kept. |
| F6 | major | Record a client-side hash of the wording the member saw. | Partly rejected: no client hash column; `text_version` + `shown_locale` identify the wording, and the audit procedure is documented. |
| F7 | major | A grant/revoke racing an ingestion. | Accepted: the ingestion-time re-check is the concurrency guard. |
| F8–F10 | minor | Wording, references, test naming. | Accepted. |

## Round 2 — CONVERGED

| # | Sev | Finding | Answer |
|---|-----|---------|--------|
| F11 | minor | Use the existing AP-0602 id. | Accepted. |
| F12 | minor | Note that revocation is forward-looking. | Accepted. |
| F13 | minor | E7/E8 need their own tests. | Accepted (WP3). |

## Implementation decisions (recorded for Gate 2)

1. Withdrawal always works, also before the migration is applied (GDPR Art. 7(3)): `revoke` falls back to the legacy `data_sharing_consents` write instead of answering 503. Grant, by contrast, needs the new wording columns and answers 503 until the migration is applied.
2. Legacy DoctorBox grants are kept valid as `text_version='legacy-03885'` (owner decision 3, under delegation).
3. The migration is applied only through `RUN-MIGRATION.yml`, never by hand.

## Final plan

<!-- plan:begin -->

## Meta
- **Change class:** standard. One sparred plan, three VTIDs (WP1 backend, WP2 frontend + copy, WP3 enforcement + quarantine release), merged in that order.
- **Program:** Health Hub plan v2 (VTID-05020) Phase 0, defect D10. Related merged work: VTID-05032 (D4 switches off/disabled), VTID-05025 (device data kept out of commerce), VTID-05030 (D1 tokens), VTID-05055/05056 (D8 member-confirmed links; consent-on-confirm deferred to D10).
- **Repos / areas:** vitana-platform: `supabase/migrations` (one additive migration), `scripts/aws/aurora-*` parity scripts, `services/gateway/src/{services/consent,services/partner-health,routes,services/orb-tools,services/gemini-operator.ts,services/user-health-context.ts,types/cicd.ts}`. vitana-v1: `src/pages/settings/Privacy.tsx`, `src/components/settings/*Consent*`, `src/pages/settings/ConnectedApps.tsx` + `src/components/settings/MobileConnectedAppsView.tsx` (partner list), the D8 link-request UI, `src/i18n/<11 locales>/screens.json`.
- **Regulatory impact:** this is the GDPR Art. 9(2)(a) explicit-consent mechanism. The code takes no legal position: the wording, its versions and whether a category may be processed at all are owner/counsel-supplied data (see Change 6).
- **Database constraint:** staging shares the production database. Migrations are applied only after production approval (Gate 2). Every gateway change must work when the migration has **not** been applied yet; in that state it fails closed.

## Facts (file:line)
**Consent store (vitana-platform)**
- F1 `data_sharing_consents` is created in `supabase/migrations/20260914090000_vtid_03885_partner_health_test_integration.sql:174-186`, keyed `(tenant_id,user_id,resource_type,resource_id,scope)` unique (`:187-188`), with active index `:189-190`. `resource_type` is free text "so future features can add values without a migration" (`:178`). `granted_via` CHECK allows only `checkout_flow|settings_connected_apps|portal_admin_backfill` (`:183`). The table comment says revocation applies to future ingestion only (`:192`).
- F2 `data_sharing_consent_events` (`:198-213`) is "append-only" by comment only (`:215`). No trigger or revoke enforces it.
- F3 RLS: enabled (`:245-246`). SELECT-only own-row policies (`:285-298`), no write policies. Table-level grants still give `anon`/`authenticated` DELETE, INSERT and UPDATE (`scripts/aws/aurora-cutover-restore-grants.sql:336-338, 1726-1728, 3120-3122`). Parity copy of the policy: `scripts/aws/aurora-restore-rls-parity.sql:180, 907`.
- F4 The service is `services/gateway/src/services/partner-health/consent.ts`. Types are pinned to `'partner_integration'` and to `order_tracking|result_ingestion` scopes (`:17-19`). The check fails closed on error (`:44-48`). Grant/revoke are read-then-write (`:61-98`, `:124-144`). The audit insert runs as a separate statement and its error is ignored (`:100-111`, `:146-157`), so a consent can change without an audit row. No consent wording version or locale is recorded anywhere.
- F5 Routes are in `services/gateway/src/routes/partner-health-consent.ts`, mounted at `/api/v1/partner-health/consent` (`services/gateway/src/index.ts:1205`). They use `requireAuthWithTenant` and the identity from the JWT (`:27-31`). `partner_key` is accepted as any string and is **not** checked against `partner_registry` (`:43-45, :61-63`). Grant and revoke opt out of OASIS with `impact-allow-no-oasis` (`:52-55, :78-79`).
- F6 Ingestion choke point: `services/gateway/src/services/partner-health/ingestion.ts:131-160`. It checks `partner_integration/<partner_key>/result_ingestion`. If consent is missing, it inserts into `partner_health_result_inbox` with `reason='consent_missing'` and only `partner_id`, `raw_payload` and `candidate_user_ids` (`:141-147`). **The order id is not stored on the inbox row**; it appears only in the OASIS payload (`:156`). The inbox schema is at `…03885…sql:152-163`, and the D8 columns at `20261010190000_vtid_05055_…sql:19-28`.
- F7 After D8, the partner key always comes from the order's own registry row (`routes/admin-partner-health.ts:401-407`), and staff re-upload goes through `ingestPartnerResult` again (`:437-446`). The D8 record says consent-on-confirm is deferred to D10, and non-DoctorBox results land in `consent_missing` (`docs/validation/VTID-05055/plan-sparring.md:351, 371`). The member link routes are in `routes/partner-health-member.ts:53, 84, 116`.
- F8 `partner_registry.status` takes `active|sandbox|disabled` and `integration_mode` takes `portal_manual|webhook|api_sync` (`…03885…sql:22-35`).
- F9 Wearable ingestion has **no consent check**. `routes/connector-webhooks.ts:150-196` upserts `wearable_daily_metrics` (`:176`) and `wearable_workouts` (`:180`) for any event whose `user_id` resolves, then mirrors it to OASIS with the payload (`:200-207`). `routes/wearables.ts` `POST /connect/:connector` (`:110`) and `GET /callback/:connector` (`:171`) have no consent step either.
- F10 AI reads of device and lab data, with no consent check:
  - `gemini-operator.ts:4153-4154` dispatches `get_wearable_metrics` to `executeGetWearableMetrics` (`:6079`; round-1 F8), which reads `wearable_rollup_7d` and `wearable_daily_metrics` (`gemini-operator-repository.ts:70-81`).
  - ORB `tool_get_lab_results` (`orb-tools/health-depth-tools.ts:554-561`) reads `biomarker_results` (`health-depth-tools-repository.ts:122-131`).
  - `user-health-context.ts` reads wearables only when `include_wearable === true` (`:214-216, :367`). The only caller found passes `false` (`orb-tools/health-depth-tools.ts:741`).
- F11 No gateway code processes health data for "anonymised analytics" or "community insights". A grep for those concepts in `services/` and `supabase/migrations` finds nothing.
- F12 The AI-provider consent is separate. It is `user_preferences.ai_data_consent_given`, written by the client (`vitana-v1 src/hooks/useAIConsent.ts:31-52`), and "granted" means localStorage **or** DB (`:14`). No gateway code reads it (grep for `ai_data_consent_given` in `services/` finds only Aurora restore defaults). `community-regeneration.ts:70-86` documents that "there is no dedicated Autopilot consent store".
- F13 Account erasure `erase_user_data()` is `SECURITY DEFINER` (`20261001120000_vtid_04765_erase_user_data.sql:75`). It deletes every public table with a `user_id`, except the `retain` rows in `erasure_registry` (`:55-69`). So both consent tables are erased today.
- F14 Precedent for versioned legal text and append-only acceptances: `20261005130000_vtid_04895_partner_terms_lifecycle.sql:32-60` (versions, sha256, binding locale) and `:179-195` (append-only trigger). Precedent for "tolerate the unapplied migration": `routes/partner-health-member.ts:19`.
- F15 OASIS event types must be declared in `services/gateway/src/types/cicd.ts` (e.g. `:1077`). The CI rule `scripts/ci/impact-rules/new-mutation-without-oasis-emit.mjs:18,110` requires an emit, or an opt-out, in every mutating handler.

**Frontend (vitana-v1)**
- F16 `src/pages/settings/Privacy.tsx:279-301`: the three switches (health data analytics, community insights, third-party integrations) are `checked={false} disabled` (VTID-05032 comment `:279-281`). The AI-provider switch is at `:323-332`. The test that pins the current state is `src/pages/settings/__tests__/privacy-data-sharing.test.tsx`.
- F17 `src/components/settings/PartnerLabsConsentDialog.tsx` hard-codes `PARTNER_KEY = "doctorbox"` and `SCOPE = "result_ingestion"` (`:34-35`), and calls the F5 routes (`:52, :72-75, :89-92`). It has no consent wording body (title and description only, `:107-108`) and records no version. DoctorBox is the only partner the UI offers: `ConnectedApps.tsx:478-488, 1098-1112, 2106`, `MobileConnectedAppsView.tsx:299, 320`, `integrationData.ts:261-262`.
- F18 v1 only calls `GET /api/v1/wearables/providers` (`src/hooks/useWearableProviders.ts:31`). No v1 code calls `/connect`, so members cannot connect a wearable from the app today (program D3).
- F19 Locale shards for `ar de en es fr pl pt ru sr tr zh` are in `src/i18n/<code>/screens.json`. The existing switch keys are `screens.settings.healthDataAnalytics` etc.

## Changes (numbered)
**WP1 — consent store, service, member API, audit, OASIS (vitana-platform; no new enforcement yet)**
1. **One additive migration** `supabase/migrations/2026101xxxxxxx_vtid_<WP1>_health_consent_categories.sql`:
   a. `health_consent_categories` (catalogue as data). Columns:
      - `key text pk`
      - `resource_type text not null` (`health_category` | `partner_integration` | `health_source`)
      - `scope text not null`
      - `per_resource boolean` (true = one consent per partner or connector)
      - `current_text_version text not null`
      - `processing_active boolean not null default false` (true only where an enforcement point exists)
      - `sort int`, `active boolean default true`, `created_at`
      - CHECK: no default-on column exists. Consent never defaults to granted.

      Seeds:
      - `wearables` (`health_source`, scope `ingestion`, per connector)
      - `partner_results` (`partner_integration`, scope `result_ingestion`, per partner; this matches the existing DoctorBox rows unchanged)
      - `ai_health_analysis` (`health_category`, scope `processing`)
      - `health_data_analytics` (`health_category`, scope `processing`, `processing_active=false`)
      - `community_insights` (`health_category`, scope `processing`, `processing_active=false`)

      RLS: SELECT to `authenticated` (non-sensitive reference data, like `partner_registry`). No writes for browser roles.
   b. `data_sharing_consents` gains three nullable columns: `category_key text references health_consent_categories(key)`, `text_version text`, `shown_locale text`. Existing rows keep NULL, meaning "granted under the VTID-03885 dialog, no recorded wording". The `granted_via` CHECK is widened (drop and re-add, additive values): `settings_privacy`, `partner_link_confirm`.
   c. `data_sharing_consent_events` gains `category_key`, `text_version`, `shown_locale` and `request_id`. Append-only is enforced in two ways. A BEFORE UPDATE trigger raises on every UPDATE. UPDATE and DELETE are revoked from `anon`, `authenticated` and `service_role`. A DELETE-blocking trigger in the F14 style is not used, because `erase_user_data()` deletes directly rather than by cascade (F13). As a `SECURITY DEFINER` owner function, it keeps working.
   d. (Round-1 F5, confirmed: with RLS enabled and no INSERT/UPDATE/DELETE policy, `authenticated` writes are already denied; the revoke is defense in depth and breaks no caller — the migration comment says so.) Revoke INSERT, UPDATE and DELETE on `data_sharing_consents` and `data_sharing_consent_events` from `anon` and `authenticated` (F3). Writes go only through the gateway or the function below.
   e. `fn_set_health_consent(p_tenant, p_user, p_category, p_resource_id, p_action grant|revoke, p_granted_via, p_text_version, p_locale, p_actor_role, p_actor_id, p_request_id) returns jsonb`. It is `SECURITY DEFINER` and runs in one transaction:
      - validates the category (active), checks that `text_version = current_text_version` on grant, and resolves `resource_type`/`scope` from the catalogue;
      - when `per_resource`, requires `resource_id` and validates it: a `partner_registry.partner_key` with status `active|sandbox`, or, for `wearables`, a non-empty key; the connector-id check is in the gateway;
      - upserts the consent row and inserts the event row. Both succeed or neither does (fixes F4).
      - It is idempotent: granting an active consent again re-records the version only if it differs, and revoking an inactive one is a no-op without an event.

      EXECUTE goes to `service_role` only.
   f. `partner_health_result_inbox.consent_order_id uuid references partner_health_test_orders(id) on delete set null`, so a `consent_missing` row can be released later (F6).
   g. The same objects are added to `scripts/aws/aurora-restore-rls-parity.sql` and `scripts/aws/aurora-cutover-restore-grants.sql` (F3), so the Aurora cutover keeps parity.
2. **Service** `services/gateway/src/services/consent/health-consent.ts` (new). It provides:
   - `listMemberConsents(identity)`: catalogue + the member's rows + active partners from `partner_registry` + known connector ids from `getConnector`.
   - `hasHealthConsent(identity, categoryKey, resourceId?)`: reads only the pre-migration columns (`resource_type/resource_id/scope/revoked_at`), with resource_type/scope taken from a **static fallback map that mirrors the seed**, so the check works before and after the migration. It is fail-closed on any error (F4 `:44-48` semantics kept).
   - `setHealthConsent(...)`: calls `fn_set_health_consent`. If the function is missing it answers `CONSENT_STORE_PENDING`, and nothing is written.

   `partner-health/consent.ts` becomes a thin re-export over this service (`checkDataSharingConsent` keeps its signature for `ingestion.ts` and its tests). After commit, every grant/revoke emits OASIS `health.consent.granted` / `health.consent.revoked` (declared in `types/cicd.ts`, F15). The payload carries only category, resource id, text version, locale and `granted_via`, never health values. An emit failure is logged and counted but does **not** undo the consent: a revoke must never be blocked by an OASIS outage, and the DB event row is the authoritative audit.
3. **Member API** `services/gateway/src/routes/health-consent.ts` (new), mounted at `/api/v1/health/consents`. Every handler uses `requireAuthWithTenant`, and identity comes only from the JWT (a body `user_id` is ignored).
   - `GET /`: catalogue and state. Before the migration: `{ok:true, store_pending:true, consents:[legacy rows only]}`.
   - `POST /grant {category, resource_id?, text_version, locale}`
   - `POST /revoke {category, resource_id?}`
   - `GET /history`: the member's own events, newest first, 100 max.

   Errors are codes, never raw DB messages: `UNKNOWN_CATEGORY`, `UNKNOWN_RESOURCE`, `STALE_TEXT_VERSION`, `CONSENT_STORE_PENDING` (503). There is no endpoint that lists other members' consents.

   `routes/partner-health-consent.ts` keeps its paths for older app builds but delegates to the service with category `partner_results`. That adds `partner_registry` validation (fixes F5 `:61-63`) and removes the two `impact-allow-no-oasis` opt-outs. A grant through the legacy path records `text_version='legacy-03885'`.

**WP2 — Privacy switches, generic consent dialog, partners beyond DoctorBox, copy (vitana-v1)**
4. `src/hooks/useHealthConsents.ts` (React Query + `adminFetch`, as in F17) and `src/components/settings/HealthConsentDialog.tsx`. The dialog takes a category and an optional resource. It shows the versioned wording, an explicit unticked confirmation checkbox, and a Grant button that is disabled until the box is ticked. When consent is active it shows Revoke with a confirmation. It sends `text_version` and the locale it actually displayed. `PartnerLabsConsentDialog.tsx` becomes a wrapper (`partnerKey` prop, no hard-coded `doctorbox`, F17).
5. Changes to `Privacy.tsx:279-301`:
   - "Health data analytics" and "Community insights" become controlled switches bound to their category rows. They are off when there is no active row, they open the dialog to grant, and turning one off revokes it.
   - "Third-party integrations" is replaced by a "Manage connected sources" row. It opens a list with one consent per partner and per wearable connector, because one global switch cannot express per-partner Art. 9 consent.
   - While `store_pending` is true or the request fails, the switches stay off and disabled, as in VTID-05032.
   - Connected Apps / mobile view list every active partner from `GET /api/v1/health/consents` instead of DoctorBox alone (F17).
   - The D8 link-request confirm screen gets a **separate, optional** consent step for that partner after "This is me" (`granted_via='partner_link_confirm'`). It is never bundled into the confirmation and never pre-ticked.
   - Layout uses logical properties only (`ms-*/me-*`, `text-start`) for RTL (ar).
6. **Copy provenance.**
   - UI chrome keys (labels, buttons, states, errors) go into `src/i18n/de/screens.json` first, then `en`, then the other nine locales via `scripts/translate-keys.mjs` marked `_pending_review`.
   - The consent wording itself is **owner/counsel-supplied DE + EN text**. It is pasted verbatim into versioned keys `screens.settings.healthConsent.<category>.v<N>.{title,body,checkbox}` and never written or edited by an agent. The planner ships placeholder keys only in a draft PR.
   - A lock manifest `src/i18n/health-consent-texts.lock.json` stores the sha256 of every released `vN` key per locale. A Vitest test fails if a released version's text changes, so new wording needs `vN+1` plus a catalogue `current_text_version` bump (a data fix-up migration). That makes "which words did the member see" answerable from git + `text_version` + `shown_locale`. **Audit procedure (round-1 F6, documented, not a new column):** for an event row, take `category_key` + `text_version` + `shown_locale`; the lock manifest at any commit after release maps that triple to one sha256, and the i18n file at the release commit holds those exact words. A client-sent text hash column was considered and rejected: it is asserted by the client and proves nothing the version + locked manifest do not already prove deterministically.
   - Locales whose wording is not reviewed show the EN text with the locale chrome (see Open question 3).
   - `npm run i18n:inventory` is regenerated.

**WP3 — fail-closed enforcement + release of D8's quarantine (vitana-platform)**

WP3 merges only after WP1's migration and WP2 are live in production. Before that, members have no way to grant consent.

7. **Enforcement points**: exactly these call sites (E1–E8, round-1 F1/F2); nothing else changes. Member read-back paths are listed separately below as deliberately ungated.

   | # | Call site | Category checked | Missing consent → |
   |---|---|---|---|
   | E1 | `partner-health/ingestion.ts:131` (unchanged check) | `partner_results` for the order's own `partner_key` | quarantine `consent_missing` as today, now also storing `consent_order_id` (1f) |
   | E2 | `connector-webhooks.ts:150-196`, before `upsertWearableDailyMetrics`/`upsertWearableWorkout` | `wearables` for `event.provider` | no row written, no payload kept, event counted `skipped_no_consent`. The OASIS mirror (`:200-207`) carries no payload for skipped events. Auth/revoke topics still update the connection row |
   | E3 | `wearables.ts` `POST /connect/:connector` (`:110`) and `GET /callback/:connector` (`:171`) | `wearables` for the connector id | 403 `{error:'CONSENT_REQUIRED', category:'wearables', resource_id}`. Callback redirects with that error code |
   | E4 | `gemini-operator.ts` `executeGetWearableMetrics` (`:6079`) | `ai_health_analysis` **and** `wearables` | `{ok:true, data:null, consent_required:{category}}`. No data read |
   | E5 | ORB `tool_get_lab_results` (`health-depth-tools.ts:554`) | `ai_health_analysis` | same structured result plus an `orb_directive` to open Settings › Privacy. The spoken reply is composed by the model from the intent (NEVER rule 41); no hard-coded sentence |
   | E6 | `user-health-context.ts:214, :367` (`include_wearable === true`) | `ai_health_analysis` and `wearables` | wearable summary stays `null`. A test pins that no commerce importer passes `include_wearable:true` (complements VTID-05025) |
   | E7 | Recommendation engine `analyzers/wearable-analyzer.ts:150` (batch `fetchWearableRollup7d`, up to 500 users; called from `recommendation-generator.ts:635`) | `ai_health_analysis` **and** `wearables`, per user | the user set is filtered BEFORE analysis to members holding both active consents (one query for the consented user ids, then `userIds` intersected); unconsented members produce no wearable signal and no recommendation. Round-1 F1 |
   | E8 | Automation handlers that read lab data: `runHealthReportSummarization` (AP-0602; today it reads only pending report ids and is forward-looking for when a parser exists, round-2 F11/F12) and `runBiomarkerTrendAnalysis` (AP-0608) via `health-wellness-repository.ts:66-73` `fetchBiomarkerResultsForReport` | `ai_health_analysis` | the handler skips that member (counted `skipped_no_consent`, no notice, no event about health values). AP-0607 is already a no-op since VTID-05054. Round-1 F2 |

   **Deliberately ungated member read-back paths (round-1 F3/F4):** `GET /api/v1/wearables/metrics` (`wearables.ts:355-366`) and `patient-health-results.ts` return the member's OWN data to the member. That is the data subject's access (GDPR Art. 15), not processing for a purpose, so no Art. 9 consent is required and none is checked. Revoking `wearables` stops future ingestion (E2) but does not hide data already held; deletion on withdrawal is Phase 1.

   `context-pack-builder.ts` was checked (round-1 F10): its only health read is `getUserHealthContext` (`:70`, `:1119`), which E6 gates; it has no direct read of `wearable_daily_metrics`, `wearable_rollup_7d` or `biomarker_results`.

   `health_data_analytics` and `community_insights` have no processor (F11), so `processing_active=false`. A Jest test fails if any category is marked `processing_active=true` with no listed enforcement point, so a future processor must add its own check.

   Revocation stops future processing at the next check. There is no cache to bust, because the checks read the DB per call. History deletion on withdrawal is Phase 1 (program §3.6) and is not promised in D10 copy.
8. **Quarantine release on member consent.** After a committed `partner_results` grant for partner P, `releaseConsentQuarantine(identity, P)` processes unresolved inbox rows with these conditions: `reason='consent_missing'`, `partner_id=P.id`, `consent_order_id` set, and that order's `user_id` = the granting member. For each row it runs the order's adapter (`ADAPTERS[partner_key]`, else `MANUAL_UPLOAD_FORMAT` for `portal_manual`, as in `admin-partner-health.ts:421-426`) over `raw_payload`, then calls `ingestPartnerResult(... received_via:'consent_release')`. Ingestion re-checks consent and is idempotent per order (`ingestion.ts` idempotency block). On success the inbox row is set `resolved=true, resolved_order_id`; it emits `health_test.result_released`. It runs after the response, and a failure leaves the row for staff. **Concurrency (round-1 F7):** the consent re-check inside `ingestPartnerResult` (`ingestion.ts:131`) is the guard: a revoke committed during a release makes every following row fail that check and stay quarantined; a duplicate grant re-runs the release and the per-order idempotency makes it a no-op. Rows from before WP3 have no `consent_order_id`; they stay in the staff inbox and are released by the existing staff `upload-result` (F7), which now passes consent.

## Rollout
1. Spar this plan, then Gate 1. Allocate three VTIDs (WP1, WP2, WP3) citing the sparring record.
2. WP1 PR → merge → staging. The gateway runs with the migration **unapplied** (store_pending, grants 503, legacy DoctorBox consent checks unchanged) → STAGING-VERIFY → Gate 2. On "yes": apply the WP1 migration to production, **then** dispatch the gateway prod deploy pinned to the verified commit.
3. Before step 2's Gate 2, run one read-only production count (no writes) and put it in Gate 2: active `data_sharing_consents` rows by `resource_id`, unresolved `consent_missing` inbox rows, and active `user_connections` for wearable connectors. This shows who will be affected by E2/E3 fail-closed in WP3.
4. WP2 PR (needs the owner/counsel wording; the draft PR waits for it) → staging → Gate 2 → production.
5. WP3 PR merges only after steps 2 and 4 are live in production. Then staging → Gate 2 → production. If step 3 found active wearable connections, their ingestion pauses until the member grants (fail closed; see Open question 1).
6. Rollback: WP3 and WP2 roll back by redeploying the previous commit. The WP1 migration is additive. Its only restriction is the revokes, and nothing used those browser writes (RLS already blocked them, F3).

## Staging verification (read-only)
`docs/validation/<VTID>/staging-tests.json` per WP. Every non-GET is aborted by the existing network guard except sign-in. No suite targets production.
- WP1: `GET /api/v1/health/consents` without a token → 401 JSON (not HTML). With the test user → 200 JSON with `store_pending:true` or a catalogue, both accepted. `GET /api/v1/partner-health/consent?partner_key=doctorbox&scope=result_ingestion` → 200 `{granted:boolean}`. `GET /api/v1/health/consents/history` → 200 array.
- WP2 (Playwright, preview-aws): Settings › Privacy renders the two category switches unchecked for the test user (who holds no grants), plus the "Manage connected sources" row. Opening the dialog shows the versioned title and an unticked checkbox, and Grant is disabled. The test then closes the dialog without granting. A mobile 390×844 and an `ar` RTL screenshot are taken and inspected.
- WP3: the enforcement paths (webhooks, connect, ORB tools) need writes or vendor calls and cannot be probed read-only. WP3's staging suite therefore checks only: the gateway build-info commit, that `GET /api/v1/wearables/providers` still returns 200, and the consent GETs above. All enforcement is proven by Jest.

## Tests
- **Gateway Jest (WP1):**
  - `health-consent.test.ts`: fail closed on DB error; static fallback map equals the migration seed (parses the SQL); grant/revoke call the RPC with the JWT identity; `CONSENT_STORE_PENDING` when the RPC is missing; OASIS emit after commit; an emit failure does not fail the revoke.
  - `routes/health-consent.test.ts`: body `user_id` ignored; unknown category/partner → 400; stale version → 409; history scoped to self; no raw DB message leaks.
  - Migration test (pattern `test/migrations/vtid-04765-…`): asserts the revokes; the event UPDATE trigger; `fn_set_health_consent` single transaction and EXECUTE only to `service_role`; no default-on column; seed keys.
  - The existing `partner-health-consent.test.ts` is updated to show the legacy path validates `partner_key`.
- **Gateway Jest (WP3):**
  - E1: a non-DoctorBox partner with consent ingests; without consent it quarantines with `consent_order_id`.
  - E2: no consent → zero upserts and no payload in the OASIS mirror; consent → upsert.
  - E3: 403 `CONSENT_REQUIRED`.
  - E4/E5: `consent_required` and the repository is not called.
  - E6: wearable summary null; no commerce importer passes `include_wearable:true`.
  - E7: the wearable-analyzer batch path filters to consented users only; unconsented members produce zero wearable signals and no recommendation (round-2 F13).
  - E8: `runBiomarkerTrendAnalysis` (and `runHealthReportSummarization`) skip a member without `ai_health_analysis`, counted `skipped_no_consent`, no notice (round-2 F13).
  - Release: releases only the granting member's rows for that partner; skips rows without `consent_order_id`; leaves a row on adapter failure; is idempotent on a double grant.
  - Catalogue guard: `processing_active` ⇒ listed enforcement point.
  - `npm run test:support` and `test:operator` stay green.
- **Frontend Vitest (WP2):**
  - Update `privacy-data-sharing.test.tsx`: switches controlled, off without rows, disabled when `store_pending`, never `defaultChecked`.
  - `HealthConsentDialog` tests: Grant disabled until the box is ticked; sends `text_version` + displayed locale; revoke asks for confirmation.
  - Partner list renders all active partners (no `doctorbox` literal outside fixtures).
  - The D8 confirm step offers consent as a separate unticked option.
  - Lock-manifest test (F-copy); i18n key parity across 11 locales; ESLint i18n rules; `npm test`, `lint`, `build`.
- No test writes to the shared database. All writes are proven with mocked Supabase or local Postgres.

## Not in scope
- The Phase 1 `health_consents` store, `health_observations`, withdrawal "keep vs delete history", soft-delete window, and the memory-extractor category exclusion (program §3.6). D10's catalogue and audit are designed to be migrated into them.
- Gating all AI context that uses health data: Vitana Index readers (`vitana_index_scores` in ~20 repositories), diary/self-logged features, `context-pack-builder`, ORB voice context. That is the Phase 1/4 wellness context module. D10 gates only device and lab data reads (E4–E6).
- The AI-provider consent (`ai_data_consent_given`, F12): client-written, not server-enforced, and its dialog names an outdated recipient. It is flagged as a separate defect, not changed here.
- The wearable connect UI (D3 / Phase 2). E3 enforces in the gateway now, and the UI consent-before-connect lands with the real Connected Apps screen.
- Staff/admin views of members' consents; a "sharing logs" UI beyond the member's own history.
- Product analytics consent (`AnalyticsTracker.tsx:49-53`): not health data.
- Any retention exception for consent records on account erasure (Open question 4).
- Partner AVV/DPA (D9), export (D4 remainder).

<!-- plan:end -->
### Open questions
1. **Existing data flows without a record.** WP3 fails closed for any wearable connection that exists today (count taken read-only in Rollout 3), and lab-result questions to Vitana stop until the member grants `ai_health_analysis`. Is the owner OK with pausing these until members re-consent (planner recommendation: yes; a notification to affected members is optional and would need its own copy)?
2. **Legacy DoctorBox grants** (`text_version` NULL, no wording shown, F17): keep them valid (planner default, conservative to member experience) or require re-consent with the new wording? Counsel decision.
3. **Locales without reviewed wording**: show the EN binding text (planner default, like Partner Terms) or block granting in that locale until reviewed?
4. **Erasure of consent proof**: today `erase_user_data()` deletes both consent tables (F13). Should consent events be retained after account deletion as proof (an `erasure_registry` retain entry)? Legal decision; the plan changes nothing until counsel answers.
5. **Wearable consent granularity**: per connector (planner default, matches the per-partner model and the vendor as recipient) or one `wearables` consent for all devices?
6. **Copy owner and timeline**: who supplies the DE + EN consent wording for the five categories? WP2 cannot leave draft without it.

### Owner decisions at Gate 1 (2026-10-12, d.stevanovic@exafy.io: "Yes approved and you decide for me 1 and 3")
1. Pausing existing flows until members consent: **yes** (planner decision under delegation).
3. Legacy DoctorBox grants (no wording shown): **kept valid** as `text_version='legacy-03885'`; no forced re-consent (planner decision under delegation).
2/4. Consent wording supplier and erasure of consent proof: open with the owner/counsel; WP2 ships with draft wording gated off, nothing changes on erasure until counsel answers.
