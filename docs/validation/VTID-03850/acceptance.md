# VTID-03850 — Staging on-ramp executions run on the ECS executor task

## Report

The staging gateway ran every Dev Autopilot execution in-process: neither
`DEV_AUTOPILOT_USE_JOB` nor `DEV_AUTOPILOT_JOB_CLOUD` was pinned on
`AWS-STAGE-DEPLOY-GATEWAY.yml`, so `USE_JOB_RUNTIME` resolved to its code
default (`false`) and each claimed execution became a fire-and-forget
promise on the gateway task. Observed 2026-09-13 (VTID-03841): the
operator on-ramp execution for VTID-03829 hung on a DeepSeek call with no
timeout, was reclaimed by the 20-minute watchdog, and its retry failed on
`GITHUB_SAFE_MERGE_TOKEN not set` because the gateway task has no GitHub
token. The runtime built for exactly this case — the one-shot
`vitana-autopilot-executor` Fargate task (VTID-02703 / VTID-03415), which
carries `GITHUB_SAFE_MERGE_TOKEN` and survives gateway container churn —
was never used on staging.

Two things had to change together:

1. **Staging gateway dispatches to the executor.** `DEV_AUTOPILOT_USE_JOB=true`
   and `DEV_AUTOPILOT_JOB_CLOUD=aws` are upserted onto the staging task
   definition (stripped from inherited values first, same pattern as every
   other pin in that block). `dev-autopilot-execute.ts`'s own dispatch loop
   already falls back to the in-process run when `ecs:RunTask` is refused,
   logging the reason — so the worst case of this pin is today's behaviour
   plus a warning line, never a silent loss.

2. **The executor gets an LLM runtime.** The executor image was last built
   2026-07-24 and its task definition carried no LLM credential at all (its
   own header records `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` as deferred, and
   nothing Bedrock- or DeepSeek-related was ever added). Every dispatched
   execution would therefore have failed at the worker call.
   `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml`'s register step now upserts
   `BEDROCK_ROLE_ARN` (the executor task definition's own `taskRoleArn`,
   the same activation pattern the gateway task defs use),
   `AWS_BEDROCK_REGION`, and the `DEEPSEEK_API_KEY` secret (the identical
   Secrets Manager secret the staging gateway resolves, referenced by name
   because the prod deploy role has no `secretsmanager:Describe*`). The
   rebuild also brings the executor onto current `main`, which carries
   VTID-03820/03839/03841/03843 — without it the executor would run
   7-week-old code, including the DeepSeek call with no timeout.

Not pinned on the prod gateway workflow: prod keeps whatever its live task
definition carries until a staging dispatch has been observed end to end.

## Acceptance Criteria

AC-1 — Staging pins `DEV_AUTOPILOT_USE_JOB="true"` and
`DEV_AUTOPILOT_JOB_CLOUD="aws"`, and strips both inherited values first.

TEST: `test/vtid-03850-staging-executor-dispatch-pinned.test.ts` — "pins
DEV_AUTOPILOT_USE_JOB to the exact string \"true\"", "pins
DEV_AUTOPILOT_JOB_CLOUD to \"aws\"", "strips both inherited values first".

AC-2 — The prod gateway workflow is deliberately untouched.

TEST: same file — "is deliberately NOT pinned on the prod gateway deploy
workflow".

AC-3 — The executor register step upserts `BEDROCK_ROLE_ARN` from the
executor's own `taskRoleArn`, `AWS_BEDROCK_REGION`, and the
`DEEPSEEK_API_KEY` secret by the same name the staging gateway uses, and
strips inherited copies first.

TEST: same file — the four tests under "the executor task definition gets
an LLM runtime of its own".

AC-4 — Both workflows still parse as YAML and the edited `run:` scripts
pass `bash -n`.

TEST: `outputs/workflow-syntax.txt`.

AC-5 — No regression in the existing on-ramp pin test.

TEST: `outputs/jest-scoped-pins.txt` (`vtid-03820-onramp-staging-flag-pinned`
+ this file).

## Verified live after merge (recorded in commands.log)

- `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` dispatched from `main` with a
  recorded reason; its log shows the executor task role it activated
  Bedrock on.
- Staging redeployed with the two pins; `/api/v1/admin/build-info` on the
  merge commit.

## Not verified here

- Whether the staging gateway task role holds `ecs:RunTask` and
  `iam:PassRole` for the executor's roles, and whether the executor task
  role holds `bedrock:InvokeModel` — neither is readable from the repo and
  this session has no AWS CLI. The first dispatched execution is the check:
  a `[dev-autopilot-execute] Job dispatch (aws) failed … falling back to
  in-process` line means the gateway role is missing RunTask/PassRole; an
  `llm.call.failed` from the executor with an AccessDenied means the
  executor role lacks Bedrock.
- Whether `GITHUB_SAFE_MERGE_TOKEN` on the executor (a PAT populated
  2026-07-24) is still valid.
