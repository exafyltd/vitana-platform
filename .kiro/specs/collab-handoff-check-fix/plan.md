---
change_class: standard
---
# Plan — collab-handoff-check-fix
Make the PR-GATE **Collab handoff** check pass on correct PRs again, say why it failed in the job log, and stop it
from spawning one git process per commit.
<!-- plan:begin -->
## Problem
Read-only diagnosis 2026-10-28 (`exafyltd/vitana-platform` `origin/main` @ `28aaab2331`; `scripts/collab/queue.mjs` is
unchanged since `bfcfddc1db`, where the errors were reproduced from each PR head's own `queue.mjs`):
- **R1 — every CI-sparred `plan(` PR fails "one session per lane".** `validateRange` counts every commit's
  `Collab-Session` per `Collab-Lane` (`queue.mjs:570`, `if (k.lane && k.session !== PM_AGENT)`) and reports more than one
  at `:595`. PLAN-SPAR's commits carry `Collab-Session: ci-plan-spar` and `Collab-Lane: <slug>/_plan`
  (collaboration.md §9), so a plan PR that PLAN-SPAR has sparred always shows two sessions on `_plan`. Only `pm-agent`
  is exempt. The same validator already treats `ci-plan-spar` as legitimate inside a plan PR: the plan-file transition
  (`:553`, `ciSparred`) and the VTID write into a `ready` lane (`:588`). Every recently merged plan PR has a red Collab
  handoff (#4415, #4413, #4406, #4405, #4404, #4393); on #4415 this is the only error. Open plan PRs that are red for
  this alone: #4243, #4348.
- **R4 — specs not in any programme.** `validateRegistry` (`:843-847`) fails a PR whose touched spec is not listed by a
  `docs/programs/<id>/program.md`. Listed by no programme on `main`: `native-wave2-events-calendar`,
  `native-wave2-home-feed-news`, `native-wave2-sharing-business`, `native-wave2-profile-settings`,
  `desktop-spotlight-finish`, `i18n-propagate-stale-write`, `sparring-floor-retry` (#4373 is red for this alone). Of
  these, only `native-wave2-home-feed-news`, `desktop-spotlight-finish` and `sparring-floor-retry` have a spec folder on
  `main`; the others exist only on the heads of their open `plan(` PRs (#4271, #4349, #4278, #4157). The other open `native-wave2-*`
  plan PRs (#4269, #4270, #4272, #4275, #4276, #4322, #4332, #4430) are not listed either and fail the same way once
  their own R1 error is gone.
- **Silent failure.** With `--summary` (how PR-GATE.yml:142 runs it), `validate` writes the whole report only to the
  step summary (`:988`, `if (args.summary) appendFileSync(...) else console.log(out)`), so the job log shows only
  "exit code 1". `scope-check` does the same at `:1003`.
- **Spawns per commit.** `commitsInRange` (`:497`) runs one `git diff-tree` per commit; `pmAgentOverreach`
  (`:506-509`, called at `:580` and `:675`) and `frontMatterChanged` (`:521-524`) run two `git show` per commit and
  lane file; the `_plan` / `ci-plan-spar` checks at `:586` and `:588-589` one more each. On the `pm-agent/*` loop PRs
  (8,118 commits on #4333) that is about 25k process spawns: about 10 s on the Linux runner and more than 5 min on
  Windows. `catFileBatch` (`:282`, one `git cat-file --batch` for many objects, VTID-05300) is not used here.

`scripts/collab/queue.mjs` is a **protected gate file** (`scripts/collab/protected-gate-files.json`, collaboration.md
§3a). Its lane never merges on a reviewer-agent accept alone: the merge also needs a legacy `claude` review on the
current head or the owner's instruction naming this plan (§7b). That is the one owner/Claude stop in this plan.

## Changes
### Lane `validator-fix` — `scripts/collab/queue.mjs` (+ tests)
1. **R1.** In `validateRange`'s session map (`:570`), skip a commit whose `Collab-Session` is `ci-plan-spar` (the
   `CI_PLAN_SPAR` constant, `:66`) **only when its `Collab-Lane` is `<slug>/_plan`**. Nothing else about `ci-plan-spar`
   changes: what it may write is still checked file by file (`:553` plan transition, `:588` VTID write into a `ready`
   lane; any other lane-file edit still fails at `:591`). A `ci-plan-spar` commit naming a work lane still counts as a
   session there. A second human/agent session on `_plan` still fails.
2. **Silent failure.** `validate` and `scope-check` with `--summary` also print the status line, the problem list and
   the warnings (not the queue table) to stderr, each problem as a GitHub annotation line
   `::error::collab handoff: <problem>` (`::error::lane scope: <problem>`), warnings as `::warning::`. Without
   `--summary` the stdout output is unchanged. The exit code is unchanged.
3. **Batching.**
   - `commitsInRange` reads trailers and changed files in **one** `git log --no-merges --name-only
     --format=%x1e<fields> <base>..<head>` (record separator first, so each record is the header line followed by its
     file lines). The returned objects are the same `{sha, session, lane, review, verdict, reviewer, reviewedHead,
     files}`; `files` equals today's `diff-tree --no-commit-id --name-only -r <sha>` for every non-merge commit.
   - Every per-commit file read in `validateRange` (`:580` `pmAgentOverreach`, `:586` `_plan` creates a lane, `:589`
     CI VTID write, `:590` `frontMatterChanged`) and in `scopeCheck` (`:675`) goes through one `catFileBatch` per call
     of `validateRange` / `scopeCheck`: the needed `<sha>^:<path>` and `<sha>:<path>` queries are collected first, read
     in one process, and looked up from the Map (values `trimEnd()`ed, missing = `null`, the same as `showFile`).
     `pmAgentOverreach(repo, sha, p)` and `frontMatterChanged(repo, sha, p)` take the text from that Map instead of
     calling `showFile`.
   - Result: the number of git processes `validateRange` and `scopeCheck` start does not depend on the number of
     commits in the range (it still grows with the number of spec files touched, as today). Errors and warnings are
     byte-identical to today's for the same range, except R1.
4. Out of the change: the "`sparring_record` required in state `parked`" rule for plans parked from `drafted`
   (`:200`, #4317) — a separate plan; `pm-agent` writer bugs (plan `pm-reassign-idempotent`, PR #4396).

### Lane `program-registry` — `docs/programs/*/program.md` (+ test)
5. List the specs in their programmes:
   - `native-app` (`docs/programs/native-app/program.md`): every `vitana-platform:native-wave2-*` spec on `main` or with
     an open `plan(` PR when the lane is built — at least `native-wave2-events-calendar`, `native-wave2-home-feed-news`,
     `native-wave2-sharing-business`, `native-wave2-profile-settings`, plus `-inbox-chat-calls`, `-journey-autopilot`,
     `-health-biology`, `-public-auth-onboarding`, `-discover-commerce`, `-memory-diary`, `-wallet`, `-ai-pages`.
   - `desktop-redesign`: `vitana-platform:desktop-spotlight-finish` (and `vitana-platform` added to its `repos`).
   - `standalone`: `vitana-platform:i18n-propagate-stale-write`, `vitana-platform:sparring-floor-retry`.
   A spec already listed by another programme on `main` at build time is left where it is (one programme per spec,
   `validatePrograms`). **Slugs are taken from the trees, never typed from this list:** for a spec not on `main`, the
   builder reads the folder name from the open PR head (`git ls-tree -d --name-only <pr-head> .kiro/specs/`) and
   records each slug with its source (`main` or `#<pr> <head sha>`) in `docs/validation/<VTID>/commands.log`.
6. Test `scripts/collab/program-registry.test.mjs`: `loadPrograms(<repo root>, 'HEAD')` maps each spec above to the
   programme named here, each added slug matches the spec slug pattern (`/^[a-z0-9][a-z0-9-]*$/`) and is listed exactly
   once across all programmes, and `validatePrograms` returns `[]`.

## Shared files, dependencies, order
- No file is edited by both lanes. `docs/programs/standalone/program.md` is also changed by this plan PR (it lists
  `collab-handoff-check-fix`) and by plan PR #4396 (`pm-reassign-idempotent`): whichever lands later rebases, no
  semantic overlap.
- `depends_on: []` for both lanes; they run in parallel.
- Each lane's own Collab handoff check runs the PR head's `queue.mjs` (PR-GATE.yml:142). Until `validator-fix` is on
  `main`, the plan PR and `program-registry` PR are red on R1 only; that is the known false positive the §7b
  `--admin` clause names, linked in the lane log.

## Tests (red on base, green on head)
`node --test scripts/collab/*.test.mjs` (PR-GATE "Collab tests").
- `queue.test.mjs` — R1: a fixture plan PR with a planner commit (`kiro-…`, `<slug>/_plan`, new `drafted` plan + a
  `ready` lane) and a `ci-plan-spar` commit (`<slug>/_plan`, `drafted → approved`, `vtid` written into the `ready`
  lane) → `validateRange(...).errors` is `[]` (base: "commits from 2 sessions"). Negative cases stay red: a second
  `kiro-…` session on `_plan`; a `ci-plan-spar` commit that edits a lane's `paths`.
- `queue.test.mjs` — silent: `node queue.mjs validate --summary <tmp>` on a fixture with one error → exit 1, stderr
  contains `::error::collab handoff:` and the error text, the summary file holds the full report (base: stderr empty).
  Same for `scope-check`.
- `queue.test.mjs` — batching: fixtures with 3 and with 30 `pm-agent` lane-state commits (and review / `_plan` /
  `ci-plan-spar` commits) → `gitSpawns` for `validateRange` and for `scopeCheck` are equal for both sizes (base: grows
  by ≥ 3 per commit); errors/warnings equal a reference copy of today's implementation kept in the test
  (`validateRangeReference`), including an overreaching `pm-agent` commit and a rewritten log.
- `program-registry.test.mjs` — as in item 6 (base: the specs are not listed).
- Local evidence in `docs/validation/<VTID>/commands.log`: `validate` on the heads of #4415 (R1 only → green) and
  #4333 (8,118 commits) with wall-clock time before/after. No staging deploy: these files deploy nothing, so there is
  no STAGING-VERIFY and no Gate 2; each lane is done when merged with green checks.

## Lanes
- `validator-fix`: executor **claude** (governance path, protected gate file), seat `exafy` (area `platform`), reviewer
  agent; while Claude is unavailable it is built by the exceptions seat `exafyltd`. Paths:
  `scripts/collab/queue.mjs`, `scripts/collab/queue.test.mjs`, `docs/validation/VTID-*/**`. Merge needs a legacy
  `claude` review on the current head or the owner's instruction (§3a).
- `program-registry`: executor **kiro**, seat `exafy`, `reviewer_seat: agent:vitana-lane-reviewer` (its test is under
  the governance path `scripts/collab/**`, not a protected file). Paths: `docs/programs/native-app/program.md`,
  `docs/programs/desktop-redesign/program.md`, `docs/programs/standalone/program.md`,
  `scripts/collab/program-registry.test.mjs`, `docs/validation/VTID-*/**`.
<!-- plan:end -->
