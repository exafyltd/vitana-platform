# VTID-04962 — plan sparring record

- **Plan hash (sha256 of the text between the plan markers):** `b0d49bbcf3429f219fc13e90c6dd31e560ea27d020f4d23b60aad856ace4854e`
- **Sparring session:** `plan_sparring_sessions.id = c3e6be3b-2610-491b-9be1-89df0bfc289c`
- **Partner:** `plan-sparring-partner` agent (independent, read-only; saw only the plan file)
- **Verdict:** CONVERGED
- **Owner approval:** d.stevanovic@exafy.io in the Claude Code session, 2026-10-07 — "Yes all four" (Gate 1, all four plans of the push-notification report). Binding exafy_admin click pending (`POST /api/v1/plans/spar/:id/approve`).

## Final plan

<!-- plan:begin -->
**Change class:** standard (migration + route behaviour)
**Repo:** exafyltd/vitana-platform
**Scope:**
- `services/gateway/src/services/notification-service.ts` (`sendPushNotification`, `sendPushToUser`, `notifyUser`)
- `services/gateway/src/routes/scheduled-notifications.ts` (`POST /push-dispatch`)
- `services/gateway/src/routes/scheduled-notifications-repository.ts` (`markNotificationPushSent` gains an outcome arg)
- `services/gateway/src/services/reminders-dispatch.ts` (`scheduleReminderFcmPush` — consumes the new count; no behaviour change beyond the fallback now firing correctly)
- `services/gateway/src/routes/ops-health-checks.ts` (push-dispatch health adds outcome counts)
- new migration `supabase/migrations/<ts>_vtid_xxxxx_user_notifications_push_outcome.sql` + `DATABASE_SCHEMA.md`
- new Jest test `services/gateway/test/vtid-xxxxx-push-outcome.test.ts`

## Problem (verified)
1. `sendPushNotification()` returns `true` for every FCM error except the two "token invalid" codes (notification-service.ts:274-275). An auth / permission / wrong-project / mismatched-credential error therefore counts as a delivered push.
2. Consequence: `sendPushToUser()` reports `sent > 0` while nothing was delivered, so the "FCM sent 0 → try Appilix" fallback (notification-service.ts:800, scheduled-notifications.ts:1371, reminders-dispatch.ts:327) never fires for members whose FCM path is broken.
3. FCM is configured against project `lovable-vitana-vers1` (decommissioned GCP project) with a WIF credential for a different project — a credential failure on every send is plausible and would be invisible today.
4. `user_notifications.push_sent_at` is the only record and is set regardless of outcome (at insert in notifyUser; in push-dispatch even after an exception). 7-day data: 2,407 of 3,674 push rows went to 152 members with no device token, all marked "sent".

## Change
A. **Tri-state FCM result.** `sendPushNotification()` returns `'sent' | 'stale' | 'error'` (exported type `FcmSendResult`). `'error'` = any non-stale failure; it is logged with the FCM error code (`[Notifications] FCM send error code=<code>`), the token is NOT revoked (keeps today's "don't remove on transient errors"). `sendPushToUser()` counts only `'sent'`; return shape stays `number` so existing call sites keep compiling, plus an optional `outcome` out-param object `{ sent, stale, errors, errorCodes }` for callers that record outcomes. All in-repo callers of `sendPushNotification` are updated in the same commit (grep confirms the set before editing; the only real caller is `sendPushToUser`; the doc stub in `dev-autopilot/context-loader.ts:227` is updated to the new signature). **Exact caller logic:** `if (result === 'sent') sent++; else if (result === 'stale') revokeDeviceToken(...); else errors++` — never a truthiness check (a string `'error'` is truthy). The return type annotation changes to the union so `tsc` (run in CI and locally) fails any unconverted caller.
B. **Fallback now fires.** No change to the fallback conditions themselves — they already key off `sent === 0`; A makes that count honest. Deep-link policy (Appilix first, FCM only to non-Appilix-tagged tokens) is unchanged.
C. **Record the outcome, keep `push_sent_at` as the "handled" marker.** `push_sent_at` keeps its current meaning (row handled — prevents the dispatch cron re-sending; changing that would risk duplicate pushes). Add nullable `push_outcome text` to `user_notifications` with a CHECK on: `delivered_fcm`, `delivered_appilix`, `delivered_both`, `no_device`, `fcm_error`, `suppressed_type_disabled`, `suppressed_push_disabled`, `suppressed_dnd`, `dispatch_exception`. Written by push-dispatch at mark time and by `notifyUser()` with a follow-up UPDATE by id after the send (only when a row was written). `push_outcome` is **best-effort**: a failed follow-up UPDATE is logged and dropped; rows written outside these two paths (e.g. `celebrations.ts` dedupe-hint pre-inserts) stay NULL. The health signal counts only non-NULL outcomes and never treats NULL as an error.

**Push-dispatch call-site mapping** (`scheduled-notifications.ts`):
| Call site | Condition | `push_outcome` |
|---|---|---|
| ~1304 | `isNotificationTypeAllowed()` false | `suppressed_type_disabled` |
| ~1317 | `prefs.push_enabled === false` | `suppressed_push_disabled` |
| ~1325 | quiet hours | `suppressed_dnd` |
| ~1383 | normal dispatch | `delivered_both` if fcm>0 && appilix; `delivered_fcm` if fcm>0; `delivered_appilix` if appilix; `fcm_error` if fcm errors>0 and nothing delivered; else `no_device` |
| ~1390 | exception | `dispatch_exception` |
`notifyUser()` uses the same delivered/fcm_error/no_device rule; DND-blocked or push-disabled rows get `suppressed_dnd` / `suppressed_push_disabled`. Migration is additive (nullable column + CHECK), no backfill, no trigger change; `_notif` guards unaffected.
D. **Health signal.** `/api/v1/ops/health/push-dispatch` additionally returns counts of `push_outcome` over the last 6h, and reports `degraded` when `fcm_error / (delivered_fcm + fcm_error) > 0.5` with at least 20 FCM attempts. Backlog logic unchanged. `ALERT-PUSH-DISPATCH-HEALTH.yml` untouched (it reads the same endpoint's status — confirm before merge; if it parses only backlog fields, no change in alert behaviour).

## Explicitly NOT in this plan
- Moving FCM to a new Firebase project (needs owner decision + Appilix app rebuild).
- Changing which channel is tried first.

## Tests (CI, no production)
Jest with mocked `fcm.send` and mocked Supabase:
1. auth error (`messaging/mismatched-credential`, `app/invalid-credential`) → `sendPushToUser` returns 0, Appilix fallback IS called in notifyUser (no-URL path) and push-dispatch (no-URL path).
2. stale token → revoked, count 0 (unchanged behaviour).
3. success → count 1, Appilix not called (no-URL path).
4. push-dispatch writes the correct `push_outcome` for: delivered_fcm, delivered_appilix, no_device, fcm_error, suppressed_dnd, dispatch_exception.
5. Existing suites stay green, incl. `npm run test:support` (customer support pipeline touches notifyUser).

## Staging verification (read-only, VTID-04610)
`docs/validation/<VTID>/staging-tests.json`: GET `/api/v1/ops/health/push-dispatch` on staging returns 200 JSON with an `outcomes` object. Post-deploy read-only SQL: new rows carry non-null `push_outcome`. No writes, no test sends.

## Risks
- If FCM is in fact fully broken, this change will cause Appilix fallback to fire for no-URL notifications where it previously did not → members with an Appilix identity receive pushes they were silently missing. Intended. Duplicate risk: none added — Appilix fires only when FCM delivered 0.
- Migration on a hot table: `ADD COLUMN ... NULL` + CHECK NOT VALID then VALIDATE — no rewrite, brief lock.

## Rollback
Revert the PR; the column is nullable and can stay.
<!-- plan:end -->

## Sparring rounds (partner findings, condensed from the partner's own wording)

### Round 1 — NOT CONVERGED
Verified premises: errors return true at notification-service.ts:275 (TRUE); inflated `sent` suppresses the fallback at :800 and scheduled-notifications.ts:1377 (TRUE); projectId 'lovable-vitana-vers1' at :31 (TRUE); push_sent_at set at insert (:738) and in the catch (:1389-1390) (TRUE); citation of :1371 PARTIAL (the zero-send fallback is :1377).
- F1 [major] A string return is truthy; the caller's `if (ok)` must change in lockstep or errors would count AND stop revoking. Spell out the caller logic.
- F2 [major] notifyUser's follow-up UPDATE is fire-and-forget; celebrations.ts pre-insert rows never get an outcome. State that push_outcome is best effort and NULL is not a bug.
- F3 [minor] Health endpoint/alert workflow: the alert parses backlog fields only; the plan's hedge is adequate.
- F4 [minor] context-loader.ts:227 documentation stub diverges further.
- F5 [minor] VALIDATE CONSTRAINT scans the table; fine at current size.
- F6 [major] Map each of the 5 markNotificationPushSent call sites to its outcome value.
- F7 [minor] `suppressed_admin` is imprecise; consider `suppressed_type_disabled`.
- Q1 INSERT-then-UPDATE vs deferring the INSERT; Q2 duplicate Appilix in reminders-dispatch:327/329?; Q3 celebrations NULL rows acceptable?

### Round 2 — CONVERGED
F1, F2, F3, F4, F5, F6, F7 and Q1–Q3 closed (Q2 verified against code: the `!appilixSent` guard prevents duplicates). No new blocker or major.

## Planner responses

## Planner responses — round 1
- F1 (truthiness trap) — ACCEPTED. Exact caller logic and union return type spelled out; tsc gates it.
- F2 (best-effort outcome, celebrations NULL rows) — ACCEPTED. Stated; health counts non-NULL only.
- F3 (alert workflow parses backlog only) — ACKNOWLEDGED; no change needed, verified during implementation.
- F4 (context-loader doc stub) — ACCEPTED; stub updated.
- F5 (VALIDATE scan) — ACKNOWLEDGED; table small enough.
- F6 (call-site mapping) — ACCEPTED; mapping table added.
- F7 (name) — ACCEPTED; renamed to `suppressed_type_disabled`.
- Q1: keep INSERT-then-UPDATE. Deferring the INSERT until after the send would delay the in-app row behind FCM/Appilix latency and change the push_sent_at duplicate-guard timing. Losing an outcome on a DB error is acceptable for an observability column.
- Q2: no duplicate. reminders-dispatch line ~327 sends Appilix only when the user has no native token; line ~329 requires `!appilixSent`, so it fires only when the first Appilix call reported not-sent (or wasn't made). With honest counts, users with an FCM error and a native token will now get one Appilix attempt they previously never got — intended.
- Q3: NULL acceptable for celebration dedupe-hint rows (they are not the canonical delivery row).
