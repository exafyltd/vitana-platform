---
change_class: standard
---
# plan(land-guard): enforce pipeline step order in code (evidence → commit, review on current head, checks done → merge, closing records → release)
Author: Kiro, seat `exafyltd`, session `kiro-exafyltd-202610261510-099d` (Kiro Web). Repo `exafyltd/vitana-platform`.
Premises pinned to `origin/main` `3d3b4e6f17`.
<!-- plan:begin -->
## 1. Goal
Owner, 2026-10-28: *"Fix sequencing as a general execution rule. Parallelize independent work only. Evidence must exist
before its commit; review must target the current head; required checks must finish before merge; required closing
records must finish before releasing claims and heartbeats. Enforce these dependencies in the orchestration where
possible, rather than relying solely on steering text."*

## 2. Today
Observed in plans `kiro-web-steering` and `owner-autonomy` (sessions of 2026-10-26/27, recorded in their lane logs):
dependent tool calls ran in parallel. One lane commit was pushed before its evidence pack was written. A check loop read
a head file that did not exist yet. Claims and the driver heartbeat were released while two closing records had not
merged. The steps were recovered by hand.
In the repo, the order is only text: `.kiro/pipeline/driver.md:69` (step 6 "Land an accepted lane … every check run
green, up to date") and `:81` (step 9 "Done … heartbeat ref removed as the last action");
`.kiro/pipeline/common-rules.md:19` (rule 4, merge authority) and `:65` (rule 11, parallel execution). The merge is a raw
`gh api -X PUT …/merge`. `scripts/collab/queue.mjs:893` `release()` frees a claim whatever state the lane is in.
`queue.mjs` is a protected gate file, so it is not changed here.
Open plan #4392 (`kiro-web-reliability`) owns `scripts/collab/kiro-web-session.mjs`, `AGENTS.md`, `.kiro/pipeline/driver.md`
and `preflight.mjs`. This plan touches none of them.

## 3. Change — one lane `land-guard` (vitana-platform)
New `scripts/collab/land-guard.mjs` (Node ≥ 20, ESM, no dependencies, pure decision functions exported). Every command
exits 0 only when the step may run, 1 when it may not (the reason is printed), and 2 while checks are still pending.
1. `evidence --repo <dir> --vtid <VTID>`: `docs/validation/<VTID>/` must hold `acceptance.md`, `commands.log` and
   `scope.json`, each committed or staged (`git ls-files` ∪ `git diff --cached --name-only`). Run it before a lane
   code commit.
2. `review --gh <owner/repo> --pr <n> --reviewed-head <sha>`: the PR head must equal the reviewed head, or every
   commit after it must change only `.kiro/specs/<slug>/lanes/<lane>.md` (an entry-only commit, collaboration.md §3).
   Data comes from `gh api …/compare/<reviewed>...<head>`.
3. `checks --gh <owner/repo> --sha <sha> [--wait <sec>]`: takes the latest attempt of each check run name. Any
   conclusion other than success / skipped / neutral → 1. Any still running → poll every 60 s up to `--wait`, then 2. No
   check runs at all → 2, never pass.
4. `merge --gh <owner/repo> --pr <n> --reviewed-head <sha> --title <t> [--wait <sec>]`: runs 2, then 3 on the PR head,
   then requires `behind_by == 0` against the base, and only then sends `PUT …/merge` with `sha = <head>` (squash). Any
   failure means no merge call.
5. `release --repo <dir> --slug <s> --lane <l|_plan> --session <id>` and `release-heartbeat --repo <dir> --slug <s>`:
   these read the files on `origin/main` after a fetch. A lane claim is freed only when the lane's `state` is `done` or
   `parked`. `_plan` and the heartbeat are freed only when `handoff.md` is `done` or `parked` and every lane file is
   `done` or `parked`. When allowed, `release` runs `queue.mjs release` and `release-heartbeat` deletes
   `refs/heads/collab-driver/<slug>`.
Runbook: `.kiro/pipeline/common-rules.md` gets rule 13 "Step order (enforced)". It lists the four dependencies, says
that independent steps may run in parallel and dependent steps never do (one tool call waits for the previous result),
and says that merges and releases in a Kiro session go through `land-guard.mjs`, not a raw merge call or
`queue.mjs release`. No other runbook changes.
Lane: `executor: kiro`, `reviewer_seat: agent:vitana-lane-reviewer`; paths `scripts/collab/land-guard.mjs`,
`scripts/collab/land-guard.test.mjs`, `.kiro/pipeline/common-rules.md`, `docs/validation/VTID-*/**`. `scripts/collab/**`
is a governance path (`queue.mjs:85`) and none of these files is protected.

## 4. Tests (`scripts/collab/land-guard.test.mjs`, written first, red on base)
Unit tests of the pure functions: evidence missing / present (staged or committed); entry-only vs a code commit after
the reviewed head; head equal to reviewed; checks latest-attempt selection (a failed attempt 1 followed by a successful
attempt 2 passes, a successful attempt 1 followed by a failed attempt 2 fails), pending → 2, empty → 2; merge decision
refuses when behind > 0; release refused for `executing` / `verified`, allowed for `done` / `parked`; `_plan` refused
while one lane is not done. CLI test with a fixture git repo: `release` on a `verified` lane exits 1 and the claim ref is
unchanged. Run: `node --test scripts/collab/*.test.mjs` (PR-GATE).

## 5. Unchanged
`queue.mjs`, every protected gate file, `driver.md`, the session kit, CI workflows and every stop condition. The §7b
merge rule is unchanged; the guard only checks it mechanically. Deploys nothing.

## 6. Risks
A session can still call `gh api …/merge` directly. The session-kit PreToolUse guard (#4392's file) is where to block
that, so it is listed as a follow-up for that plan, not built here.
<!-- plan:end -->
