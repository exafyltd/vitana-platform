# VTID-04786 — Memory embedding backfill (AP-0910) runs again

VTID: VTID-04786
VALIDATION_PROFILE: gateway_backend

Companion: VTID-04787 (morning check 22, the scheduled-workflow self-audit) ships in this PR.

## Problem
Morning check 21 failed on `embedding-coverage-4pct; AP-0910-last-run-2077h-ago`. Read live on
2026-10-01:

- **Last run:** `automation_runs` shows AP-0910 last ran on 2026-07-06. AP-0906, 0908, 0909, 0911,
  0912 and 0913 stopped the same week.
- **Coverage:** 205 of 4,598 rows are embedded (40 of 861 facts, 165 of 3,737 items).
- **The embedder works.** Rows written today were embedded inline with `amazon.titan-embed-text-v2:0`.
  Only the backlog has nothing draining it.

Root cause: AP-0910 is a `cron` automation whose only trigger was the GCP Cloud Scheduler. The
EventBridge replacement (`scripts/aws/setup-eventbridge-cron-migration.sh`, the
`autopilot-memory-*` block) was never applied, and applying it needs IAM, Lambda and Scheduler
rights this session does not have. The non-memory jobs in the same script, such as AP-0101, were
applied and run.

## Change
- **Heartbeat trigger:** AP-0910 becomes a heartbeat automation (`intervalMinutes: 30`), fired by the
  gateway's in-process heartbeat loop. That loop runs live on staging today, firing AP-0201,
  AP-0302 and others every minute. This follows the VTID-04320 precedent of in-process reminders
  after the GCP scheduler died.
- **One run per interval:** `dedupeAcrossInstances` makes the loop consult `automation_runs` and
  skip when any gateway task already ran the job inside the interval.
- **Batch size:** 100 → 200 rows per store per run, about 800 rows an hour, so the backlog drains in
  roughly 6 hours. After that each run is a cheap no-op.
- **Manual trigger kept:** `POST /api/v1/automations/cron/AP-0910` still works.

Not changed: AP-0906 to 0909 and 0911 to 0913 are still dead. They include LLM-cost jobs, and
reviving them is the owner's EventBridge apply, not a side effect of this fix.

## Acceptance criteria
AC-1: AP-0910 is a heartbeat job every 30 min, deduplicated across tasks. The guard skips a run
when another task already ran it inside the interval, and is checked before execution. The batch
is 200.
TEST: services/gateway/test/vtid-04786-memory-embedding-backfill-heartbeat.test.ts

AC-2 (staging): the public registry reports AP-0910 as `heartbeat` with `dedupeAcrossInstances`.
Within an hour of deploy `automation_runs` shows new AP-0910 runs and coverage climbs.
CURL: GET https://preview-aws-gateway.vitanaland.com/api/v1/automations/registry?domain=memory-intelligence -> AP-0910 triggerType heartbeat (docs/validation/VTID-04786/staging-tests.json)
