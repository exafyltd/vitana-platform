# VTID-05039 — VOA: start the onboarding coach in shadow mode in production + baseline

Plan: sparred (2 rounds, CONVERGED), owner approved 2026-10-10 — record `docs/validation/VTID-05039/plan-sparring.md` (final plan hash `f3eed7b3…`).

Problem (verified 2026-10-10): slice 1 (VTID-04892) is in production but the coach never ran — production status `{mode:"off", reason:"feature_off"}`, 0 coach rows, no `onboarding.coach.*` event: the feature flag and rollout date were unset and nothing called the tick.

AC-1 `AWS-PROD-DEPLOY-GATEWAY.yml` pins `FEATURE_ONBOARDING_ASSISTANT_ENV=staging+prod` and `VOA_ROLLOUT_DATE=2026-10-10` (a one-time owner decision, commented as such) and never sets `VOA_MODE`; the staging workflow sets none of them; through the real config code the pinned values resolve to `shadow` in production and `disabled-on-staging` on staging.
TEST: services/gateway/test/vtid-05039-onboarding-coach-shadow-start.test.ts

AC-2 Exactly one scheduler job, `gateway-onboarding-coach-tick`, calls `POST /api/v1/scheduled-notifications/onboarding-coach-tick` once a day (06:17 UTC) against the production gateway with `gateway_internal` auth from the production token secret; the shared job table count moves 30 → 31.
TEST: services/gateway/test/vtid-05039-onboarding-coach-shadow-start.test.ts, services/gateway/test/vtid-04226-eventbridge-test-contract-schedules.test.ts

AC-3 Baseline measured read-only (plan v3 §3 item 4): 39 joiners in 60 days; day-1 return 5.1 %; days 2–7 return 17.6 %; ORB session 17.9 % (lower bound, events only since 2026-09-26); welcome-DM reply 2.6 %. Queries committed for re-runs.
TEST: docs/validation/VTID-05039/baseline.md, docs/validation/VTID-05039/baseline.sql

AC-4 Plan v3 §3/§5 record the status of slice 0 (items 1 and 4 done, 2 not needed, 3 superseded) and that the daily tick job moved from slice 6 to here.
TEST: docs/plans/VITANA-ONBOARDING-ASSISTANT-PLAN.md

Manual step after the production publish (this session has no AWS credentials): run `scripts/aws/setup-eventbridge-cron-migration.sh --only gateway-onboarding-coach-tick` once (create-or-update, idempotent). Until then the coach is enabled but idle.

ROUTE_MOUNT: none (no route added or changed; the tick and status routes shipped in VTID-04892)
FINAL_URL: GET /api/v1/onboarding-coach/status (existing)
CURL_PROOF: staging checks in docs/validation/VTID-05039/staging-tests.json — status reports `disabled-on-staging`; untokened tick POST → 401. After the production publish, a read-only GET of production status must report `{mode:"shadow"}`.

OASIS_IMPACT: no
OASIS_PROOF: no new event type; once the schedule runs in production the existing `onboarding.coach.tick_completed` (one per day) and `onboarding.coach.stage_changed` (VTID-04892) start appearing.
