# VTID-05038 — VOA slice 0: restore "Alle Beisammen" auto-enrollment for new members

Plan: sparred (3 rounds, CONVERGED), owner approved 2026-10-10 — record `docs/validation/VTID-05038/plan-sparring.md` (final plan hash `b92c5062…`). Plan v3 §3 item 1 (`docs/plans/VITANA-ONBOARDING-ASSISTANT-PLAN.md`).

Problem (measured read-only, production, 2026-10-10): `20260917084341_vtid_03990` re-created `fire_welcome_chat_on_membership()` from the pre-Alle-Beisammen body — enrollment after the `welcome_chat_sent` and `> 1000` early returns, hard-coded `< 100` cap. "Alle Beisammen 🤗" (cap null) has 231 of 237 primary members; the 16 missing are 4 registered service/test accounts and 12 real members who joined 2026-09-17 … 2026-10-06.

AC-1 The latest migration defining `fire_welcome_chat_on_membership()` skips both allowlists (`service_bot_accounts`, `notification_test_actors`) before touching chat or groups, enrolls before both early returns, reads the cap from `metadata->>'cap'` (NULL = uncapped) and keeps the welcome DM text unchanged (drift guard; mutation-checked: against the VTID-03990 body 3 of its tests fail).
TEST: services/gateway/test/vtid-05038-alle-beisammen-enrollment.test.ts

AC-2 The login-time path `addUserToSystemGroups()` never enrolls a registered service/test account, fails closed when the allowlists can't be read (`fetchExcludedTestServiceAccountIdsStrict`), still enrolls a real member and still respects a numeric cap.
TEST: services/gateway/test/vtid-05038-alle-beisammen-enrollment.test.ts

AC-3 Migration `20261010160000_vtid_05038_welcome_trigger_enrollment_restore.sql`, over a throwaway Postgres carrying the real VTID-03990 body: reproduces the regression first; backfills missing real members into uncapped system groups only (never a bot or test actor, never the capped group, no chat message); new signups — including one already marked `welcome_chat_sent` and one in a > 1000-member tenant — are enrolled; the welcome DM fan-out is unchanged; a test actor is neither enrolled nor fans out; re-running is a no-op; an unexpected live body or > 200 missing memberships aborts the whole transaction (function fix rolled back with it). 23 checks.
TEST: docs/validation/VTID-05038/pglite-welcome-trigger-check.mjs (outputs/pglite-welcome-trigger.txt)

AC-4 After `RUN-MIGRATION.yml` applies it to production (before merge; the owner's Gate 1 approval covers exactly this migration): read-only SQL shows 0 real primary members missing from "Alle Beisammen" and the live function body carries the metadata cap and the VTID-05038 marker.
TEST: docs/validation/VTID-05038/outputs/post-migration-check.txt

Out of scope (recorded): the English-only welcome DM text (existing i18n gap; changing what members receive needs its own decision); why the login path missed members who did log in (the trigger is the primary path; the backfill closes the gap).

ROUTE_MOUNT: none (no route added or changed)
FINAL_URL: none
CURL_PROOF: staging checks in docs/validation/VTID-05038/staging-tests.json — `/alive`, plus the Jest suite.

OASIS_IMPACT: no
OASIS_PROOF: no event emitted or changed; the trigger and the login enrollment path emit nothing.
