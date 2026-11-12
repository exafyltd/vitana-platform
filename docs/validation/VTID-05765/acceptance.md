# VTID-05765 — autonomous-to-staging, lane `machine-gate-protected`

Plan: `.kiro/specs/autonomous-to-staging/plan.md` (§3.1, §3a, §4, §5), merged as `bf1cb134e6` (#5000). Base `origin/main` bf1cb134e6.
Authority for this bootstrap lane: the owner's directive of 2026-11-11 naming plan `autonomous-to-staging` plus a
reviewer-agent accept on the current head (`collaboration.md` §3a, §7b; plan §3a).

## What changed
- `scripts/collab/land-guard.mjs`: `mergeDecision` merges a protected gate file only with
  `PROTECTED_ACCEPTS_REQUIRED` (2) accepts from distinct chain models (`REVIEWER_MODELS`) on the current head;
  `merge` collects the review entries from the PR's commits (`parseReviewEntry`) and checks each reviewed head with
  `reviewCurrent`; `protectedAcceptModels` counts only `agent:vitana-lane-reviewer (<chain model>)` accepts.
- `scripts/collab/queue.mjs`: a lane with `executor: kiro`, `reviewer_seat: agent:vitana-lane-reviewer` and
  `protected_gate: two-model` may declare and change a protected gate file (`isTwoModelLane`); `protected_gate` is
  pinned from the trusted revision (`TRUSTED_PINNED`), so a PR head cannot grant it.
- `protected-gate-files.json`, `PROTECTED_GATE_BUILTIN`, `governance.ts` `PROTECTED_GATE_GLOBS`: add
  `.github/workflows/VTID-ALLOCATE.yml`, `scripts/collab/gate-invariants.test.mjs`.
- `governance.ts` `governanceMergeAllowed(lane, pr, review, reviews)`: same two-model rule for the PM; `reviews` defaults to
  `lane.reviews`, so `decide.ts` and `act.ts` are unchanged.
- `scripts/collab/gate-invariants.test.mjs` (new): the mechanical invariants; `gate-invariants.test.mjs` runs the
  `origin/main` copy against the checkout (bootstrap note when absent) plus mutation fixtures.

## Acceptance (tasks.md)
- One accept → refused; two accepts same model → refused; two different models → allowed:
  `land-guard.test.mjs` "merge: a protected gate file needs two accepts…", `governance.test.ts` "VTID-05765 …".
- No other gate loosened: every existing land-guard, queue and governance test passes unchanged except
  `queue.test.mjs` SECTION_43, extended on purpose with the two new protected globs (contract change, plan §3.2).
- `gate-invariants.mjs` fails when an invariant is removed: mutation tests (drop CLAUDE.md, required accepts 1,
  governance glob removed, prod-ref guard and workflow deferred then enforced).
- Red on base (new tests against `origin/main` code): `outputs/red-on-base.txt` (land-guard + gate-invariants, 4 fail), `outputs/red-on-base-queue.txt` (3 fail, incl. the extended SECTION_43 T16), `outputs/red-on-base-governance.txt` (1 fail); green: `outputs/collab-green.txt`
  (269/269), gateway `npx jest test/project-manager` 13 suites / 230 tests, `npx tsc --noEmit` exit 0.

- `scripts/collab/gate-invariants.test.mjs` runs from the PR head and imports the `origin/main` copy, not a `$BASE`
  copy loaded by a workflow, so one PR could still drop that baseline test. Moving the check to base-loading (as
  PR-GATE.yml loads `queue.mjs` from `$BASE`) belongs with the workflow, so it goes to lane `gate-invariants-ci` /
  follow-up `protect-gate-workflow`; the file is itself on the protected list, so changing it already needs two
  distinct-model accepts.
- The two accepts are read from `Collab-*` commit trailers, the same trust model as single reviews today. Excluding a
  reviewer session that also appears in the lane's executing log is left to a later lane.
- Follow-up lane `protect-gate-workflow` is added to the plan by a `_plan` commit after this lane merges.

## Acceptance criteria → tests

AC-1 One accept, or two accepts from the same chain model, never merges a protected gate file; two accepts from
different chain models on the current head do.
TEST: scripts/collab/land-guard.test.mjs ("merge: a protected gate file needs two accepts from different chain models on the current head")
TEST: services/gateway/test/project-manager/governance.test.ts ("one accept, or two of the same model, is refused"; "two models on the current head are allowed")

AC-2 An accept on an older head, or from a model outside the reviewer chain, does not count.
TEST: services/gateway/test/project-manager/governance.test.ts ("an accept on an older head does not count"; "a model outside the chain does not count")

AC-3 land-guard and the Project Manager use the same reviewer chain.
TEST: scripts/collab/land-guard.test.mjs ("merge: land-guard REVIEWER_MODELS mirrors governance.ts REVIEWER_AGENT_MODELS")

AC-4 Only a trusted `protected_gate: two-model` kiro lane with the agent reviewer may change a protected gate file;
a PR head cannot grant itself that field.
TEST: scripts/collab/queue.test.mjs ("VTID-05765: validateLane accepts a protected path only for a two-model kiro lane with the agent reviewer"; "VTID-05765: scope-check lets a trusted two-model lane change a protected gate file, never a head-granted one")

AC-5 The invariant check fails when a protected glob is dropped, when one accept unlocks a protected file, or when
governance.ts loses a protected glob.
TEST: scripts/collab/gate-invariants.test.mjs ("mutation: dropping a glob from the protected list fails"; "mutation: one accept unlocking a protected gate file fails"; "mutation: governance.ts losing a protected glob fails")

No migration, no secret, no workflow change, no production write.

## Decisions taken
- The plan names `scripts/collab/gate-invariants.mjs`; the lane's `paths` cover `scripts/collab/*.test.mjs` but not
  that name, and a lane file's paths cannot change in a lane PR. So the invariants live in
  `scripts/collab/gate-invariants.test.mjs` (library + tests in one file; `GATE_INVARIANTS_LIBRARY=1` turns its tests
  off while the origin/main copy is imported). The protected list names that file. Lane `gate-invariants-ci` runs
  `node --test scripts/collab/gate-invariants.test.mjs`.
- `decide.ts` / `act.ts` are not in the lane's paths, so `governanceMergeAllowed` reads `lane.reviews` by default
  instead of the callers passing it.
- `.github/workflows/GATE-INVARIANTS.yml` is not on the protected list yet: listing it now makes the existing lane
  `gate-invariants-ci` (executor kiro, no `protected_gate`) invalid, and this PR cannot edit that lane file. The plan
  gets a follow-up lane `protect-gate-workflow` (two-model, after `gate-invariants-ci`) that adds it; until then the
  invariant check enforces the workflow's push-to-`main` trigger once the file exists.
