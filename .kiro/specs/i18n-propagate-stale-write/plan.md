# Plan — i18n-propagate-stale-write

Spec: `.kiro/specs/i18n-propagate-stale-write/` (requirements.md, design.md, tasks.md). Code repo: **exafyltd/vitana-v1**.
The spec lives in vitana-platform because PLAN-SPAR (`vitana-platform:.github/workflows/PLAN-SPAR.yml:23-28`, trigger
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

### Premise excerpts (verbatim)

Since vitana-platform #4201 (VTID-05215) a new PLAN-SPAR session is pinned to vitana-v1 `main` as well
(`PLAN-SPAR.yml:97-101` → `plan-spar.mjs:383-384`, `:257` `extra_refs`), so these premises can be read directly; the
excerpts stay as a cross-check. Pinned: vitana-v1 `5c4632ea91319a68724d4d17f56dec39569a8ba1`; re-checked at
`origin/main` `704b5def4cfa0296776d21507b8d19bc5a47c31b` (2026-10-18) and `1a553367ff6622cc746c4720c6e3558e691b34dc`
(2026-10-21) — `git diff 5c4632ea9 1a553367f -- .github/workflows/I18N-PROPAGATE.yml .github/workflows/i18n-check.yml
scripts/ci/pr-gate/__tests__` is empty and `scripts/i18n-propagate-apply.mjs` does not exist yet, so every line number
below holds on all three.

- `I18N-PROPAGATE.yml:181` (fanout checkout): `ref: ${{ github.head_ref || github.ref_name }}`
- `I18N-PROPAGATE.yml:220-222` (fanout upload): `path: |` / `src/i18n/${{ matrix.locale }}` /
  `i18n-source-stamps/${{ matrix.locale }}.json`
- `I18N-PROPAGATE.yml:232` (collect checkout): `ref: ${{ github.head_ref || github.ref_name }}`
- `I18N-PROPAGATE.yml:236-241` (collect download): `pattern: i18n-*`, `merge-multiple: true`, `path: incoming`
- `I18N-PROPAGATE.yml:245-246` (collect apply): `[ -d incoming/src/i18n ] && cp -r incoming/src/i18n/. src/i18n/ || true`
  and the same for `incoming/i18n-source-stamps/.`
- `I18N-PROPAGATE.yml:261-266` (collect commit): `git add src/i18n i18n-source-stamps` … `for i in 1 2 3 4 5; do` /
  `git pull --rebase origin "${{ github.head_ref || github.ref_name }}" || true` / `git push origin HEAD:… && exit 0`
- `I18N-PROPAGATE.yml:161-163` (pivot push loop): same `git pull --rebase … || true` then `git push`
- `i18n-check.yml` `on.pull_request.paths` contains `'scripts/i18n-*'` (matches `scripts/i18n-propagate-apply.mjs`
  and `scripts/i18n-propagate-apply.test.mjs`; `*` does not cross `/`, both files sit directly in `scripts/`).
- `scripts/ci/pr-gate/__tests__/lib.test.mjs:1-4`: `node:test` + `node:assert/strict`, run with `node --test`.

Evidence, run 38443615525 (head `998b8b0aa`, created 18:03Z): fan-out jobs started 20:16Z–21:55Z; `collect` started
23:13Z, checked out `2f5c0cb` (pushed 22:59Z), rebase "Current branch … is up to date", pushed `2f5c0cb..6b698ac`.
Anything committed to a non-DE locale between a fan-out checkout and `collect`'s checkout is lost; this run's window was
about three hours. Secondary: `:162` and `:265` run `git pull --rebase … || true`, hiding a conflicting rebase.

## Fix (one lane `fix-workflow`, executor claude — `.github/**` is a governance path)

1. `vitana-v1:scripts/i18n-propagate-apply.mjs` (new): key-level 3-way merge per locale file:
   `merge(base = file at the fan-out's start SHA, bot = fan-out output, ours = current branch)`. Per leaf: bot unchanged
   → ours; ours unchanged → bot (key adds/deletes included); both changed → ours, plus `::warning::` with
   locale/file/key. File scope (R1-F3): the script walks only the files present in a locale's bot artifact. A file
   only on the branch (e.g. a shard a human added after the base SHA) is never read or written; the script never
   deletes a file; a shard deleted on the branch is not recreated; a locale with no artifact (its fan-out job failed
   before upload) is skipped with a `::warning::`. Same rules for stamp files.
   Determinism (R1-F2): the script is a pure function of (base blobs read by SHA, artifact dir, working tree). It
   parses and merges every file of a locale in memory first and writes only when that locale fully succeeded, so a
   failure leaves the locale's files untouched. It keeps no state between invocations; warnings go to stdout of the
   invocation that produced them, prefixed with the attempt number. Keeps the existing serialisation
   (2-space pretty for shards, one line for stamps, trailing newline) so untouched keys produce no diff. Missing
   `base_sha.txt` or unparsable JSON → exit 1, nothing written for that locale.
   Why key-level, not `git apply --3way`: adjacent JSON lines conflict in a line merge; parsed keys do not.
   Why human wins: a later human edit is a decision; a skipped bot value is re-translated on the next run because the
   stamp check flags it.
2. `vitana-v1:.github/workflows/I18N-PROPAGATE.yml`: fan-out records `base_sha.txt` (`git rev-parse HEAD` after
   checkout) into its artifact; `collect` uses `fetch-depth: 0`, downloads artifacts to `$RUNNER_TEMP/incoming`
   (outside the working tree), replaces the `cp -r` step with the script, and its push loop becomes, per attempt
   1..5: `git fetch origin <ref>` → `git reset --hard origin/<ref>` → `git clean -fd -- src/i18n i18n-source-stamps`
   → script → `git add` → commit if changed → push. Every attempt starts from a clean tree at the then-current remote
   head, so nothing (files, commits, warnings) carries over from a failed attempt; the log of the attempt that pushed
   is authoritative. After 5 failed attempts → `::error::` and exit 1 (red). The script exiting 1 is not retried
   (input error, fail loud). `pivot` gets the same shape: per attempt 1..5 `git pull --rebase` and, if it fails,
   `git rebase --abort` and back off (never `|| true`); push; after 5 failed attempts → `::error::` and exit 1. Pivot
   keeps rebase (not the 3-way script) because it writes only `en/` + `en.json` within minutes of its own checkout, and
   a conflicting rebase now goes red instead of being hidden. Header comment updated.
3. `vitana-v1:.github/workflows/i18n-check.yml`: one step `node --test scripts/i18n-propagate-apply.test.mjs`
   (the script path already matches its `scripts/i18n-*` filter).

## Test plan

- `vitana-v1:scripts/i18n-propagate-apply.test.mjs` (`node --test` + `node:assert/strict`, the pattern of
  `scripts/ci/pr-gate/__tests__/lib.test.mjs`; each scenario builds its own fixture git repo under `os.tmpdir()` so
  base blobs are read by SHA):
  a. replay of #1399 — human translation after base + bot change to other keys → both kept;
  b. same key changed by both → human kept, one warning;
  c. bot add / delete / new shard → applied;
  d. shard deleted by human → not recreated;
  e. compact stamp file merged key-wise, stays one line;
  f. untouched keys byte-identical; second run is a no-op;
  g. artifact without `base_sha.txt` → exit 1, nothing written;
  h. human adds a brand-new shard after the base SHA, bot artifact has no such file → file byte-identical (R1-F3);
  i. a locale with no artifact at all → its files untouched, one warning;
  j. one file of a locale unparsable → exit 1 and no file of that locale written (no partial write, R1-F2);
  k. retry shape: run, then move "ours" on (new human commit), reset, run again → result equals a single run on the
     new head; no warning from the first run reappears (R1-F2).
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
