# VTID-03828 — Enable the Operator DeepSeek execution on-ramp on staging

## Report

VTID-03820 shipped the Operator Console DeepSeek execution on-ramp
(`operator-execution-onramp.ts`'s `triggerOperatorExecution()`) fully
built but deliberately inert: `OPERATOR_EXECUTION_ONRAMP_ENABLED` defaults
OFF and was never set on any live task definition. Explicit
platform-owner request this session: pin it to `"true"` on staging,
redeploy, then test — production is a separate, later decision gated on
that test succeeding.

**This is not a low-stakes flag.** With it on, the Operator Console chat's
`autopilot_execute_task` tool can turn an already-approved VTID into a
real Dev Autopilot execution — a real `autopilot_recommendations` row, a
real `dev_autopilot_plan_versions` row, a real `dev_autopilot_executions`
row approved through the unmodified `approveAutoExecute()` safety gate,
and — if every gate passes — real code written and a real pull request
opened against `exafyltd/vitana-platform`, with that one invocation's LLM
calls forced onto `deepseek-flash`. There is one GitHub repo regardless of
which gateway environment (staging or prod) triggers it, so "test on
staging" means the trigger surface is staging, not that the blast radius
is contained to staging.

## Acceptance Criteria

AC-1 — `AWS-STAGE-DEPLOY-GATEWAY.yml`'s task-definition jq program strips
any inherited `OPERATOR_EXECUTION_ONRAMP_ENABLED` value and re-adds it as
the exact string `"true"` (the only value `isOnRampEnabled()` accepts —
unset/`"false"`/a typo all stay disabled, by design).

TEST: `test/vtid-03820-onramp-staging-flag-pinned.test.ts` — "upserts the
flag as the exact string 'true'" + "strips the inherited value first".

VERIFIED (not just read): extracted the exact jq program from the
workflow file and ran it for real (`jq -f`) against a synthetic task
definition — confirmed `OPERATOR_EXECUTION_ONRAMP_ENABLED: "true"` appears
exactly once in the resulting environment array, and the program has no
syntax error (this repo's own history has twice broken this exact jq
block via careless edits — VTID-03505, VTID-03549 — so this was run for
real, not assumed from a diff).

AC-2 — The flag is deliberately NOT added to
`AWS-PROD-DEPLOY-GATEWAY.yml` — promoting to production is a separate,
later decision gated on a successful staging test, per the explicit
instruction this VTID executes.

TEST: same file — "is deliberately NOT pinned on the prod deploy workflow
yet".

AC-3 — `DEEPSEEK_API_KEY` (the on-ramp's forced provider) is already
wired onto the same staging task definition, confirmed by reading the
existing jq secrets block rather than assumed.

TEST: same file — "DEEPSEEK_API_KEY secret is already wired…".

AC-4 — `tsc --noEmit` clean; no regression in the full gateway suite.

TEST: `outputs/tsc-noemit.txt`; `outputs/jest-vtid-03828-filter.txt` (1/1
suite, 4/4 tests); `outputs/jest-full-suite-tail.txt` (754/755 suites — 1
pre-existing skip — 13,815/13,850 tests passing, 0 failures).

## Deliberately NOT attempted in this VTID

- **No live on-ramp invocation.** Actually exercising this feature means
  choosing a specific, already-`spec_status='approved'` VTID as the real
  execution target, with a real plan and a real files-referenced list —
  and, if every gate passes, a real PR opens. That is a deliberate,
  separate step the platform owner should direct explicitly (which VTID,
  what plan) rather than one this VTID picks unilaterally. This VTID only
  makes the capability reachable; it does not exercise it.
- **No production promotion.** `AWS-PROD-DEPLOY-GATEWAY.yml` is
  untouched. Per the platform owner's own stated sequencing, that's a
  separate decision after a successful staging test.
- **`spec_status` on this VTID's own ledger row was not set to
  `'approved'`** — the governed `PATCH /api/v1/oasis/tasks/:vtid` gateway
  endpoint (used here to set `title`/`status`) does not expose
  `spec_status`; only the `/api/v1/specs/*` generate → quality-check →
  approve pipeline does, and running that retroactively for already-shipped
  work would mean authoring a spec purely to satisfy bookkeeping. Same
  situation and same resolution as the 2026-09-11 VTID-03816 changelog
  entry: `status='in_progress'` set via the governed endpoint; `spec_status`
  left as the allocator's default rather than fabricated.
