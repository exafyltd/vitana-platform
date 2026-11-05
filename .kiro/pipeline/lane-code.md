# Lane coder

Binding: `common-rules.md`. RUN = `<vitana-platform>/.agents/tasks/pipeline-<run id>/`. The step is told its slot
number N (1-6). LANE = `RUN/slots.json` `slots.N` (null → nothing to do). WT = `<vitana-platform>/.worktrees/<slug>-<LANE>`
(and `<vitana-v1>/.worktrees/<slug>-<LANE>-v1` for a lane in vitana-v1); BRANCH = `kiro/<slug>/<LANE>`; spec on
`origin/main`: `.kiro/specs/<slug>/` (`lanes/<LANE>.md`, `tasks.md`, `plan.md`; read with `git -C <repo> show
origin/main:<path>`).

## Lane state
`RUN/lanes/<LANE>/state.json`: `{"status":"pending|in_review|changes_requested|accepted|ci_failed|needs_update|landed|parked|skipped",
"done":false,"vtid","title","seat","reviewer":"agent:vitana-lane-reviewer","executor","depends_on","paths","repos",
"branch","worktree","pr_urls","head_sha","v1_head_sha","review_rounds","ci_fix_attempts","merge_conflicts",
"last_verdict","merge_shas","merged_by","notes"}`. Only this lane's coder and land steps write it; other lanes' state
files are read-only. Only the land step sets `done`.

## Decide by status
- No lane in the slot, missing state, `done` true, or `in_review` / `accepted` / `landed` / `parked` / `skipped` →
  change nothing; final message `lane <LANE>: nothing to do (<status>)`.
- `pending`: no VTID → `parked` (never hand-allocate; the next PLAN-SPAR run retries allocation). A `depends_on` lane
  parked → `parked`. A `depends_on` lane not landed → poll its state every 3 min up to 150 min; still not landed →
  end `waiting`. All landed → **implement**.
- `changes_requested`: `review_rounds` already 3 → `parked` (findings to `blockers.md`). Else fetch BRANCH (the land
  step committed the review entry on top), fast-forward WT, read the verdict JSON + entry in `RUN/reviews/`, fix every
  blocking finding (common rule 5), re-verify, update `impl-notes.md`, commit, run preflight (step 7), fix every
  error, then push, `head_sha`, `review_rounds`+1, status `in_review`; timing `lane_fix_pushed`.
- `ci_failed`: `ci_fix_attempts` already 3 → `parked`. Else read `RUN/lanes/<LANE>/ci-failure.md` and
  `gh run view <id> --log-failed`, fix within the lane's paths, re-verify, commit, run preflight (step 7), fix every
  error, then push, `ci_fix_attempts`+1, status `in_review`. A red that `main` itself has on the same test is not the lane's: stay `accepted`, wait for `main`.
- `needs_update`: merge `origin/main` into BRANCH in WT (merge commit, never rebase or force), resolve within the
  lane's paths, re-verify, run preflight (step 7), fix every error, then push, `head_sha`, status `in_review`.

## Implement
1. Session id = `RUN/run.json` `seats[<lane seat>]`; missing → `queue.mjs session-id --agent kiro --seat <seat>`,
   kept in state `notes`.
2. Claim: `node <vitana-platform>/scripts/collab/queue.mjs claim <slug>/<LANE> --session <id> --repo <repo>`
   (collaboration.md §5); retry 3× on races. Held by another live session → `parked` with the holder named.
3. `git -C <vitana-platform> worktree add <WT> -b <BRANCH> origin/main` (base on `origin/<BRANCH>` if it exists;
   reuse an existing WT; a half-created WT that cannot be removed → use `<WT>2` and log it).
4. Context: RepoWise / Graphify where available, else targeted reads; start from `RUN/investigate/`. The merged spec
   wins over any investigation.
5. **Red → green.** Write each new behaviour's test first, run it on the base (`origin/main`) and record the failure in
   `docs/validation/<VTID>/` (`red-on-base.txt`), then implement and record the pass.
6. Implement exactly the lane file + `tasks.md` + `plan.md`, only within the lane's `paths` (plus
   `docs/validation/<VTID>/**` and the lane file's own log). Append a log entry to the lane file (claim, session,
   what changed) and set its front matter `state: executing`, `claimed_by`, `branch`, `pr`, `updated` (`queue.mjs
   validate` compares base and head, so `ready → executing` is the lane PR's change; later states come from the
   Project Manager's writes and the review entry, collaboration.md §2). Log every
   protected gate file the lane changes in `decisions.md`. Hot files only if the lane owns them.
7. Verify locally until green and record every command with pass/fail counts in `docs/validation/<VTID>/commands.log`
   and `RUN/lanes/<LANE>/impl-notes.md`. **Governance checks: one preflight run** after the last commit, in WT
   (`node <vitana-platform>/scripts/collab/preflight.mjs --repo <WT> --base origin/main --head HEAD --branch <BRANCH>
   --title "<PR title>"`; a vitana-v1 lane passes its v1 WT as `--repo`): it runs the Collab tests, `queue.mjs validate` (head copy), Lane scope (base copy of
   `queue.mjs`), the PR-GATE `gate.mjs` checks and Kiro steering together and prints every failure at once; fix every
   error, re-run until it passes, keep its output in `commands.log`. Then the area checks: gateway → in
   `services/gateway` (`npm ci` if `node_modules` is missing) `npx jest <changed tests>`, `npm run typecheck`,
   `npm run build` (+ `npm run test:operator` / `test:support` / `test:roles` when their area is touched); frontend →
   `npm test`, `npm run lint`, `npm run build`; workflow YAML → parse each file; Kiro files → `node --test
   scripts/ci/kiro-steering/guard.test.cjs` and `node scripts/ci/kiro-steering/guard.cjs .`. On Windows compare any red
   against the same command on base before calling it the lane's. Then the build and evidence items of
   `quality-checks.md` for every change type the lane touches (UI screenshots, contract, kept defaults, sibling
   sweep, test quality), each recorded in `commands.log`.
8. A deploying lane (touches a path a staging deploy workflow watches) ships
   `docs/validation/<VTID>/staging-tests.json`: read-only (GET or a rejected probe), staging only, never production.
   It asserts the changed outcome where a read-only path exists ("Staging proof" in `quality-checks.md`), not only
   that the page or route exists.
9. Commit with the trailers and bot identity, run preflight (step 7) on that commit, fix every error, then push
   (protocol), open the PR (base `main`, ready when local checks are
   green; title `VTID-NNNNN (<slug>/<LANE>): <lane title>`), body: summary, tests + counts, red → green proof,
   verification (what was observed where, or "not verified on staging: <reason>", `quality-checks.md`), paths,
   `Review: agent:vitana-lane-reviewer (claude-sonnet-5.5)`, session id, merge authority (collaboration.md §7b). A lane
   spanning both repos opens one PR per repo with the same VTID.
10. State: status `in_review`, `branch`, `worktree`, `pr_urls`, `head_sha` (+ `v1_head_sha`). Timings `lane_started`,
    `lane_pr_opened`.

Final message: lane, action (implemented / fixed / waiting / nothing / parked), head SHA, PR URL(s), verification
summary.
