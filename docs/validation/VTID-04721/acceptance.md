# VTID-04721 — The two scheduled workflows that failed on every run

VTID: VTID-04721
VALIDATION_PROFILE: gateway_backend

## Root causes (read from the failing runs and the live database, read-only)

**ALERT-PUSH-DISPATCH-HEALTH.** The check was wrong; push delivery works. Run 36456091808:
`unsent=1000 oldest_age_min=308442`. The query had no time bound, so it counted every unsent row back
to February. `/push-dispatch` only looks back 48h, so older rows can never be sent and the check could
never pass. Live database, last 48h: 919 push-eligible rows created and all 919 pushed (median 31 s).

**MORNING-SYSTEM-HEALTH-CHECK, "4/22 FAILED".**
- Check 4 (staging freshness): the run started 7 min after a gateway merge. Staging deploys take ~9 min,
  so an in-flight deploy was reported as drift.
- Check 20 (screen-load report): `HTTP 401 invalid_service_token`. The staging gateway's
  `GATEWAY_SERVICE_TOKEN` is the Supabase service-role key (`vitana/supabase/prod/service-role-key`),
  but the repo secret of the same name holds a different value. SCREEN-LOAD-TIMING.yml fails the
  same way (run 36454678098).
- Check 21 (memory health): real system problems, not workflow defects. See "Not fixed here".
- Check 22 (self-audit): follows from the others; no change needed.

## Change
- Push alert: only rows from the last 48h (`created_at=gte.<now-48h>`), and the hint points at the
  EventBridge → `vitana-push-dispatch` Lambda instead of a GCP scheduler.
- Check 4: a gateway commit less than 25 min old counts as a deploy in flight (PASS, labelled).
- Check 20 and SCREEN-LOAD-TIMING: the report is sent with the token the staging gateway actually checks.

## Not fixed here (owner action)
Check 21 reports three real problems:
- embedding coverage is 3%;
- the AP-0910 embedding backfill last ran 2026-07-06. Its EventBridge replacement in
  `scripts/aws/setup-eventbridge-cron-migration.sh` has never been applied, and applying it needs
  IAM/Lambda/Scheduler rights this session does not have;
- `preferred_language` is rewritten 33 times in 24h across 3 users.

The workflow keeps reporting these as FAIL, because they are real.

## Acceptance criteria
AC-1: The push alert judges only the 48h window, and its hint names the AWS path. The screen-load
report uses the staging gateway's token. Check 4 treats a commit under 25 min old as in flight.
TEST: services/gateway/test/vtid-04721-scheduled-workflow-fixes.test.ts
