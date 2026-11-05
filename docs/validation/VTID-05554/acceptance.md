Change types: Tooling/docs.

# Acceptance — VTID-05554 (agentic-delivery / lane `reseat`)

Outcome: the eight lanes of plan agentic-delivery (`prerequisites`, `pipelines`, `deploy-path`, `verify-on-gitlab`,
`merge-queue`, `github-bridge`, `gateway-delivery`, `cutover`) belong to seat `exafy` again, as plan §9 says. The
Project Manager had moved them to the exceptions seat `exafyltd` in #4688 (`945755f084`). After this lands, the plan
driver's builders of seat `exafy` can merge `main` into their lane branches and keep Lane scope green; the open lane PRs
#4689 and #4690 keep their work. Nothing deploys.

AC-1: Each of the eight target lane files changes only `seat: exafyltd` → `seat: exafy`. Every other byte stays the
same: `state`, `next_actor`, `depends_on`, `executor`, `reviewer_seat`, `paths`, `vtid`, `updated`, `claimed_by` and
every log line (`git diff --numstat` is `1 1` per file; the head bytes equal the base bytes with only that line changed).
TEST: `bash docs/validation/VTID-05554/outputs/target-diff-check.sh origin/main HEAD` → `outputs/target-diff-check.txt`
(PENDING-C2).

AC-2: Collab handoff passes for this PR through the `lane_admin` path. The commit with `Collab-Lane:
agentic-delivery/reseat` edits eight other lanes' files; `validateRange` lets that through only because
`laneAdminCovers` (`scripts/collab/queue.mjs:1062`) reads the reseat lane's trusted front matter (the merge-base,
`lane_admin: true`, `executor: kiro`, `reviewer_seat: agent:vitana-lane-reviewer`) and its `paths` list each target
(`queue.mjs:873`).
TEST: `node scripts/collab/queue.mjs validate --repo . --base origin/main --head HEAD --branch kiro/agentic-delivery/reseat`
→ `outputs/validate.txt` (PENDING-C2).

AC-3: Lane scope passes for lane `agentic-delivery/reseat`: the reseat lane file is edited only by this seat `exafy`
session, its permission fields (`executor`, `seat`, `reviewer_seat`, `paths`) and `lane_admin` are unchanged, and every
changed file is inside the lane's spec folder or its evidence folder.
TEST: `node scripts/collab/queue.mjs scope-check --repo . --base origin/main --head HEAD --branch kiro/agentic-delivery/reseat`
→ `outputs/scope-check.txt` (PENDING-C2).

AC-4: Negative proof: the same seat edit from a lane without `lane_admin` is refused. N1: lane reseat with `lane_admin`
removed from its trusted base makes the eight edits → Collab handoff refuses all eight (exit 1). N2: lane prerequisites
(no `lane_admin`) changes its own seat under its own key, as #4690's builder would → Lane scope refuses with 2 problems
("seat changed in a lane PR" and "(seat exafy) edits lane …, which belongs to seat exafyltd", exit 1).
TEST: `bash docs/validation/VTID-05554/outputs/negative-proof.sh <origin/main> <session>` → `outputs/negative-proof.txt`
(N1: Lane scope ✅ exit 0, Collab handoff ❌ 8 problems exit 1; N2: Lane scope ❌ 2 problems exit 1, Collab handoff ✅).

AC-5: Positive proof: this PR's tree squashed onto origin/main (as GitHub would) and merged into the head of #4690
(`18a10349d8`), with the lane-file conflict resolved as #4690's builder would, passes Lane scope for that lane's
builder commits `75f26daa17` and `18a10349d8` (session `kiro-exafy-202611050324-2956`, seat `exafy`). Control: the
same trial merge of today's origin/main (no reseat) fails Lane scope on exactly those two commits.
TEST: `bash docs/validation/VTID-05554/outputs/positive-proof.sh control …` → `outputs/red-on-base.txt` (❌ 2 problems,
exit 1); `positive-proof.sh lane … <this PR's head>` → `outputs/green.txt` (PENDING-C2).

AC-6: The collab enforcement suite stays green (this lane changes no code).
TEST: `node --test scripts/collab/queue.test.mjs` → `outputs/queue.test.txt` (78 tests, 78 pass, 0 fail).

AC-7: Preflight (every CI governance check of the PR) passes on the lane head.
TEST: `node scripts/collab/preflight.mjs --repo . --base origin/main --head HEAD --branch kiro/agentic-delivery/reseat
--title "<PR title>"` → `outputs/preflight.txt` (PENDING-C2).

AC-8: The open PRs that touch the eight target lane files are listed (task S1): #4689 (`github-bridge.md`) and #4690
(`prerequisites.md`), both `in-review` on their branches with seat `exafy` there and a merge-base where the seat was
still `exafy`.
TEST: REST `gh api …/pulls?state=open` and `…/pulls/<n>/files` over all 121 open PRs → `outputs/open-prs.txt`.

States:
- A target lane `ready` on `main` (all eight are `ready` there today): only the seat line changes; a builder of seat
  `exafy` that branched before this lands merges `main` cleanly on that line (`seat:` is line 7; a lane branch changes
  `state:` on line 3 and the lines from `updated:` on, so the hunks do not touch).
- A target `in-review` on its own branch with a claim held (#4690, #4689): `main`'s copy differs from the branch's
  merge-base by the seat line (restored to the merge-base value) and by #4688's `updated:` and log lines. Merging `main`
  conflicts only on #4688's lines; the seat line merges cleanly to `exafy` (AC-5 shows the resolution and the result).
- The same edit from a lane without `lane_admin`: refused (AC-4).

Surfaces: PR-GATE Collab handoff (`queue.mjs validate`) and Lane scope (`queue.mjs scope-check`) for this PR and for the
later lane PRs of this plan; the Project Manager's reassign rule `reassignDecision`
(`services/gateway/src/services/project-manager/decide.ts:227-283`), which reads the lane's seat (`decide.ts:248`,
`:255`) and, with a live driver heartbeat, waits 24 h (`REASSIGN_AFTER_MS`, `decide.ts:242`) before moving a `ready`
lane again.

Locales: n/a (developer-facing). Accessibility: n/a.

Contract:
- This PR's diff: the eight target lane files, one line each (`seat:`); this lane's own file `lanes/reseat.md` (front
  matter `state`, `claimed_by`, `branch`, `updated`, later `pr`, and appended log entries); `docs/validation/VTID-05554/**`.
  No governance path, protected gate file, code or migration. `lane_admin` is not edited, and `lanes/reseat.md` is not
  in its own `paths` (`lanes/reseat.md:12-20` list the eight targets only; `lane_admin: true` at `lanes/reseat.md:10`).
- Checker side: `validateRange` cross-lane-file exemption `scripts/collab/queue.mjs:873` → `laneAdminCovers`
  `queue.mjs:1062` → `fetchTrustedLaneFm` `queue.mjs:1044` (merge-base first, never the PR head). `scopeCheck`: own
  spec folder and evidence `queue.mjs:991`, permission fields pinned to the trusted revision `queue.mjs:969`, `:987`,
  seat rule `queue.mjs:1015-1016`.
- Seat names: `exafy` is a seat of `docs/programs/areas.yaml:18` (checked by `validateRegistry` in Collab handoff).

Staging proof: not verified on staging: this PR deploys nothing (lane files and evidence only;
`node scripts/ci/staging-verify/run.mjs check-pr` → `outputs/check-pr.txt`, PENDING-C2), so there is no
`staging-tests.json`. Covered by AC-2 to AC-5 (Collab handoff and Lane scope on this PR, the negative proof and the
trial merge into #4690's head).

Red on base: no new test; the lane changes no code. Its base-versus-lane pair is the trial merge into #4690: with
today's origin/main (no reseat) Lane scope fails, 2 problems, exit 1 (`outputs/red-on-base.txt`).
Green: with this lane, the same trial merge passes Lane scope (`outputs/green.txt`, PENDING-C2); `queue.test.mjs` 78/78.

Decisions taken:
1. `scope.json` uses `kind: feature`, the builder protocol's template (the change is Tooling/docs; `kind` only gates
   the red→green check, for `fix`). It lists this lane's own file `lanes/reseat.md` next to the eight targets and the
   evidence folder, as the sibling lanes do (VTID-05551, VTID-05548); the lane file's own `paths` is not edited.
2. The negative proof has two variants because the two checks split the work. N1 is refused by Collab handoff, not by
   Lane scope: Lane scope treats every file under the lane's own spec folder as the lane's own (`queue.mjs:991`), and
   the targets share that folder. N2, the target lane changing its own seat, is refused by Lane scope. Only the
   `lane_admin` path passes both.
3. Scratch work ran in detached worktrees under `/projects/sandbox/.scratch/reseat/` (a scratch branch without a ref),
   never pushed, each removed after its run. N2 and the trial merges carry the #4690 builder's session id
   `kiro-exafy-202611050324-2956` in local commits only, to model that session's own commits.
4. The trial-merge conflict in `lanes/prerequisites.md` is resolved as the lane brief says: #4690's front matter with
   the merged seat (git's 3-way result: #4690 never changed its seat, so `main`'s side wins), log = `main`-side entries,
   then #4690's entries, each once. The conflict comes from #4688's `updated:` and log lines, not from this lane.
5. The eight targets keep their `updated:` value and get no log entry (S2 lists `updated` and every log line among the
   bytes that stay the same). The record of the reseat is this lane's log, this PR and this evidence.
6. Locally, `validate` and `scope-check` ran without `--plan-repo` (`gh pr list` does not work in this sandbox). Every
   lane file they judge here has a merge-base copy, which comes first in the trusted source chain, so the plan-PR
   source is never consulted.
7. Local checks ran on Node 22.23.4 (the sandbox's Node); CI runs the same commands on Node 20.
