# VTID-04352 — Conversation rebuild WS-0.2: `--only` filter for the EventBridge cron migration

Plan v1 (Conversation Intelligence Rebuild), Phase 0, workstream WS-0.2.
Ships in PR #3614 as a companion to VTID-04339 (the PR gate keys on one VTID
per PR; same precedent as VTID-04246).

## What was wrong

The nightly learning pipeline (AP-0906..AP-0913, BOOTSTRAP-MEMORY-DAILY-LEARNING)
has not run since 2026-07-06: its GCP Cloud Scheduler jobs died with GCP
billing. `scripts/aws/setup-eventbridge-cron-migration.sh` (VTID-03766)
already carries all eight jobs, but only as part of one all-or-nothing pass
that creates 27 schedules, several of which push to real members (morning
briefing, diary reminder, daily pace, night push, feature tip, match delivery).
There was no way to switch the learning jobs on by themselves.

## Fix

- `--only <name-prefix>` (repeatable) limits the run to jobs whose name starts
  with one of the prefixes. A full job name is a valid prefix.
- A prefix list that matches nothing exits 1 — never a silent no-op.
- `--only` with no value is rejected.
- `--delete --only …` deletes only the matching schedules and keeps the shared
  `vitana-cron-dispatch` Lambda and both IAM roles (other schedules use them).
  It also honours `--dry-run`.
- Without `--only`, behaviour is unchanged (27 jobs).
- The header documents that AP-0907 (daily learning digest) is member-facing
  (one push per user at local 18:00 on days new facts were learned) and gives
  the seven-`--only` command that starts only the silent jobs.

## Not done here — owner action

The session's IAM user has no `scheduler:*`/`lambda:*`/`iam:*`, so the script
is not applied from here. Suggested order for the owner:

```
# 1. the seven silent memory jobs
DEFAULT_TENANT_ID=<tenant> ./scripts/aws/setup-eventbridge-cron-migration.sh \
  --only autopilot-memory-routine-pattern-extraction \
  --only autopilot-memory-relationship-graph-projection \
  --only autopilot-memory-behavior-preference-inference \
  --only autopilot-memory-health-correlation-insights \
  --only autopilot-memory-user-model-synthesis \
  --only autopilot-memory-own-post-capture \
  --only autopilot-memory-embedding-backfill
# 2. later, deliberately: the member-facing digest
DEFAULT_TENANT_ID=<tenant> ./scripts/aws/setup-eventbridge-cron-migration.sh \
  --only autopilot-memory-daily-learning-digest
```

## Acceptance criteria

AC-1: Without `--only`, the dry run still lists all 27 jobs.
TEST: services/gateway/test/vtid-04352-eventbridge-only-filter.test.ts

AC-2: `--only autopilot-memory-` selects exactly the eight AP-0906..AP-0913 jobs.
TEST: services/gateway/test/vtid-04352-eventbridge-only-filter.test.ts

AC-3: `--only` is repeatable and a full job name is a valid prefix.
TEST: services/gateway/test/vtid-04352-eventbridge-only-filter.test.ts

AC-4: A prefix matching nothing, or `--only` with no value, exits non-zero.
TEST: services/gateway/test/vtid-04352-eventbridge-only-filter.test.ts

AC-5: `--delete --only` removes only the matching schedules and keeps the shared Lambda and roles.
TEST: services/gateway/test/vtid-04352-eventbridge-only-filter.test.ts

AC-6: The pre-existing VTID-04226 script contract (jobs, Lambda auth, bash -n) is unchanged.
TEST: services/gateway/test/vtid-04226-eventbridge-test-contract-schedules.test.ts
