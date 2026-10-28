---
change_class: standard
---
# plan(kiro-web-reliability): one-command Kiro Web bootstrap, race-free commit/push checks, VALIDATOR-CHECK in preflight, parallel lane builders
Author: Kiro, seat `exafy`, session `kiro-exafy-202610271051-d636` (Kiro Web). Repo: `exafyltd/vitana-platform` only.
Premises pinned to `origin/main` `6e0dfca618`. Sparring: the first create (`087401c4-…`) never produced round 1 (run `40492189091`, infra, see plan `plan-spar-stuck-session`); session `52ba3de1-…` escalated at the round cap (round 3, two new findings, both accepted here); this text is the re-plan. Its first create (`10cf5341-…`, run `40509170990`) again produced no round 1 within 25 min
(infra, the same failure `plan-spar-stuck-session` VTID-05350 fixes); this line is the only change since. Follows `kiro-web-parity` (VTID-05340, #4389) and `kiro-web-steering`
(VTID-05339, #4379). Detail: `tasks.md`; lane files `lanes/preflight-validator.md`, `lanes/session-reliability.md`.
<!-- plan:begin -->
## 1. Goal
Owner, 2026-10-27 (Kiro Web): *"Please finish the remaining reliability gaps"*: (1) every new sandbox and session loads
the rules and runs the required setup without being asked; (2) *"Add the PR-description declaration and evidence-folder
checks to the local preflight"*; (3) the concurrent edit-and-commit race must be blocked; (4) *"dependent actions are
sequenced—for example, a commit must complete before its push begins. Continue to run independent work in parallel"*;
(5) fix the stale hook description; (6) *"Determine whether independent writing lanes can run in parallel … Implement a
supported approach if possible"*. No gate is loosened.

## 2. Today
Repository (`6e0dfca618`):
1. `scripts/collab/kiro-web-session.mjs:95` — the generated guard hook's description says "a kiro/<slug>/<lane>
   branch" while `:42` (`LANE_BRANCH`) matches every `kiro/**` and `claude/**` branch.
2. `scripts/collab/kiro-web-session.mjs:449` — the PreToolUse guard blocks `git commit … && git push …` in one command
   ("run `git commit` and `git push` as separate commands"), because a PreToolUse check runs before the commit exists.
   Separate tool calls are what let dependent calls be issued in one parallel batch.
3. The commit typecheck is a PreToolUse check (`kiro-web-session.mjs:359` `checkCommit`): it judges the working tree at the
   moment the hook runs, before `git add` executes.
4. `scripts/collab/preflight.mjs:6-7,55` — options `--repo --base --head --branch --title --plan-repo --no-tests
   --json`; no PR body. `:203` reports what preflight does not run.
5. `.github/workflows/VALIDATOR-CHECK.yml:4-38` runs on PRs touching `services/gateway/{src,dist,openapi,test}/**` or
   `docs/validation/**`; its job `validate-pr` (`:40-345`) has steps `Load ruleset` (`:51`), `Collect PR text` (`:56`),
   `Require PR body declarations` (`:66`, `validator-path-guard.cjs --pr-body-check`, `scripts/ci/validator-path-guard.cjs:462-466`),
   `Extract VTID + Validation Profile` (`:88`, id `meta`), `Compute changed files` (`:129`), `Enforce Path Ownership
   Guard` (`:143`), `Evidence Pack Gate` (`:163`: dir, `acceptance.md`, `commands.log`, `outputs/`), `Acceptance
   Mapping Gate` (`:173`), `CSP Governance Gate` (`:199`), `Build Gate` (`:274`), `Route Mount Evidence Gate` (`:292`),
   `OASIS Traceability Gate` (`:324`), `Merge Deploy Gate` (`:334`), `PASS summary` (`:342`). Steps read
   `${{ github.base_ref }}`, `${{ github.event.pull_request.title|body }}`, `${{ steps.meta.outputs.VTID|PROFILE }}`,
   `$GITHUB_OUTPUT` and fixed paths under `/tmp/`.
6. `.kiro/pipeline/driver.md:5` — "It needs no subagents and no parallel workers"; `:64` builds a `ready` lane in this
   session. `.claude/rules/collaboration.md` §8a.1-2: lanes run in parallel by default, at most 6 build lanes per plan;
   §3: one session id per lane, trailers per commit; §5: claim before touching a lane.
7. `AGENTS.md:16-24` — the Kiro Web section tells a session to run only `kiro-web-steering.mjs`.
8. `scripts/codeintel/session-setup.sh:227-232,281,300` already installs git hooks (Graphify, RepoWise post-commit) into each
   checkout's `.git/hooks`, untracked.
Observed in Kiro Web (probes in `docs/validation/VTID-05340/probes.md`, plus this session):
9. Auto-injected into every session: `vitana-platform/AGENTS.md` (shown to this session as a workspace rule) and the
   account learnings. Not loaded: the repos' `.kiro/steering`, `.kiro/hooks`, `.claude/settings.json`. Workspace-root
   `.kiro/` and `~/.cache` do not survive a new sandbox. Configuration Sync holds no user file (`files: {}`).
10. `SessionStart` (command and agent) and `UserPromptSubmit` hooks did not fire for a sub-agent session (probe today).
11. Sub-agents run concurrently (62 s overlap) and inherit the workspace hooks.
12. Race (VTID-05340 P23): a `str_replace` and a `git commit` in one parallel batch committed a seeded type error.
13. The PreToolUse guard parses the bash text (`kiro-web-session.mjs` `segments`/`parseCommand`). This session's first
    plan push (`425a2a68a7`) ran in one command with heredocs whose bodies hold apostrophes; the parser lost the quote
    state, saw no `git push`, and no preflight ran (no pass-cache entry). A check bound to git itself (§3.2.2) does not
    depend on parsing the agent's command; the PreToolUse check stays best-effort.
14. Processes started inside a tool call do not outlive it: a `setsid nohup` loop and a Node `spawn({detached:true})`
    loop both stopped before their first 10 s tick once the call returned, and a `run_in_background` call's loop wrote
    nothing within 70 s (probes today). `setup` without `--wait` starts its installs detached
    (`kiro-web-session.mjs` `main`, `spawn(… {detached: true})`), so those installs do not complete in Kiro Web.
15. A cold bootstrap in the foreground works from zero: fresh `--depth 50` clones of both repos in an empty
    workspace, an empty `HOME`, then `kiro-web-steering.mjs` + `kiro-web-session.mjs setup --wait`: 482 s
    (deps 9 s + 14 s, venv 2 s, indexes 453 s), `status --check` exit 0. `setup … | head -2` crashes with `EPIPE`
    (`kiro-web-session.mjs:548`).

## 3. Lanes (parallel; no shared file; no `depends_on`; interface §3.3)
### 3.1 Lane `preflight-validator` — `scripts/collab/preflight.mjs`, `scripts/collab/preflight.test.mjs`, `docs/validation/VTID-*/**`
1. New option `--body-file <path>` (the PR body). New check `VALIDATOR-CHECK` (label `required` — it is a required
   check on PRs it runs on), only when a changed file (base…head) matches the workflow's `on.pull_request.paths`
   (read from the file, not hard-coded); otherwise `skip` "not in VALIDATOR-CHECK's paths".
2. It runs the workflow's own step scripts, read from the **head** (checked-out) revision of
   `.github/workflows/VALIDATOR-CHECK.yml`, which is what a `pull_request` run executes (neither lane changes that file,
   so base and head are identical for this plan): every step of job `validate-pr` that has a `run:` block, in order, except
   `Build Gate` (`:274-290`): a new platform-side `not-covered` entry "Not run by preflight: VALIDATOR-CHECK Build Gate
   (`npm run build`, and for `command_hub_frontend` the src+dist both-updated check `:282-289`)" is added whenever the
   check applies (the existing `:202-203` entry is v1-only). A `command_hub_frontend` PR can therefore pass preflight
   and still fail that CI step; the README says so.
   Each runs in `bash --noprofile --norc -eo pipefail` (the GitHub Actions default shell) with cwd = `--repo`, env = the step's `env:` with `${{ github.base_ref }}` → the `--base`
   ref's branch name (`main` default), `${{ github.event.pull_request.title }}` → `--title`,
   `${{ github.event.pull_request.body }}` → the body file's text, `${{ steps.<id>.outputs.<K> }}` → values earlier
   steps wrote to their `$GITHUB_OUTPUT` file; every `/tmp/` path in a script is rewritten to the preflight temp dir
   (parallel preflights never share files). The first failing step ends the check; its output (the `REJECTED:` lines)
   is the failure. A step whose script uses another `${{ … }}` expression → the check fails "unsupported expression"
   (never a silent pass).
3. Body source, in order: `--body-file`; else the open PR's body via `gh api` (as the guard already finds the open PR's
   title). No body from either while the check applies → fail "no --body-file: VALIDATOR-CHECK reads the declarations from the PR
   body; on a first push pass PR_BODY_FILE=<file> (see docs/kiro-web-parity/README.md)". Minimal YAML reading without dependencies: job → `steps:` list items → `name`, `id`, `env` map, `run: |`
   block scalar by indentation; a parse failure fails the check.
4. Tests (red on base: the option and check do not exist): body missing a declaration → fail naming it (the real
   `--pr-body-check` message); evidence dir without `outputs/` → fail `missing …/outputs/`; both fixed → pass; a change
   outside the paths → skip; open-PR body fallback when `--body-file` is absent; a failing stage inside a pipeline fails
   the step (pipefail); the workflow is read from the head revision; `/tmp/` rewrite (two runs in parallel do not collide); `${{ github.base_ref }}` and
   `steps.meta.outputs` substitution; unsupported expression → fail; `Build Gate` reported not run.

### 3.2 Lane `session-reliability` — `scripts/collab/kiro-web-session.mjs`, `scripts/collab/kiro-web-session.test.mjs`, `AGENTS.md`, `.kiro/pipeline/driver.md`, `docs/kiro-web-parity/**`, `docs/validation/VTID-*/**`
1. **One-command bootstrap.** `setup` first runs `kiro-web-steering.mjs` (rules), then today's steps, **all in the
   foreground** (§2.14): rules, hooks, dependencies and code intelligence by default (~8 min cold, §2.15; a second run
   takes seconds); `--no-codeintel` skips only the venv and index build. No detached child is started.
   **Stamps:** `setup` first writes `~/.cache/vitana-kiro-web/setup.start` (ISO time), then each step writes its own
   stamp in that folder when it finishes: `steering.done`, `hooks.done` (Kiro hooks + git hooks + reviewer copy),
   `deps-<checkout key>.done` (one per checkout with a lockfile), `codeintel.done` (skipped with `--no-codeintel`,
   which writes `codeintel.skipped`). `status` treats a stamp older than `setup.start` as missing and reports each
   step; `installs` is ok only when every step of the last `setup` has a fresh stamp. Required for `status --check`:
   steering, hooks, git hooks, reviewer agent, gateway deps (codeintel stays non-required, as today). Output survives a closed pipe (no
   `EPIPE` crash); `AGENTS.md`
   (auto-injected, §2.9) is changed to: first action of every Kiro Web session, from the workspace root,
   `node vitana-platform/scripts/collab/kiro-web-session.mjs setup`, then state the first `status` line and the session
   id in the first reply. Kept: the Codex rule (byte-identical) and the steering-generator fallback sentence.
2. **Race-free git hooks.** `setup` installs, per main checkout, `<git common dir>/hooks/pre-commit` and `pre-push`
   carrying the marker line `# generated by vitana-platform/scripts/collab/kiro-web-session.mjs`; an unmarked existing
   file is never overwritten. `status` gets a **required** item `git-hooks`: for every main checkout found by
   `findRepos`, both files exist, are executable and contain the marker line (a missing, unmarked or non-executable
   hook fails it, so `status --check` exits 1). They run
   `kiro-web-session.mjs git-pre-commit` / `git-pre-push <remote> <url>`:
   - `git-pre-commit`: staged files under `services/gateway/src` (`git diff --cached --name-only`) → incremental
     `tsc --noEmit --incremental --tsBuildInfoFile ~/.cache/vitana-kiro-web/tsc/<checkout>.tsbuildinfo` (scoped per
     checkout, as today) in that worktree's `services/gateway`; errors → exit 1 with the first 10 `error TS` lines. It
     runs at commit time, after `git add`, so an edit that lands after the agent's tool call started is still checked.
     **Linked worktrees** (parallel builders, §3.2.4) have no `services/gateway/node_modules`: the hook then runs
     `npm ci --no-audit --no-fund` in that worktree's `services/gateway` first (~5-15 s with the shared npm cache), then
     tsc; an `npm ci` failure does not block (a note; CI typechecks). A symlink to the main checkout's `node_modules` is
     not used: in this session's prototype it made tsc report false `TS2742` portability errors (paths outside the
     worktree).
     tsc reads the working tree, not the index: an unstaged type error under `services/gateway/src` also blocks
     (conservative, never looser); the message then names the unstaged gateway files. Exporting the index to a temp
     tree would need a second `node_modules` and is not done.
   - **First push (no PR yet).** The agent writes the PR body (with the five declarations of
     `.github/pull_request_template.md:39-43`) to a file and pushes with `PR_TITLE='…' PR_BODY_FILE=<file> git push …`;
     both reach `git-pre-push` as environment variables of the `git push` process. `kiro-web-session.mjs pr-body
     --vtid <V> --scope <globs> --acceptance <path> --payload <text> [--profile gateway_backend|command_hub_frontend]
     [--oasis no|yes]` prints a body with all five declarations filled, from the template (defaults `gateway_backend`
     and `no`, the template's own values `.github/pull_request_template.md:39,43`; a `command_hub_frontend` PR passes
     `--profile command_hub_frontend`, and `--oasis yes` needs `OASIS_PROOF:` in acceptance.md as CI requires). Without a PR and without `PR_BODY_FILE`, when VALIDATOR-CHECK applies, the push is blocked naming
     this form.
   - `git-pre-push`: for each stdin line whose remote ref is `refs/heads/<b>` with `b` matching `LANE_BRANCH` and a
     non-zero local sha: the existing push check on that sha (HEAD must equal it; this is the authoritative push check, §2.13), title from `PR_TITLE` (env) or the
     open PR, body from `PR_BODY_FILE` (env) or the open PR's body; `--body-file` is passed when preflight supports it
     (§3.3). Same pass cache as the PreToolUse guard.
   - The PreToolUse commit typecheck and the `mark-dirty` PostToolUse hook are removed (the pre-commit hook replaces
     them; `setup` deletes the stale marked hook file). The PreToolUse push check stays (a visible block before the
     command runs) but **no longer blocks `git commit … && git push …`**: when a commit precedes the push in the same
     command, the PreToolUse guard does **not** call the push check for that push at all (no preflight, no PR/title
     lookup, no pass-cache write) and `pre-push` checks the real commit.
3. **Sequencing rule** in `driver.md` (new short section): a dependent action goes in the **same** bash command as the
   one it depends on, chained with `&&` (commit `&&` push; `worktree add &&` work in it); independent actions are
   separate parallel tool calls; a tool call never shares a batch with the call whose result it needs; after a push,
   `git ls-remote` must show the pushed sha.
4. **Parallel builders** in `driver.md` (replaces `:5` "needs no subagents and no parallel workers" and extends step 5):
   the driver may build up to 6 independent `ready` lanes at once (§8a caps and hot files unchanged) by dispatching one
   builder sub-agent per lane in one batch. Each builder generates its own session id (`queue.mjs session-id --agent
   kiro --seat <lane seat>`), claims its lane, works in `<vitana-platform>/.agents/wt/<lane>`, follows `lane-code.md`,
   pushes, opens its PR and returns `{lane, session, pr, head}`; it never merges, never reviews, never edits
   `handoff.md` or another lane's file. The driver keeps `_plan`, runs the reviewer agent per lane (reviews may also
   run in parallel) and lands one merge at a time. The template prompt is in the section.
5. **Refresh hook.** New generated `vitana-web-refresh.json` (`UserPromptSubmit`, command
   `kiro-web-session.mjs refresh`): regenerates stale workspace steering (`kiro-web-steering.mjs --check` failing),
   rewrites stale generated hooks and git hooks, appends one line to `~/.cache/vitana-kiro-web/refresh.log`, prints one
   line only when it fixed something or the session is not ready, always exits 0. It keeps an already bootstrapped
   sandbox current when `main` moves; whether Kiro Web fires `UserPromptSubmit` for the main session is untested and is
   reported as such.
6. Hook description fixed (§2.1); the `hooks` status message is derived from `hookDefs()` (no hard-coded names). `PR_BODY_FILE` is parsed like `PR_TITLE` (prefix or earlier `export`).
7. Tests (red on base): PreToolUse guard does not invoke the push check for a push after a commit in one command;
   first push with `PR_BODY_FILE` (env) reaches preflight as `--body-file`, without it (VALIDATOR applies) blocked;
   `pr-body` output (defaults, and with `--profile command_hub_frontend --oasis yes`) passes
   `validator-path-guard.cjs --pr-body-check`; `git-pre-commit` from a linked worktree without `node_modules` runs
   `npm ci` there before tsc (and does not block when it fails); an unstaged gateway type error blocks naming
   the file; `status` not ready while a step's stamp is missing or older than `setup.start` (one stamp present, others
   absent → not ready, naming them); `git-hooks` required item fails for a missing / unmarked / non-executable hook;
   the `hooks` message lists exactly the generated hook names; git hooks installed with marker, unmarked hook untouched; `git-pre-commit` with staged gateway
   file + tsc error → exit 1, clean → 0, no gateway file → no tsc; `git-pre-push` stdin parsing, non-lane refs ignored,
   deletion (zero sha) ignored, failing preflight → exit 1, a push whose command text the PreToolUse parser cannot read (heredoc with an apostrophe) is still checked by `pre-push`, `--body-file` passed only when supported; PreToolUse guard
   allows `commit && push`; `refresh` regenerates stale steering and is silent when ready; `setup` runs the steering
   generator; hook description; a real-git race test: a background writer modifies a gateway file after the PreToolUse
   check and before `git add`, and the pre-commit hook still blocks.

Each lane writes only its own `docs/validation/<its VTID>/` folder; the shared glob `docs/validation/VTID-*/**` in
both lane files is the allowlist form every parallel plan uses (e.g. `pipeline-speed`, three parallel lanes with that
glob), and the reviewer agent checks the folder is the lane's own. No file is edited by both lanes.

### 3.3 Interface between the lanes
`preflight.mjs --body-file <path>`: lane `session-reliability` passes it only when the preflight source on disk
contains `'body-file'`. Either lane can merge first: when `preflight-validator` merges first, the existing PreToolUse
push check (no `--body-file`) still passes for a branch with an open PR, because preflight then reads that PR's body
(§3.1.3); a first push before the PR exists fails VALIDATOR-CHECK with the message naming `PR_BODY_FILE` until
`session-reliability` lands — **so the driver merges `session-reliability` first** and `preflight-validator` second
(one merge at a time anyway); neither lane `depends_on` the other for building.

## 4. Validation (owner items)
- (1) A simulated fresh sandbox (§2.15 method) with the new single `setup` (+ `--codeintel`); `status --check` exit 0, timings recorded. What is automatic vs instruction-driven is documented (§2.9-10).
- (2) Preflight run on a branch with a body missing declarations and an evidence dir without `outputs/` → both caught
  before push; fixed → pass.
- (3) The P23 race reproduced: (a) deterministic, a writer that edits after the PreToolUse check; (b) real parallel
  batches. Blocked by `pre-commit`.
- (4) `commit && push` in one command → pre-push preflight checks the new sha; `ls-remote` equals it.
- (6) This plan's two lanes are built by two builder sub-agents in parallel; timestamps recorded.

## 5. Unchanged
`CLAUDE.md`, `.claude/**`, `.kiro/steering/**`, `.kiro/hooks/**`, protected gate files, `VALIDATOR-CHECK.yml`, PR-GATE,
the merge rule §7b (one merge at a time), reviewer independence, every stop case. Deploys nothing: done when merged.

## 6. Risks
- Running workflow step scripts locally: they are read-only checks (`test`, `grep`, `git diff`, `git fetch`); `Build
  Gate` is excluded; scripts run with `bash -e` in the temp dir rewrite. A CI-only expression fails loudly.
- Git hooks could block a legitimate commit/push: only a real tsc/preflight failure exits 1; an internal error exits 0
  with a note. `--no-verify` stays forbidden (`common-rules.md` 8).
- Parallel builders share one object store: push races are retried (`common-rules.md` 8); lanes with a shared or hot
  file are never dispatched together.
<!-- plan:end -->
