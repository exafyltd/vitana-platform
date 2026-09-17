# VTID-04020 — W5a: `dev_cloudwatch_logs` — read-only CloudWatch Logs for the Operator Console (gap analysis §4.4 item 3)

Context: `docs/OPERATOR-CONSOLE-GAP-ANALYSIS-2026-09-17.md` §4.4 lists the access the console needs, in order; item 3 is `logs:FilterLogEvents` on `/ecs/vitana-*`. Until now the console could see a service's ECS rollout state (`dev_aws_ecs_status`, VTID-03836) and its DB rows (`dev_db_query`, VTID-03837) but never what the service actually logged — the first thing a Claude Code session reads when something is wrong on staging (`aws logs tail /ecs/vitana-gateway --since 1h`, CLAUDE.md §11).

Same posture as the ECS tool, deliberately: a separate module and cached client (`aws-cloudwatch-logs-readonly.ts`); runs under the gateway task's own broad IAM role (the platform owner's recorded VTID-03929 decision — no narrow role); imports only `FilterLogEventsCommand`; the log group must match `/ecs/vitana-<service>` before any AWS call; window (default 30 min, max 24 h), event count (default 50, max 200), per-message (600 chars) and total (24 KB) payload are all bounded; an IAM denial is returned verbatim, never an empty result. Gated by the existing `OPERATOR_AWS_READONLY_ENABLED` (pinned on staging only); role-gated as every `dev_*` tool (developer/admin).

AC-1 — `normalizeLogsQuery` accepts only `/ecs/vitana-<service>` groups (rejects other groups, Lambda groups, bare names, uppercase, sub-paths), clamps/defaults the window and limit, and trims/bounds the filter pattern.
TEST: services/gateway/test/vtid-04020-operator-cloudwatch-logs.test.ts

AC-2 — `boundLogEvents` clips long messages, keeps the stream tail, and stops at the total budget with `truncated: true`.
TEST: services/gateway/test/vtid-04020-operator-cloudwatch-logs.test.ts

AC-3 — `filterVitanaLogs` sends exactly one `FilterLogEvents` for the bounded window (`startTime`/`endTime`/`limit`, `filterPattern` only when given, `interleaved`), reports truncation from `nextToken`, carries a note on an empty window, and refuses a non-allowlisted group before any AWS call.
TEST: services/gateway/test/vtid-04020-operator-cloudwatch-logs.test.ts

AC-4 — Tool wiring: `dev_cloudwatch_logs` is declared on the operator wire schema and dispatched; blocked for a non-developer role; kill-switched off by default; requires `log_group`; refuses an out-of-shape group without an AWS call; returns the bounded events for a developer; surfaces an AWS/IAM failure verbatim.
TEST: services/gateway/test/vtid-04020-operator-cloudwatch-logs.test.ts
TEST: services/gateway/test/vtid-03835-operator-console-read-tools.test.ts

Not verified here: a live read on staging. The gateway task role is the broad one (VTID-03929) but this session cannot list its policies (`iam:ListAttachedRolePolicies` denied for the session's own user), so whether `logs:FilterLogEvents` is granted is unknown until the first call — which will say so verbatim if it is not. That grant, if missing, is the owner's (declared in the deploy workflow / IaC, never hand-edited on the task def — §4.4).
