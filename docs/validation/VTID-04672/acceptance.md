# VTID-04672 — the operator logs tool reads the real /vitana/<service> log groups

Live finding, staging 2026-09-26 (right after the owner applied the IAM grant
from `scripts/aws/setup-operator-agent-task-role-grants.sh`): `dev_cloudwatch_logs`
for the gateway answered `The specified log group does not exist.` Every ECS task
definition logs to `/vitana/<service>` (read live: vitana-gateway → /vitana/gateway,
vitana-gateway-awsdr → /vitana/gateway-awsdr, vitana-autopilot-executor →
/vitana/autopilot-executor, worker-runner, oasis-projector, orb-agent,
community-app-awsdr, oasis-operator-awsdr, verification-engine, erp-bridge — all
`/vitana/…`). The tool allowed only `/ecs/vitana-<service>`, a shape no service
uses, so it could never read a single real log line. Contract changed on purpose.

## Acceptance criteria
- AC-1: `/vitana/<service>` is accepted as is.
  TEST: services/gateway/test/vtid-04020-operator-cloudwatch-logs.test.ts
- AC-2: the legacy `/ecs/vitana-<svc>` and a bare `gateway` / `vitana-gateway` map to `/vitana/<svc>`.
  TEST: services/gateway/test/vtid-04020-operator-cloudwatch-logs.test.ts
- AC-3: anything else (`/aws/lambda/…`, nested paths, upper case) is refused before any AWS call.
  TEST: services/gateway/test/vtid-04020-operator-cloudwatch-logs.test.ts
- AC-4: the triage agent's copy of the tool and the operator pipeline are unchanged in behaviour.
  TEST: services/gateway/test/vtid-04232-triage-tools.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
- AC-5: the IAM grant script covers `/vitana/*` (applied live by the owner 2026-09-26).

## Also found, not a code change
Stopped executor tasks show `startedBy: chronos-schedule/…` — four EventBridge
Scheduler schedules (`vitana-gateway-remi…`, `vitana-push-dispatc…`,
`vitana-gateway-dail…`, `vitana-cron-auto-pr…`) launch `vitana-autopilot-executor:2`
with `CRON_JOB=…`; the image exits 2 with `EXEC_ID env var required` every time.
Push dispatch (Lambda, `200 no pending pushes` every minute) and reminders (none
overdue) run through other paths, so disabling those schedules loses nothing; the
owner has the disable command.
