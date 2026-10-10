# VTID-04787 — Scheduled-workflow self-audit reports only real failures

VTID: VTID-04787
VALIDATION_PROFILE: gateway_backend

## Problem
Morning check 22 listed three workflows as failing:

- **MARKETPLACE-SYNC-CRON:** last success 2026-10-01 09:39. Every run from 09-25 to 10-01 passed.
- **DAILY-STATUS-UPDATE:** last success 2026-10-01 06:54. The last 20 runs passed.
- **ALERT-APP-USERS-IDENTITY-DRIFT:** never succeeded. From 09-25 every run fails with
  `InvalidResourceStateException ... is in stopped state`: the Aurora prod instance is stopped.
  Aurora has had no replication since the 2026-09-21 full load (VTID-04624). The workflow blamed
  "a permissions gap" for every error.

The first two were false: GitHub's filtered runs endpoint (`?branch=main&status=completed&per_page=1`)
returned stale runs, a 05-22 failure and a 09-22 run respectively. The unfiltered listing returns
the true latest run.

## Change
- **Self-audit:** the step lists runs unfiltered (`per_page=30`), selects the latest completed run
  on main in jq, and names that run's date in the FAIL detail.
- **Identity-drift alert:** a stopped instance emits a warning and skips the comparison, so the run
  stays green. A refused call says "permissions"; any other error says "failed" with the raw error.
  The drift threshold is unchanged.

## Acceptance criteria
AC-1: The self-audit no longer uses the filtered endpoint. Identity-drift skips only on a stopped
instance and still fails on everything else.
TEST: services/gateway/test/vtid-04787-self-audit-and-identity-drift.test.ts
