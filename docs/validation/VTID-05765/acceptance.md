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
- Red on base: `outputs/red-on-base.txt` (3 new tests fail on `origin/main`); green: `outputs/collab-green.txt`
  (269/269), gateway `npx jest test/project-manager` 13 suites / 230 tests, `npx tsc --noEmit` exit 0.

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
