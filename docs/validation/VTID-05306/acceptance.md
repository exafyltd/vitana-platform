# VTID-05306 — plan-spar-checks

Producer-only (R3-F2 option B), CI-only, deploys nothing. Add only the
*producer* side of the needs-rebase signal in `.github/workflows/PLAN-SPAR.yml`:
after the round-commit push, when `secrets.PLAN_SPAR_PUSH_TOKEN` is empty (the
`GITHUB_TOKEN` case, which starts no `pull_request` checks on the new bot head),
post a `plan-spar/needs-rebase` commit status on the new bot head via
`POST /repos/{owner}/{repo}/statuses/{sha}`. Plan:
`.kiro/specs/ci-github-modernization/`, lane `plan-spar-checks`.

## What changed

1. **`PLAN-SPAR.yml` — `statuses: write`** in the explicit workflow `permissions:`
   block (R3-F1). An explicit block zeroes every unlisted scope, so the status
   POST would 403 without it.
2. **`PLAN-SPAR.yml` — one new step** `Signal needs-rebase on the bot head
   (GITHUB_TOKEN push)` after `Commit the round`: reads the pushed bot head SHA,
   confirms the head is the bot's own round commit (`Collab-Session: ci-plan-spar`)
   so it no-ops when nothing was committed, and posts the `plan-spar/needs-rebase`
   status. No re-run / re-dispatch / Checks API (plan R2-F1: a re-run hits the old
   SHA; the Checks API needs `checks:write` the `pull_request_target`
   `GITHUB_TOKEN` lacks).
3. **`scripts/ci/plan-spar-slot/slot.test.mjs`** — producer-contract proof test;
   the existing step-count assertion is updated accordingly.

## Why

The posted status has no effect until the *consumer* is built — today's behaviour
is unchanged by this lane. The consumer (the PM/land step reading the status and
running `gh pr update-branch`) lives in the gateway
(`services/gateway/src/services/project-manager/act.ts`), needs a staging deploy,
and is deferred to a separate gateway lane outside this plan's "deploys nothing"
scope (surfaced for Gate 2 with the `PLAN_SPAR_PUSH_TOKEN` PAT secret).

AC-1 `PLAN-SPAR.yml` posts the `plan-spar/needs-rebase` producer status on the
     GITHUB_TOKEN bot-head push, after the round-commit push, and has
     `statuses: write` in its explicit permissions block
  TEST: node --test scripts/ci/plan-spar-slot/slot.test.mjs
AC-2 The change is red on base (origin/main: `statuses: write` present from the
     plan merge, but no needs-rebase step) and green on head
  TEST: see outputs/red-on-base.txt (base) and outputs/green-on-head.txt (head)
AC-3 `PLAN-SPAR.yml` differs from main only by the slot step and the producer
     needs-rebase step/permission; parses as valid YAML
  TEST: node --test scripts/ci/plan-spar-slot/slot.test.mjs
AC-4 The existing PLAN-SPAR sparring behaviour is unaffected
  TEST: node --test scripts/collab/plan-spar.test.mjs

OASIS_IMPACT: no
