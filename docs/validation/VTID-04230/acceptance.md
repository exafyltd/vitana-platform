# VTID-04230 — Prod parity: the operator/autopilot flags declared on the prod gateway workflow

## Gap (docs/AGENT-REGISTRY.md finding 4)

The live prod gateway task definition (`vitana-gateway-awsdr` rev 114) pins
one operator flag (`OPERATOR_EXECUTION_ONRAMP_ENABLED=true`); staging pins
fourteen. Production therefore ran the single-shot, zero-tool console the
gap analysis §0 describes while staging ran the agent — and every
`AWS-PROD-DEPLOY-GATEWAY.yml` run carried that difference forward, because
the workflow copies the task definition verbatim and only overwrites what
it explicitly pins.

## Fix (declared, NOT dispatched)

One unconditional strip-then-add jq pass in the pinned-flags step of
`.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml` declares, with exactly the
values staging pins: `OPERATOR_EXECUTION_ONRAMP_ENABLED`,
`OPERATOR_ONRAMP_EXECUTOR=agent`, `OPERATOR_CODEBASE_READ_ENABLED`,
`OPERATOR_DB_READONLY_ENABLED`, `OPERATOR_AWS_READONLY_ENABLED`,
`OPERATOR_BOOTSTRAP_PACK_ENABLED` + `OPERATOR_BOOTSTRAP_BUILD_INFO_URLS`,
`OPERATOR_VTID_SELF_ALLOCATE_ENABLED`, `OPERATOR_PR_APPROVAL_REQUIRED`,
`OPERATOR_THREADS_ENABLED`, `OPERATOR_TURN_MEMORY_ENABLED`,
`OPERATOR_CODEINTEL_ENABLED`, `OPERATOR_PLANNER_ENABLED`.

Deliberately not mirrored (reasons in the workflow comment): the staging
ECS-dispatch trio (prod's executor tick is off, staging owns executions),
the read-only SQL switch + secret (needs a Secrets Manager reference this
workflow cannot resolve; a dangling one fails ECS provisioning), the
DeepSeek key secret (same provisioning risk; owner decision).

The workflow was **not** dispatched. Nothing on production changes until
the next PUBLISH or a deliberate manual dispatch.

## Task-role grants

`scripts/aws/setup-operator-agent-task-role-grants.sh --apply` was run
from this session and denied (log in outputs/): `iam:PutRolePolicy` on
`vitana-ecs-task-role` — no identity-based policy allows it for
`claude-code-aws-agent`. The inline policy remains absent (`status`
subcommand). Owner step, unchanged since VTID-04037.

## Acceptance Criteria

AC-1 — Every mirrored flag is pinned on prod with exactly the value staging pins, and stripped first so a stale value cannot survive a deploy.
TEST: services/gateway/test/vtid-04230-prod-operator-flags-declared.test.ts — "is pinned on prod with exactly the value staging pins" ×13, "strips an inherited … first" ×13.

AC-2 — The declaration is one unconditional jq pass in the pinned-flags step (so PUBLISH's promote mode carries it), not a dispatch input.
TEST: services/gateway/test/vtid-04230-prod-operator-flags-declared.test.ts — "is one unconditional jq pass …".

AC-3 — The executor-tick trio, the read-only SQL wiring, the DeepSeek secret and the CLI repo dirs stay absent from prod, with the reasons recorded in the workflow.
TEST: services/gateway/test/vtid-04230-prod-operator-flags-declared.test.ts — "deliberately does not pin …"; VTID-03850's "is deliberately NOT pinned on the prod gateway deploy workflow" still green.

AC-4 — The four earlier suites that pinned "not on prod" now pin the new truth, and every suite that reads the prod workflow is green.
TEST: services/gateway/test/vtid-03820-onramp-staging-flag-pinned.test.ts, vtid-04006-staging-onramp-executor-pinned.test.ts, vtid-04018-operator-bootstrap-pack.test.ts, vtid-04037-staging-operator-agent-flags-pinned.test.ts (updated); 21 suites reading AWS-PROD-DEPLOY-GATEWAY.yml re-run (commands.log).

AC-5 — The prod workflow still has no push trigger; merging this never deploys.
TEST: services/gateway/test/vtid-04230-prod-operator-flags-declared.test.ts — "the prod workflow still has no push trigger".

AC-6 — Live: the task-role grant was attempted and the denial recorded verbatim; nothing was dispatched to prod.
CURL: `scripts/aws/setup-operator-agent-task-role-grants.sh --apply` → outputs/setup-operator-agent-task-role-grants-apply-2026-09-21.log (AccessDenied iam:PutRolePolicy); `gh run list --workflow AWS-PROD-DEPLOY-GATEWAY.yml` shows no run from this session.
