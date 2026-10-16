# Design — I18N-PROPAGATE stale-write fix

All paths are in **exafyltd/vitana-v1** unless prefixed. Line numbers refer to vitana-v1 `origin/main` `5c4632ea9`.

## Root cause (verified read-only)

`.github/workflows/I18N-PROPAGATE.yml`:

- Fan-out jobs check out the branch head **at the moment each job starts** (`:181`) and upload the **whole locale
  directory** plus its stamp file (`:220-223`).
- `collect` checks out the branch head **at the moment it starts** (`:232`), then copies every artifact file over the
  tree with `cp -r incoming/src/i18n/. src/i18n/` (`:245-246`).
- Anything committed to a non-DE locale between a fan-out job's checkout and `collect`'s checkout is overwritten by that
  job's older snapshot. The commit is then made against the fresh head (`:261-263`), so `git pull --rebase` (`:265`)
  sees nothing to merge and the revert is pushed cleanly.

Run 38443615525 (triggered 18:03Z on `998b8b0aa`): fan-out jobs started 20:16Z–21:55Z; `collect` started 23:13Z, checked
out `2f5c0cb` (pushed 22:59Z) and pushed `2f5c0cb..6b698ac` with "Current branch … is up to date" — the overwrite came
from the copy, not from a rebase. The workflow header's "one writer, no race" (`:22-27`) holds for pushes between bot
jobs, not for the bot versus humans.

Secondary: `pivot` (`:162`) and `collect` (`:265`) run `git pull --rebase … || true`; a conflicting rebase is ignored and
the loop pushes from a half-rebased state or fails five times without saying why.

## Decisions

**D1 — Key-level 3-way merge, not `git apply --3way`.** Locale shards are pretty-printed JSON; neighbouring keys sit on
adjacent lines, and git's line merge treats adjacent edits as conflicts. A key-level merge over parsed JSON has no
adjacency problem and is unit-testable without a translator.

**D2 — Human wins a true conflict.** When the branch and the fan-out both changed a key, the branch value is a later
human decision; the stamp check then reports the key stale if its source moved, and the next run re-translates it.
Never silently losing a human edit is the requirement; a delayed bot translation is acceptable.

**D3 — Fan-out records its base.** Each fan-out job writes `base_sha.txt` (`git rev-parse HEAD` right after checkout)
into its artifact. `collect` reads base files with `git show <base_sha>:<path>`, so it needs `fetch-depth: 0`.

**D4 — Logic in `scripts/i18n-propagate-apply.mjs`.** The name matches `i18n check`'s `scripts/i18n-*` trigger.
Interface:
`node scripts/i18n-propagate-apply.mjs --incoming <dir> [--repo .]` — for every `incoming/i18n-<locale>/` with
`base_sha.txt`, merge each file under `src/i18n/<locale>/` and `i18n-source-stamps/<locale>.json` as
`merge(base, bot, ours)`, write results, print a summary and `::warning::` lines for conflicts; exit non-zero on an
artifact without `base_sha.txt` or a JSON parse error (fail loud, write nothing for that locale).

Merge per leaf path (objects recurse, including `_pending_review`; arrays and scalars are leaves):
| base vs bot | base vs ours | result |
|---|---|---|
| equal | any | ours |
| differ | equal | bot (incl. add / delete) |
| differ | differ, ours == bot | ours |
| differ | differ, ours != bot | ours + warning |

File level: missing in ours but present in base → stays deleted (1.5). Missing in base and ours, present in bot → created.
Key order: ours' order, new keys appended in bot's order. Serialisation: detect from ours (or bot for new files) —
single-line → `JSON.stringify(x)`, else `JSON.stringify(x, null, 2)`; always a trailing `\n`.

**D5 — Retry by recomputing, not rebasing.** `collect`'s push loop: `git fetch origin <ref>` → `git reset --hard
origin/<ref>` → run the script → `git add` → commit → push; up to 5 attempts, then red. Pivot keeps its rebase (single
job, short window, git's own 3-way) but replaces `|| true` with `|| { git rebase --abort; continue; }` so a conflict is
retried from a clean state and reported.

**D6 — Tests.** `scripts/i18n-propagate-apply.test.mjs` (`node --test`, same style as
`scripts/ci/pr-gate/__tests__/*.test.mjs`) builds a temporary git repo. A new step in `.github/workflows/i18n-check.yml`
runs it; the file is already covered by that workflow's `scripts/i18n-*` path filter.

## Not changed

Matrix, provider, drift gate, stamping, `translate-keys.mjs`, concurrency group. No deployed code changes, so there is
no staging deploy and no Gate 2 (done = merged with green checks).
