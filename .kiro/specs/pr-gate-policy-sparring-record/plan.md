---
change_class: standard
---
# plan(pr-gate-policy-sparring-record): the PR-GATE sparring check accepts a policy approval

Owner, 4 Nov 2026 (Kiro, VTID-05520 stop, decision D3): *"Accept the PR-GATE sparring failure as report-only and file the
tooling fix separately."*

<!-- plan:begin -->
## Goal
A plan that CI sparred to convergence is approved by policy `converged-auto-v1`, not by the owner. The PR-GATE sparring
check reads that record as unapproved, because it looks only for an owner-approval line. Every lane PR of such a plan
therefore shows a failing sparring check. This plan makes the check accept a policy approval and keeps the
owner-approval form unchanged. The check stays report-only in CI.

## Today (file:line evidence on origin/main 56281ad0b8)
- `scripts/ci/pr-gate/lib.mjs:153-160`, `evaluateSparringRecord`: requires a CONVERGED or ESCALATED verdict (line 156),
  the text "owner approval" (line 157) and "plan hash" (line 158). A record that says "approved by policy
  `converged-auto-v1`" fails line 157.
- `scripts/ci/pr-gate/gate.mjs:67-69`: the sparring check resolves the record (the scope's `sparring_record`, else
  `docs/validation/<VTID>/plan-sparring.md`) and passes its text to `evaluateSparringRecord`.
- `scripts/ci/pr-gate/__tests__/lib.test.mjs:75-78` pins the owner-approval rule.
- Policy-approved records have this shape: `.kiro/specs/mt-guardrails-r2/sparring/verdict.md:3` and
  `.kiro/specs/ci-superseded-pr-runs/sparring/verdict.md:3`, "CONVERGED and approved by policy `converged-auto-v1`", with
  a final plan hash.
- The policy approval replaces Gate 1 for CI-sparred plans (CLAUDE.md, Autonomy Contract; owner decision 2026-10-14).
- PR-GATE runs `node --test scripts/ci/pr-gate/__tests__/*.test.mjs` (`.github/workflows/PR-GATE.yml:52`). The sparring
  verdict is report-only (`scripts/ci/pr-gate/config.json`: `enforce` is not true).
- vitana-v1 keeps an identical copy: `scripts/ci/pr-gate/lib.mjs:202-209`, and the same test case at
  `scripts/ci/pr-gate/__tests__/lib.test.mjs:75-78`. Both copies change here, as two lanes, so they do not drift.
- Found while checking VTID-05520 (`mt-guardrails-r2/local-test-stack-pglite`): its preflight fails this check on a
  policy-approved verdict.

## Change
1. `evaluateSparringRecord` accepts either approval form:
   - an owner-approval line (unchanged), or
   - a policy approval: the text "approved by policy `converged-auto-v1`", only together with a CONVERGED verdict.
   A policy approval on an ESCALATED verdict, or any other policy name, is a problem.
2. When neither form is present, the problem text names both forms. Before the change, `git grep` shows that only the
   function and its test use the old text.
3. The verdict and plan-hash checks stay as they are.
4. Not changed: `gate.mjs`, `config.json`, `PR-GATE.yml` (a protected gate file), the `vtid_ledger` trigger, and every
   sparring record already on main.

## Lanes
- `policy-approval-record` (repo `exafyltd/vitana-platform`): `scripts/ci/pr-gate/lib.mjs` and
  `scripts/ci/pr-gate/__tests__/lib.test.mjs`.
- `policy-approval-record-v1` (repo `exafyltd/vitana-v1`): the same two paths, the same change, the same tests.
Both lanes have `depends_on: []` and touch different repositories, so they run in parallel.

## Tests and commands
- `node --test scripts/ci/pr-gate/__tests__/*.test.mjs` is green in each repository. The new cases are: an owner-approved
  record passes (the existing case); a CONVERGED record with a policy approval and a plan hash passes; an ESCALATED record
  with a policy approval fails; an unknown policy name fails; a record with neither approval fails.
- Each new case is red on the base revision before the change.
- After merge, the sparring check passes on `.kiro/specs/mt-guardrails-r2/sparring/verdict.md`, the record VTID-05520
  points to, with no change to that record.

## Measurement
The standard `docs/validation/<plan VTID>/timings.json` (`collaboration.md` §8b), written by the execution as for every plan.

## Risks
- The check becomes looser for policy approvals, because it reads text only. The authoritative gate is the
  `vtid_ledger` trigger, which checks the record in the database (`CLAUDE.md` rule 54). This check is report-only in CI.
- The owner-approval form is still accepted without change.
<!-- plan:end -->
