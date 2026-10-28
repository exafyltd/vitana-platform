# VTID-03929 — Enable dev_aws_ecs_status on staging using the gateway's broad IAM role

## Report / context

`dev_aws_ecs_status` (VTID-03836) has existed since it shipped but was
never enabled anywhere: `OPERATOR_AWS_READONLY_ENABLED` defaults off and
was not pinned on any deploy workflow, because the tool's own client runs
under the gateway's existing broad IAM role (the same role that holds
`ecs:RunTask`) rather than a dedicated, narrowly-scoped role.

Earlier in this conversation I proposed building a narrower STS-assumed
role before enabling this anywhere and began adding the
`@aws-sdk/credential-providers` dependency toward that. **The platform
owner explicitly rejected that approach**, verbatim: *"Who told you to
build a narrow AWS role? I want a broad AWS role. The operator is a daily
development tool. It must have the maximum possible access and
permissions. Otherwise, we are stuck in the process, repeating unnecessary
blockers. No way to do a narrow role. It must have the maximum broad
one."*

## Decision, not a fix

This is a recorded product decision by the platform owner, not a
discovered bug: the Operator Console is treated as an internal daily
development tool, and broad AWS access is an explicit, accepted tradeoff
for development velocity over the narrower, not-yet-built alternative.
`@aws-sdk/credential-providers` was uninstalled again — it is not needed
for this path, since the default AWS credential chain (the gateway task's
own broad role) is exactly what gets used once the flag is on, with zero
new code.

## Change

1. `services/gateway/src/services/aws-ecs-readonly.ts`: rewrote the header
   comment to record the platform owner's explicit decision (previously
   said "DO NOT ENABLE IN ANY REAL ENVIRONMENT UNTIL THIS IS CLOSED").
   Zero logic change — the client already used the default credential
   chain; only the gate (`OPERATOR_AWS_READONLY_ENABLED`) controls whether
   the tool executes at all.
2. `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml`: added
   `OPERATOR_AWS_READONLY_ENABLED` to both the strip list and the set list
   in the task-def jq block, value `"true"` — the exact same pattern
   already used for its two siblings, `OPERATOR_CODEBASE_READ_ENABLED` and
   `OPERATOR_DB_READONLY_ENABLED` (both already `true` on staging).
   Deliberately NOT added to `AWS-PROD-DEPLOY-GATEWAY.yml` — promoting to
   prod is a separate, later decision, same convention as every other
   staging-only flag in this file.

Every call this client makes is still `DescribeServicesCommand` only
(never `UpdateService`/`RunTask`/`RegisterTaskDefinition`), and still
refuses any service name outside `ALLOWED_ECS_SERVICES` before making an
AWS call — the broad-role decision widens WHO can invoke the read, not
WHAT the tool is capable of doing.

## Acceptance Criteria

AC-1 — `OPERATOR_AWS_READONLY_ENABLED=true` is present in
`AWS-STAGE-DEPLOY-GATEWAY.yml`'s task-def environment set, matching its
two siblings.

TEST: manual grep, confirmed in `commands.log`; YAML re-validated with
`python3 -c "import yaml; yaml.safe_load(...)"`.

AC-2 — no behavior change to what `dev_aws_ecs_status` is capable of
doing (still read-only, still allowlist-gated) — only whether it runs at
all.

TEST: `services/gateway/test/vtid-03835-operator-console-read-tools.test.ts`
(pre-existing, unmodified) still exercises the exact same
`OPERATOR_AWS_READONLY_ENABLED` gate and `ALLOWED_ECS_SERVICES` allowlist;
`outputs/jest-full-suite.txt` confirms it still passes unchanged.

## Verification

- `tsc --noEmit`: clean (`outputs/tsc-noemit.txt`) — comment-only source change.
- Full gateway suite (regression check): `outputs/jest-full-suite.txt` —
  905/906 suites (1 pre-existing skip), 14,978/15,013 tests passing, 0
  failures.
- Workflow YAML re-validated as well-formed after the edit.

## What this does NOT confirm

Not yet confirmed against a real deployed session: once staging redeploys
with this change, `dev_aws_ecs_status` should stop returning
`operator_aws_readonly_disabled` and instead return real ECS service data
for an authenticated admin caller (the exact call I ran live during
VTID-03926's verification, which returned the disabled error at that
time) — that live confirmation happens as part of the next staging deploy
check-in.

## OASIS impact

OASIS_IMPACT: no — a feature flag flip + comment update, no schema/event changes.
