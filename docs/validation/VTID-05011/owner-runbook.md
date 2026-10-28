# VTID-05011 — switching on the scheduled memory jobs (owner runbook)

Measured read-only on 2026-10-09 from `automation_runs`. AP-0914 and AP-0907 have never run. AP-0906, 0908, 0909, 0911, 0912 and 0913 last ran in July 2026, and none of them in the last 14 days. AP-0910 runs from the gateway's own in-process loop (VTID-04786).

**Why the script defaults are not enough.** `AUTOMATIONS_GATEWAY_URL` defaults to the staging gateway. Staging pins `AUTOMATIONS_DELIVERY_MODE=shadow`, under which every memory job is skipped outright (`SHADOW_UNSAFE_HANDLERS`, `services/automation-shadow.ts`). Before this VTID, pointing the jobs at production meant overriding the Lambda-wide token, and that also re-pointed every staging job's token. Since VTID-05011 each AP-XXXX job names its own token: production for `https://gateway.vitanaland.com`, staging otherwise. Any other URL is refused.

Run from an identity with the IAM, Lambda and Scheduler permissions listed in the script header. For each step: run `--dry-run`, read the `extra=` column (it must show `gateway_url` = production and `token_secret_id` = `vitana/gateway/prod/internal-token`), then run the same command without `--dry-run`, then do the next-day check before the next step.

```bash
export DEFAULT_TENANT_ID=2e7528b8-472a-4356-88da-0280d4639cce   # Maxina
export AUTOMATIONS_GATEWAY_URL=https://gateway.vitanaland.com

# Step 1: own-post capture (AP-0913). No LLM: it mirrors members' own posts, deduplicated.
./scripts/aws/setup-eventbridge-cron-migration.sh --dry-run --only autopilot-memory-own-post-capture

# Step 2: daily learning episode (AP-0914). LLM; at most 25 users per run and 4 minutes;
# only users at their local evening hour; a failed user is skipped, never the run.
./scripts/aws/setup-eventbridge-cron-migration.sh --dry-run --only autopilot-memory-daily-learning-episode

# Step 3: the remaining silent memory jobs.
./scripts/aws/setup-eventbridge-cron-migration.sh --dry-run \
  --only autopilot-memory-routine-pattern-extraction \
  --only autopilot-memory-relationship-graph-projection \
  --only autopilot-memory-behavior-preference-inference \
  --only autopilot-memory-health-correlation-insights \
  --only autopilot-memory-user-model-synthesis \
  --only autopilot-memory-diary-theme-rollup

# Separately, the handoff sweep. It deliberately targets STAGING with the staging token,
# so unset AUTOMATIONS_GATEWAY_URL for this one.
env -u AUTOMATIONS_GATEWAY_URL ./scripts/aws/setup-eventbridge-cron-migration.sh --dry-run --only gateway-dev-memory-handoff-sweep
```

**Not created:**
- `autopilot-memory-daily-learning-digest` (AP-0907) sends members a push, so it needs its own decision.
- `autopilot-memory-embedding-backfill` (AP-0910) already runs in-process; a schedule would run it twice.

AP-0915 (diary theme rollup) writes nothing until `CONSOLIDATOR_DIARY_ROLLUP_ENABLED=true`, which no workflow sets. 0 results for it are expected.

## Read-only checks
```sql
select automation_id, count(*), max(started_at)
  from automation_runs
 where automation_id in ('AP-0906','AP-0908','AP-0909','AP-0911','AP-0912','AP-0913','AP-0914','AP-0915')
   and started_at > now() - interval '2 days'
 group by 1 order by 1;

select count(*) from memory_items
 where content_json->>'kind' = 'daily_learning' and created_at > now() - interval '2 days';

select count(*) from dev_agent_memory where category = 'handoff';
```

**To undo a step:** run the same command with `--delete` and the same `--only`. That removes only those schedules and leaves the shared Lambda and roles alone.
