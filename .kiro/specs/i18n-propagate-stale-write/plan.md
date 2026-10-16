# Plan — i18n-propagate-stale-write

Spec: `.kiro/specs/i18n-propagate-stale-write/` (requirements.md, design.md, tasks.md). Code repo: **exafyltd/vitana-v1**.
The spec lives in vitana-platform because PLAN-SPAR (`vitana-platform:.github/workflows/PLAN-SPAR.yml:22-27`, trigger
`pull_request_target` on this repository only) does not run on vitana-v1 PRs.

<!-- plan:begin -->
## Goal

Stop the vitana-v1 `I18N-PROPAGATE` workflow from writing stale locale files over translations committed to the branch
while it was running. Seen on exafyltd/vitana-v1#1399: bot commit `6b698ac98` reverted the human translations of
`2f5c0cbf4` (9 locales, `spotlightMember.settings.preferences.{desc,accessibilityNote}`); re-applied by hand in
`ab05df942`.

## Root cause (vitana-v1 `origin/main` 5c4632ea9)

1. `vitana-v1:.github/workflows/I18N-PROPAGATE.yml:181` — each fan-out job checks out the branch head when it starts.
2. `vitana-v1:.github/workflows/I18N-PROPAGATE.yml:220-223` — it uploads the **whole** `src/i18n/<locale>` directory
   and `i18n-source-stamps/<locale>.json`, not its changes.
3. `vitana-v1:.github/workflows/I18N-PROPAGATE.yml:232` — `collect` checks out the branch head when **it** starts.
4. `vitana-v1:.github/workflows/I18N-PROPAGATE.yml:245-246` — `cp -r incoming/src/i18n/. src/i18n/` overwrites every
   file with the fan-out's older snapshot.
5. `vitana-v1:.github/workflows/I18N-PROPAGATE.yml:261-265` — the commit is made on the fresh head, so the revert is a
   normal diff and `git pull --rebase` has nothing to merge.

Evidence, run 38443615525 (head `998b8b0aa`, created 18:03Z): fan-out jobs started 20:16Z–21:55Z; `collect` started
23:13Z, checked out `2f5c0cb` (pushed 22:59Z), rebase "Current branch … is up to date", pushed `2f5c0cb..6b698ac`.
Anything committed to a non-DE locale between a fan-out checkout and `collect`'s checkout is lost; this run's window was
about three hours. Secondary: `:162` and `:265` run `git pull --rebase … || true`, hiding a conflicting rebase.

## Fix (one lane `fix-workflow`, executor claude — `.github/**` is a governance path)

1. `vitana-v1:scripts/i18n-propagate-apply.mjs` (new): key-level 3-way merge per locale file:
   `merge(base = file at the fan-out's start SHA, bot = fan-out output, ours = current branch)`. Per leaf: bot unchanged
   → ours; ours unchanged → bot (adds/deletes included); both changed → ours, plus `::warning::` with locale/file/key.
   A shard deleted on the branch is not recreated. Same rules for stamp files. Keeps the existing serialisation
   (2-space pretty for shards, one line for stamps, trailing newline) so untouched keys produce no diff. Missing
   `base_sha.txt` or unparsable JSON → exit 1, nothing written for that locale.
   Why key-level, not `git apply --3way`: adjacent JSON lines conflict in a line merge; parsed keys do not.
   Why human wins: a later human edit is a decision; a skipped bot value is re-translated on the next run because the
   stamp check flags it.
2. `vitana-v1:.github/workflows/I18N-PROPAGATE.yml`: fan-out records `base_sha.txt` (`git rev-parse HEAD` after
   checkout) into its artifact; `collect` uses `fetch-depth: 0`, replaces the `cp -r` step with the script, and its
   push loop becomes fetch → `reset --hard origin/<ref>` → script → commit → push (5 attempts, then red); `pivot`
   replaces `|| true` with `git rebase --abort` + retry. Header comment updated.
3. `vitana-v1:.github/workflows/i18n-check.yml`: one step `node --test scripts/i18n-propagate-apply.test.mjs`
   (the script path already matches its `scripts/i18n-*` filter).

## Test plan

- `vitana-v1:scripts/i18n-propagate-apply.test.mjs` (`node --test`, temporary git repo, pattern of
  `scripts/ci/pr-gate/__tests__/*.test.mjs`):
  a. replay of #1399 — human translation after base + bot change to other keys → both kept;
  b. same key changed by both → human kept, one warning;
  c. bot add / delete / new shard → applied;
  d. shard deleted by human → not recreated;
  e. compact stamp file merged key-wise, stays one line;
  f. untouched keys byte-identical; second run is a no-op;
  g. artifact without `base_sha.txt` → exit 1, nothing written.
  Mutation check: scenarios a, b, d fail against a whole-file-copy implementation.
- Workflow syntax validated with actionlint (or `@action-validator/cli`).
- CI: PR-GATE (incl. Lane scope) and `i18n check` green on the lane PR.
- No staging suite and no Gate 2: the change deploys nothing. No test touches production or a live branch; the
  executor does not dispatch the workflow. First natural post-merge run's `collect` log shows the merge summary.

## Risks

- A key both sides changed keeps the human value even if the human value is an old placeholder; the stamp check still
  reports it and the next run re-translates. Accepted.
- `collect` reads base blobs by SHA; a force-pushed branch can drop that SHA → script exits 1, run red, re-run drains.
  Accepted (fail loud).
<!-- plan:end -->
