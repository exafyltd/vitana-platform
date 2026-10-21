---
change_class: standard
---
# plan(kaf-fallback-env): the staging Project Manager sees Kiro-fallback mode (fix-forward of kiro-autonomy-fallback, VTID-05277)
Author: Kiro, seat `exafyltd`, session `kiro-exafyltd-202610202314-cfd9` (pipeline run `wf_f16f7c2bcc131c71`). Repo
`exafyltd/vitana-platform` only. Premises pinned to `origin/main` `49007cf73` (= the commit STAGING-VERIFY run
39510333485 failed on). Fix-forward of the approved plan `.kiro/specs/kiro-autonomy-fallback/` (lane `staging-proof`,
VTID-05277); that plan is not edited. Detail per lane: `tasks.md`; lane files: `lanes/*.md`.
<!-- plan:begin -->
## 1. Goal
Owner, 2026-10-20 (pipeline task, verbatim): *"Problem: the staging Project Manager never sees fallback mode. Repo
variable CLAUDE_AVAILABLE=false is set on exafyltd/vitana-platform, but GET /api/v1/project-manager/mode returns
executor_mode claude_primary and /status shows claude.available true."* Fix in the repo only (no live credential, IAM
or manual task-definition change): (1) `variable()` distinguishes "unreadable" from "unset" so `observeClaude` falls
back to `process.env.CLAUDE_AVAILABLE`, the 4 h no-activity rule still applies, with tests that fail on `origin/main`;
(2) `AWS-STAGE-DEPLOY-GATEWAY.yml` upserts `CLAUDE_AVAILABLE` into the staging task definition from
`${{ vars.CLAUDE_AVAILABLE }}` in the jq block that sets `PM_AGENT_ENABLED`/`PM_MODE`, default `'true'` when empty,
never production; (3) `docs/validation/VTID-05277/staging-tests.json` (`/mode` == `kiro_fallback`) passes on
STAGING-VERIFY.

Why a new slug and not new lanes in `kiro-autonomy-fallback`: that plan is `approved` with a converged sparring
session; a lane added there takes PLAN-SPAR's `allocate_retry` path (`scripts/collab/plan-spar.mjs:279-287`), which
allocates without a sparring round, and `handoff.md` cannot go back to `drafted` (collaboration.md §2 transitions).
Plan sparring is never skipped (CLAUDE.md rule 51), so this fix-forward is its own sparred plan.

## 2. Today (verified, file:line on 49007cf73)
- PM loop: `loop.ts:89` builds `new GithubObserver({ gh: new GithubRestReader(), data: new SupabasePmDataReader() })`
  with no `env`; `GithubObserverDeps` declares `env?: NodeJS.ProcessEnv` (`observe-live.ts:94`) and `observe()` resolves
  `const env = this.deps.env ?? process.env;` each tick (`observe-live.ts:286`), then passes it to `observeClaude`
  (`:481`). So on the live path `env.CLAUDE_AVAILABLE` is the task-definition variable.
- `observeClaude` (`observe-live.ts:563-591`): `:568` reads the repo variable; the env fallback (`:569-571`) runs only
  in `catch`. `:572-590` compute the 4 h inputs (`oldest_assigned_at`, `last_action_at`) whatever the flag is.
- `GithubRestReader.variable` (`observe-live.ts:697-700`) returns `r.data?.value ?? null`. `gh()`
  (`github-rest.ts:41`) returns `{status:404, data:null}` on 404 without throwing; every other non-2xx throws
  `GithubHttpError` (`github-rest.ts:42-46`), a missing token throws (`:22-23`).
- So a 404 resolves `null` → `parseFlag(undefined)` = `null` and the env is never read. GitHub answers 404 on
  `actions/variables/<name>` both for "not set" and for "this token has no Variables access"; the variable is set
  (`gh variable get` = `false`), so the PM token's read is a 404 for lack of access (inferred: the token's permission
  was not read live). The interface already promises a throw (`observe-live.ts:73` "throws when it cannot be read");
  the REST reader breaks it on 404.
- Even where the read throws (403, no token), `CLAUDE_AVAILABLE` is not in the staging task definition: the strip list
  ends `"PM_AGENT_ENABLED","PM_MODE") | not) ]` (`AWS-STAGE-DEPLOY-GATEWAY.yml:1193`), the upserts are
  `{name:"PM_AGENT_ENABLED", value:"true"}` / `{name:"PM_MODE", value:"live"}` (`:1220-1221`), step `taskdef`
  (`:457-458`), env block `:459-494`, jq call `NEW_DEF=` `:1136`, last jq arg `--arg TASK_ROLE "$TASK_ROLE_ARN" '`
  (`:1154`). `AWS-PROD-DEPLOY-GATEWAY.yml` has no `CLAUDE_AVAILABLE` and only swaps the image.
- Both causes are needed: (1) alone helps only once the env exists; (2) alone helps only a 403.
- `claudeAvailability` (`decide.ts:73-82`): only `flag === false` gives `flag_false`; `null`/`true` fall to the 4 h
  rule, which ignores `true`. It did not fire on staging (newest `Collab-Session: session_…` commit 2026-10-16T06:06Z
  is later than the oldest open `next_actor: claude` item), so the flag is the only trigger.
- Tests: `test/project-manager/observe-live.test.ts:179-186` covers a reader that throws; no test exercises
  `GithubRestReader` or `gh()` with `fetch`, and no test pins the PM env block of the staging workflow.

Premises the plan stands on (each one a file read on the base ref; session 1 escalated with
`evidence_floor_not_met`, 0 premise checks, so they are listed for direct checking):
- P1 `services/gateway/src/services/project-manager/observe-live.ts:563-591` — env fallback only inside `catch`.
- P2 `services/gateway/src/services/project-manager/observe-live.ts:697-700` — `variable()` returns `null` on a 404.
- P3 `services/gateway/src/services/project-manager/github-rest.ts:41-46` — `gh()` 404 → `{status:404,data:null}`,
  other non-2xx throw.
- P4 `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml:1193` and `:1220-1221` — strip list and upserts without
  `CLAUDE_AVAILABLE`.
- P5 `services/gateway/src/services/project-manager/decide.ts:73-82` — only `flag === false` gives `flag_false`.
- P6 `services/gateway/src/types/cicd.ts:1338-1342` — `.github/workflows/` is a sensitive path for PM safe-merge.

## 3. Semantics (unchanged from kiro-autonomy-fallback plan §3, now implemented as written)
`GithubReader.variable(repo, name)`: resolves the string on a 200 with a string `value`; resolves `null` only when a
reader can prove "unset"; **throws** when unreadable — a REST 404 (unset or no access, indistinguishable) or a 200
without a string `value` counts as unreadable. `observeClaude` precedence: (a) variable read and parses to
`true`/`false` → that; (b) the read threw, or returned `null`/unparseable → `parseFlag(env.CLAUDE_AVAILABLE)`;
(c) else `null`. The 4 h inputs are computed exactly as today. `decide.ts` is not changed. Only the literal `false`
means unavailable; `true`, unset or unreadable = no override.

Staging env: `CLAUDE_AVAILABLE` = `${{ vars.CLAUDE_AVAILABLE || 'true' }}`, captured at deploy time. A readable repo
variable still wins live; when it is unreadable, a later flip of the repo variable reaches the PM only at the next
staging deploy (documented, staging only).

## 4. Interfaces between lanes
- None in code. `ff-pm-flag` reads `process.env.CLAUDE_AVAILABLE` (name exact, values `true`/`false`); `ff-stage-env`
  sets exactly that name in the staging task-definition env. Neither lane imports the other's files.
- Merge order (not a `depends_on`, both build in parallel): `ff-stage-env` first, then `ff-pm-flag`, so the
  `ff-pm-flag` deploy already carries the env and its STAGING-VERIFY can prove `/mode`. Enforcement: the land step
  merges in the order recorded in the pipeline run's `run.json` `merge_order` under one `merge.lock`. If the order still
  slips, nothing is re-run and nothing is loosened: the STAGING-VERIFY that counts for `/mode` is the one on the merge
  commit of whichever lane lands **second** (it contains both changes and its deploy carries the env); the earlier
  run's `/mode` failure is expected and reported in Gate 2.

## 5. Lanes (two; no two lanes edit the same file; no depends_on)
Two lanes, not one, because the Project Manager's safe-merge refuses `.github/workflows/**` (SENSITIVE_PATHS,
`types/cicd.ts:1338-1342` via `evaluateGovernance`, `github-service.ts:728-733`): one PR with both changes could never
be PM-merged, which owner item (3) asks for.

### A. `ff-stage-env` — `CLAUDE_AVAILABLE` in the staging task definition (governance path, not protected)
Files: `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml`,
`services/gateway/test/kaf-staging-claude-available-wiring.test.ts` (new), `docs/validation/<VTID>/**`.
- Step `taskdef` `env:` (after `:494`, outside `run:`): `CLAUDE_AVAILABLE_VALUE: ${{ vars.CLAUDE_AVAILABLE || 'true' }}`.
- jq args: `--arg CLAUDE_AVAILABLE "$CLAUDE_AVAILABLE_VALUE" \` inserted **before** `--arg TASK_ROLE … '` (`:1154`
  stays the last arg; the apostrophe guard in `test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts`
  locates the jq program by it).
- Strip list `:1193`: `"PM_AGENT_ENABLED","PM_MODE","CLAUDE_AVAILABLE") | not) ]`.
- Upsert on the `:1221` line: `{name:"PM_MODE", value:"live"}, {name:"CLAUDE_AVAILABLE", value:$CLAUDE_AVAILABLE},`.
- No comment and no apostrophe inside the jq program; any explanation goes above the step, outside `run:`.
- Size cap: the `taskdef` `run:` block is 19,726 chars against the 20,000 cap of the bash-syntax test (274 headroom);
  the edit adds about 110. Never raise the cap.
- New test (red on base): the staging step env has the `vars.CLAUDE_AVAILABLE || 'true'` line; the jq call has the
  `--arg CLAUDE_AVAILABLE`, placed before `--arg TASK_ROLE`; the strip list contains `"CLAUDE_AVAILABLE"`; the upsert
  `{name:"CLAUDE_AVAILABLE", value:$CLAUDE_AVAILABLE}` appears exactly once; `AWS-PROD-DEPLOY-GATEWAY.yml` contains no
  `CLAUDE_AVAILABLE` (guard, green on base). Pattern: `test/vtid-05127-phone-verify-switch-wiring.test.ts:13-23`.
- Staging suite `docs/validation/<VTID>/staging-tests.json`: `/alive` 200 and the wiring test as `existing` (no `/mode`
  check here: until `ff-pm-flag` lands, a 404 still hides the env).
- Merged by the land step (PM refuses workflow files); reviewer agent accept on the current head + every check green.

### B. `ff-pm-flag` — unreadable variable falls back to the env (PM code, not protected)
Files: `services/gateway/src/services/project-manager/observe-live.ts`,
`services/gateway/test/project-manager/observe-live.test.ts`, `docs/validation/<VTID>/**`.
- `GithubRestReader.variable` (`:697-700`): return the value only on a 200 with a string `value`; otherwise throw
  `GithubHttpError` (exported at `github-rest.ts:14`) with a message naming the status ("variable unreadable (404:
  unset or no access)"). `gh()` is not changed (`file`, `refDate`, `pullMergeable` rely on 404 → null).
- `observeClaude` (`:566-571`): precedence of §3 (`?? envFlag` after a successful read; env in `catch`). `:572-590`
  unchanged. Update the contract comment `:73` and the header line `:17`.
- `governance.ts`, `decide.ts`, `github-rest.ts`, `loop.ts`, `types.ts`, routes: unchanged.
- New tests (in `observe-live.test.ts`, `jest.spyOn(global, 'fetch')`, `GITHUB_SAFE_MERGE_TOKEN` set and restored in
  `afterEach`): (B1) `new GithubRestReader().variable` rejects on 404 — red on base; (B2) resolves `'false'` on 200
  `{value:'false'}`; (B3) rejects on 403; (B4) `GithubObserver` whose `variable` is the real `GithubRestReader.variable`
  over a 404 fetch with `env:{CLAUDE_AVAILABLE:'false'}` → `claude.flag === false` — red on base; (B5) same with env
  `'true'` → `true`, env `{}` → `null`; (B6) readable `'true'` + env `'false'` → `true` (variable wins); (B7) 4 h rule
  kept: 404 + env `'true'` + a `next_actor: claude` lane updated > 4 h before `NOW` and no `session_` commit after it →
  `claudeAvailability(s.claude, NOW)` = `{available:false, reason:'no_action_4h'}`.
- Staging suite `docs/validation/<VTID>/staging-tests.json`: `/alive` 200, `/api/v1/project-manager/mode` →
  `{"ok":true,"enabled":true,"mode":"live","executor_mode":"kiro_fallback"}` (the same read-only check as
  VTID-05277), `/status` with a bad bearer → 401, and `npx jest test/project-manager/observe-live.test.ts` as `existing`.
- PR title: `VTID-<lane VTID> (kaf-fallback-env/ff-pm-flag): …`, body names VTID-05277 as the suite it repairs.

## 6. Parallel, shared files, hot files
Both lanes build in parallel (no shared file, no import). One merge at a time (`merge.lock`), each brought up to date
with latest `main` and green on that head; merge order §4. One staging deploy at a time (workflow concurrency group
`AWS-STAGE-DEPLOY-GATEWAY.yml:103-105`). Hot files (collaboration.md §8a): none. Open PRs #4033 and #3963 touch the
same jq block; not edited here; whichever lands second reconciles its own conflict.

## 7. Merge authority
Owner instruction 2026-10-20 (collaboration.md §7b), named set = every PR of pipeline run `wf_f16f7c2bcc131c71`:
merge to `main` + staging auto-deploy without asking; no `--admin` over a real red test, build or STAGING-VERIFY;
production stays owner PUBLISH only. Protected gate files touched: none (neither file is in
`scripts/collab/protected-gate-files.json`); `.github/**` is a governance path, so `ff-stage-env` carries
`reviewer_seat: agent:vitana-lane-reviewer`. `ff-pm-flag` gets a Project Manager merge attempt first; if the PM has not
merged within 30 min of the PR being green with an accept on its head, the land step merges under the instruction and
records the finding. Expected: the PM verifies/merges only lanes whose state on `main` is `in-review`/`verified`
(`decide.ts:150,209`), and lane state moves on the lane PR branch, so the PM is not expected to act; the finding goes to
Gate 2.

## 8. Tests and commands (from `services/gateway`; `npm ci` first in a fresh worktree)
- `npx jest test/project-manager test/kaf-staging-claude-available-wiring.test.ts test/kiro-autonomy-fallback-proof.test.ts test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts test/vtid-05127-phone-verify-switch-wiring.test.ts`
- `npm run typecheck`, `npm run lint`, `npm run build`.
- Red on base: each new test run against `origin/main` sources; output in `docs/validation/<VTID>/outputs/red-on-base.txt`
  and `green-head.txt`, every command with pass/fail counts in `commands.log`, `acceptance.md` with `TEST:`/`CURL:` lines
  (Evidence Pack Gate, `VALIDATOR-CHECK.yml:142`).
- `bash -n` in the bash-syntax test needs bash on PATH (Git Bash on Windows); CI is the authority.
- `node scripts/collab/queue.mjs validate --base origin/main --head HEAD` green before each push.
- STAGING-VERIFY (`STAGING-VERIFY.yml`) on the merge commit of the second lane to land (normally `ff-pm-flag`, §4): the VTID-05277 suite and this plan's
  suites pass. Read-only GETs and Jest only; nothing targets production.

## 9. Measurement
`docs/validation/<plan VTID>/timings.json` (`vitana.plan-timings/v1`, collaboration.md §8b; plan VTID = the first lane
VTID CI allocates): convergence, VTID allocation, per-lane build / review / merge, staging verify, approved → verified,
merge-conflict count, STAGING-VERIFY failure count; `null` where a source is missing.

## 10. Risks
1. VTID-05082 (another plan, `sanitizeSvgMarkup`) is red on every gateway STAGING-VERIFY in the prod..HEAD range; the
   run stays failed overall even with VTID-05277 green. Report per suite; do not loosen 05082; Gate 2 states it.
2. Run-block size cap (274 chars headroom); exceeding it fails every staging deploy. The bash-syntax test measures it.
3. `/mode` reflects the lease holder's last tick; after the rolling deploy the new task must take the lease and tick
   (~2 min). One attempt-1 infra re-run of STAGING-VERIFY is allowed (§7a).
4. Treating 404 as unreadable sends a truly unset variable to the env; with the workflow default `'true'` the result is
   "available", as today — no silent switch into fallback.
5. If the PM token gets Variables read access later, the variable wins live and the env becomes a no-op.
6. The intermediate STAGING-VERIFY after the first lane merges still fails VTID-05277 (`/mode`); the verdict that
   counts is the one on the second lane's merge commit (normally `ff-pm-flag`, §4).

## 11. Unchanged
`AWS-PROD-DEPLOY-GATEWAY.yml` and every `AWS-PROD-*` file; `decide.ts`, `governance.ts`, `github-rest.ts`, `loop.ts`,
`types.ts`, `routes/project-manager.ts`; `docs/validation/VTID-05277/staging-tests.json`; the spec
`.kiro/specs/kiro-autonomy-fallback/**`; the repo variable `CLAUDE_AVAILABLE`; IAM, tokens and the live task
definition (changed only by the staging deploy workflow); no migration.
<!-- plan:end -->
