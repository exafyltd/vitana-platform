# Tasks — review-survives-main-merge
<!-- lane: land-guard-merge -->
Repo `exafyltd/vitana-platform`. Code starts only after the VTID is allocated (plan § Lanes).
- [ ] T1 Test first: add the fixture and pure tests of plan § Change 6 to `scripts/collab/land-guard.test.mjs`. On
      `origin/main` run `node --test scripts/collab/land-guard.test.mjs` and save the output to
      `docs/validation/<VTID>/red-on-base.txt`: case (a) and (h-ok) must fail because the clean merge of `main` is
      refused (or the new export is missing), not on a fixture setup error.
- [ ] T2 `land-guard.mjs`: `mergeKeepsReview` incl. the `GOVERNANCE_PATHS` refusal (Change 1), `reviewCurrent`
      accepts a clean merge with `prDiffSame` (Change 2), the PR-diff identity (Change 3), `localAfter`, `--repo` on
      `review`/`merge` and the `origin`-URL check (Change 4/4a), CLI test (j). The API path without `--repo` is
      unchanged.
- [ ] T3 `.claude/rules/collaboration.md` §3: the rule of Change 5 (incl. the governance-path and PM-path sentences).
      No other section changes.
- [ ] T4 Green on head: `node --test scripts/collab/land-guard.test.mjs` and `node --test scripts/collab/*.test.mjs`
      pass. Commands and summaries in `docs/validation/<VTID>/commands.log`; `acceptance.md`, `scope.json` present.
- [ ] T5 PR titled `VTID-xxxxx (review-survives-main-merge/land-guard-merge): …`; required checks green on its head;
      merge only with the owner's instruction naming this plan plus a reviewer-agent accept on the current head.
<!-- lane: lane-land-repo -->
- [ ] T6 After `land-guard-merge` is on `main`: `.kiro/pipeline/lane-land.md` step 3d passes `--repo <checkout of
      owner/repo>` to `land-guard.mjs merge` and keeps the accept only when land-guard reports it current (plan
      § Change 4a). No other step changes. `node scripts/collab/queue.mjs validate` on the lane head exits 0; PR
      `VTID-xxxxx (review-survives-main-merge/lane-land-repo): …` with required checks green.
Acceptance:
- Change types: Tooling/CI (collab script, its tests, one rule sentence, validation records).
- **Outcome** — a reviewer-agent accept survives a clean, conflict-free merge of `main` that leaves the PR's own diff
  byte-identical and changes no protected gate file; a rebase, a conflict resolution, an extra edit, a merge of a
  non-main branch or a changed PR diff still needs a new review.
- **States / Surfaces / Locales / Accessibility** — n/a: no UI or runtime change.
- **Contract** — `land-guard.mjs` without `--repo` behaves exactly as today; exit codes unchanged.
- **Staging proof** — nothing deploys; covering test is `scripts/collab/land-guard.test.mjs`.
- Red on base for the reason fixed, green on head; diff only inside the lane `paths`; no test skipped or loosened;
  files UTF-8 without BOM.
