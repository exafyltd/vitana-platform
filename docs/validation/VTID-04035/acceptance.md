# VTID-04035 — W5c: `dev_ecs_tasks` — the Operator Console's read-only ECS task-level view (gap analysis §4.4, item 4)

Context: the console could describe a service's rollout (`dev_aws_ecs_status`, VTID-03836 — desired/running/pending counts, task definition, deployments) and read a service's logs (`dev_cloudwatch_logs`, VTID-04020), but never see the tasks themselves: which container is actually running, when it started, why one stopped, with what exit code. Two real questions from the last week could not be asked from the console: "is the executor task for execution X still alive?" (the VTID-04011 watchdog incident reclaimed a live task as dead) and "why do the stale `vitana-autopilot-executor:2` tasks the EventBridge schedules launch exit 2?" (noted, not answered, in the Run #4 record). The one-shot executor has no ECS service at all — only a task family — so the service-level tool cannot even address it.

What ships:

- `services/gateway/src/services/aws-ecs-readonly.ts` (same module, same cached client, same broad task role — the recorded VTID-03929 decision; still never `StopTask`/`RunTask`/`UpdateService` here):
  - `ALLOWED_ECS_TASK_FAMILIES = ['vitana-autopilot-executor']` — task families addressable by `family`; services stay addressable by name through the existing `ALLOWED_ECS_SERVICES` (CLAUDE.md §1b's table).
  - `normalizeTasksQuery` (pure): the target must be a listed service or family (refused before any AWS call), `desired_status` RUNNING (default) or STOPPED (case-insensitive), `limit` default 10 / max 25 / garbage → default.
  - `summarizeEcsTask` (pure): task id (ARN tail), status, health, task-definition `family:revision`, group, launch type, cpu/memory, created/started/stopped ISO times, stop code, stopped reason (≤ 300 chars), per container name/status/exit code/reason (≤ 300)/image tail.
  - `listEcsTasks`: `ListTasksCommand` (`serviceName` or `family`, `desiredStatus`, `maxResults`) then `DescribeTasksCommand` on the listed ARNs; newest first; `truncated` from `nextToken`; an empty listing skips the describe and carries a note.
- `gemini-operator.ts`: `dev_ecs_tasks` on the operator wire schema (after `dev_cloudwatch_logs`), `executeDevEcsTasks` behind the existing `OPERATOR_AWS_READONLY_ENABLED` kill switch and the `dev_*` developer/admin gate, argument validation before any AWS call, an IAM/AWS failure returned verbatim (`ECS tasks read failed: …`).
- No new flag, secret, schema, route, workflow or task-def change. **IAM:** `ecs:ListTasks` + `ecs:DescribeTasks` on `vitana-ecs-task-role` are unverified (only `ecs:DescribeServices` and `ecs:RunTask` are known to work); a denial is returned verbatim, the same posture as VTID-04020's `logs:FilterLogEvents`.
- Six existing suites mock `aws-ecs-readonly` with an explicit factory; they now also export the new names, since the operator schema reads `ALLOWED_ECS_TASK_FAMILIES` at module load.

AC-1 — `normalizeTasksQuery`: every §1b service and the executor family are accepted (trimmed), anything else is refused by name before an AWS call; status defaults/enum; limit default/max/garbage.
TEST: services/gateway/test/vtid-04035-operator-ecs-tasks.test.ts

AC-2 — `summarizeEcsTask`: ARNs → ids, images → tails, dates → ISO, reasons clipped, missing fields tolerated.
TEST: services/gateway/test/vtid-04035-operator-ecs-tasks.test.ts

AC-3 — `listEcsTasks` call shape: a service lists by `serviceName`, a family by `family`; the listed ARNs are described in one call; newest first; `truncated` from `nextToken`; an empty listing makes one call and carries a note; an unlisted target makes no call.
TEST: services/gateway/test/vtid-04035-operator-ecs-tasks.test.ts

AC-4 — Tool wiring: blocked for a non-developer role; kill-switched off by default; `target` required; an undocumented target refused without an AWS call; the bounded list returned for a developer; an IAM/AWS failure surfaced verbatim. The VTID-04020 / VTID-03835 / VTID-04018 read-tool suites still pass.
TEST: services/gateway/test/vtid-04035-operator-ecs-tasks.test.ts
TEST: services/gateway/test/vtid-04020-operator-cloudwatch-logs.test.ts
TEST: services/gateway/test/vtid-03835-operator-console-read-tools.test.ts

OASIS_PROOF: no OASIS change — a read-only tool that emits nothing; its calls are logged with the `[VTID-04035]` prefix like its siblings.

Not verified here: a live call on staging — the first `dev_ecs_tasks` turn answers whether the task role may `ecs:ListTasks`/`ecs:DescribeTasks` (a denial is quoted verbatim, exactly as VTID-04020's first call quoted `logs:FilterLogEvents`), and, if it may, finally shows what the stale executor tasks are doing.
