# Plan — Kiro writes to exafyltd/vitana-v1 (push, open PR, merge)

<!-- plan:begin -->
## Goal
Owner request 2026-10-09: "We need pushing to vitana-v1 too … we need both repos at any time."
Today Kiro (Command Hub Operator, Kiro engine, VTID-05005/05006) can read both repos (runner mirrors
`vitana-platform` and `vitana-v1`, `services/kiro-runner/src/repo-mirrors.ts:19-21`) but can write only
to vitana-platform. Make the three code-write tools work for both repos, with the same gates.

Change class: **standard** (routes, GitHub write path, governance deny-lists).

## What pins writes to vitana-platform today (verified)
1. `services/gateway/src/services/kiro/kiro-push-branch.ts:15` `KIRO_PUSH_REPOS = ['exafyltd/vitana-platform']`;
   `defaultGitHubCall` uses `GITHUB_SAFE_MERGE_TOKEN` for every repo (`:68-70`).
2. `services/gateway/src/services/gemini-operator.ts` `executeDevCreatePr` / `executeDevMergePr` hardcode
   `repo: 'exafyltd/vitana-platform'` (~`:5749`, `:5795`); tool definitions `dev_create_pr` / `dev_merge_pr`
   have no `repo` parameter (~`:1125-1150`).
3. `services/gateway/src/routes/cicd.ts`: `/create-pr` always creates on `DEFAULT_REPO` (`:252`) and its
   schema has no `repo`; `/safe-merge` rejects any repo but `DEFAULT_REPO` (`:292-299`).
4. `services/gateway/src/services/github-service.ts`: `getPullRequest`, `getPrFiles`, `getCombinedStatus`,
   `getCheckRuns`, `getPrStatus`, `createPullRequest`, `mergePullRequest`, `evaluateGovernance` take no
   token override, so a vitana-v1 call uses `GITHUB_SAFE_MERGE_TOKEN`.
5. `services/gateway/src/services/kiro/kiro-mcp-writes.ts` `checkTargetVtid` for `dev_merge_pr` reads the PR
   from `exafyltd/vitana-platform` only (~`:111-117`).

## Token
The established vitana-v1 credential in the gateway is `FRONTEND_DEPLOY_TOKEN`
(`gemini-operator.ts:2797-2811` `operatorRepoToken`, `orb/developer/deep-dive.ts:244`,
`operator-bootstrap-pack.ts:260`). Reuse it; no new secret. ONE resolver and ONE
allowlist, in `github-service.ts`: `VITANA_REPOS = ['exafyltd/vitana-platform','exafyltd/vitana-v1']` and
`repoGitHubToken(repo)` (vitana-platform → `undefined`, i.e. the default `GITHUB_SAFE_MERGE_TOKEN`, unchanged;
vitana-v1 → `FRONTEND_DEPLOY_TOKEN`; unset → `repo_token_not_configured`, never a fallback to the platform
token). `gemini-operator.ts`'s `OPERATOR_ALLOWED_REPOS` / `operatorRepoToken` are deleted and import these
instead (same values, same behaviour for the read tools). Every vitana-v1 GitHub call this plan adds —
push (git-data API), create PR, PR status, governance files, merge, the target check and the probe — goes
through this one resolver, so pushes and merges on vitana-v1 always use the same credential. Whether that token has
`contents:write` + `pull_requests:write` on vitana-v1 is NOT known from code; see "Risk" and the probe below.

## Changes
A. `github-service.ts`: add an optional trailing `tokenOverride?: string` to the eight functions in (4),
   passed to `githubRequest` (which already accepts it). Defaults unchanged → every existing caller is
   byte-identical. Add `VITANA_REPOS` and `repoGitHubToken(repo)` (the single resolver above).
B. `cicd.ts` `/create-pr`: optional `repo` in `CreatePrRequestSchema` (default `exafyltd/vitana-platform`),
   allowlisted to `WRITE_REPOS` (403 `unauthorized_repo` otherwise), created on that repo with its token.
   `/safe-merge`: allow `WRITE_REPOS` instead of only `DEFAULT_REPO`; pass the repo's token to
   `getPrStatus`, `evaluateGovernance`, `mergePullRequest`. `next.can_auto_deploy` stays platform-only
   (services/ detection already yields nothing for v1). The existing governance (`BLOCKED_FILE_PATTERNS`,
   `SENSITIVE_PATHS` incl. `.github/workflows/`, `production/`, `prod/`) applies to v1 PRs unchanged —
   wanted. **Other routes stay platform-only on purpose:** `POST /cicd/merge` (Command Hub governed
   merge, `cicd.ts:648`), `POST /autonomous-pr-merge` (Dev Autopilot, `:1477`) and the approvals queue
   (`:912`). Kiro and the Operator merge only through `/safe-merge` (`executeDevMergePr`); widening the
   Command Hub / autopilot merge paths to v1 is a separate decision, not needed for this request.
C. `gemini-operator.ts`: `dev_create_pr` / `dev_merge_pr` get an optional `repo` enum
   (`exafyltd/vitana-platform` default, `exafyltd/vitana-v1`); executors forward it. Same for the
   Operator's own (non-Kiro) use of these tools — default unchanged.
D. `kiro-push-branch.ts`: `KIRO_PUSH_REPOS` gains `exafyltd/vitana-v1`; `defaultGitHubCall` takes the repo
   and uses `repoGitHubToken`. Per-repo deny list on top of the shared one:
   - shared (both): `.github/`, `.claude/`, `CLAUDE.md`, `CODEOWNERS`, `docs/validation/`, package/lock files
     (as today).
   - vitana-platform (as today): `gov/`, `scripts/ci/`, `supabase/migrations/`.
   - vitana-v1: **`supabase/`** (whole tree — `supabase-functions-deploy.yml` deploys
     `supabase/functions/**` to the production Supabase project on every push to main; migrations live
     there too), `AGENTS.md`, `.env*`, `eslint-rules/`, `eslint.config.js`, `eslint-patterns.config.js`
     (the i18n hard rule is enforced there).
   Tool description updated to list both repos and their denied paths.
E. `kiro-mcp-writes.ts` `checkTargetVtid` `dev_merge_pr`: read the PR from `args.repo` (allowlisted) with
   its token. `summarizeWrite` already prints `repo`; add it for create/merge so the Allow card shows
   which repo.
F. Read-only readiness probe: `GET /api/v1/operator/kiro/repos` (requireAdminAuth) returns, per write repo,
   `{ repo, token_configured, can_read, permissions, note }` from `GET /repos/{repo}` with that repo's
   token. `note` states that `permissions` is what GitHub reports for the token's identity and that a
   fine-grained PAT can still lack `contents:write`, so only a real push is definitive. No writes. Lets staging prove the
   v1 token is wired and readable before anyone clicks Allow.

## Unchanged gates (both repos)
`KIRO_MCP_WRITE_ENABLED`; open VTID (in_progress+approved, not terminal); target bound to that VTID
(commit message starts with the VTID, PR title contains it); the user's Allow in the thread; push only to
`kiro/<user8>/<slug>`, fast-forward, never main, never force; safe-merge requires all checks green and
governance (`BLOCKED_FILE_PATTERNS`, `SENSITIVE_PATHS` incl. `.github/workflows/`) to approve.
Merging to vitana-v1 main deploys to **staging only** (`AWS-STAGE-DEPLOY-FRONTEND.yml`; `DEPLOY.yml`'s
`cutover_gate` freezes push → prod); production still needs PUBLISH / Gate 2.

## Risk
- `FRONTEND_DEPLOY_TOKEN` may lack write scopes on vitana-v1. Then the first Allowed push returns GitHub's
  own 403 text ("Resource not accessible by personal access token" — `formatGitHubApiError`) in the
  thread; nothing partial is written (blob/tree creation fails before any ref moves). Fix is an owner
  token-scope change, reported with the probe result at Gate 2.
- Every github-service change is an optional trailing param; existing call sites are untouched.

## Tests
- `test/vtid-05014-kiro-v1-writes.test.ts`: validatePush per-repo deny lists (v1 `supabase/functions/x.ts`,
  `supabase/migrations/…`, `supabase/config.toml`, `supabase/seed.sql`, `AGENTS.md`, `.env.local`, `eslint.config.js` refused; `src/pages/X.tsx` allowed;
  platform rules unchanged); pushKiroBranch on v1 uses the v1 token and never the platform token; missing
  `FRONTEND_DEPLOY_TOKEN` → loud error, no GitHub call; executors forward `repo`; `/create-pr` and
  `/safe-merge` accept v1, reject a third repo, use the right token (github-service mocked);
  checkTargetVtid reads the PR from the right repo; probe route returns per-repo shape and is admin-only.
- Extend `test/vtid-04465-operator-pipeline-regression.test.ts` with one v1 scenario (push → PR → merge
  on vitana-v1 under Allow, fake GitHub).
- Existing suites: vtid-05006, vtid-05005, operator pipeline, cicd tests, role separation.
- Staging (read-only, `docs/validation/VTID-05014/staging-tests.json`): probe route 401 unauthenticated;
  with the admin test session, `GET /api/v1/operator/kiro/repos` lists both repos with
  `token_configured:true, can_read:true`. No push in the automated suite.

## Files in scope
services/gateway/src/services/github-service.ts, src/routes/cicd.ts, src/types/cicd.ts,
src/services/gemini-operator.ts, src/services/kiro/kiro-push-branch.ts, src/services/kiro/kiro-mcp-writes.ts,
src/routes/operator-kiro-mcp.ts or src/routes/operator.ts (probe route), new test file, the operator
pipeline regression test, generated pins/indexes if a guard requires them, docs/validation/VTID-05014/*.
No migration, no workflow change, no Command Hub UI change.
<!-- plan:end -->


## Planner responses — round 1
- F1 [major] duplicate resolver — ACCEPTED. One resolver + one allowlist in `github-service.ts`
  (`VITANA_REPOS`, `repoGitHubToken`); `OPERATOR_ALLOWED_REPOS`/`operatorRepoToken` in
  gemini-operator are removed and import them. (Kept in github-service, not gemini-operator, so
  kiro-push-branch/cicd do not import the 15k-line operator module.)
- F2 [major] other DEFAULT_REPO routes — ACCEPTED (scoped). Plan now states `/cicd/merge`,
  `/autonomous-pr-merge` and the approvals queue stay platform-only on purpose; Kiro/Operator merge
  only via `/safe-merge`.
- F3 [major] split token — ACCEPTED (clarified). Every v1 call in this plan (push, PR, status,
  governance, merge, target check, probe) goes through the one resolver → `FRONTEND_DEPLOY_TOKEN`.
  Q1: whether `GITHUB_SAFE_MERGE_TOKEN` (`vitana/github/pat`) can write v1 cannot be learned from the
  code; the repo's established convention for every v1 call is `FRONTEND_DEPLOY_TOKEN`
  (`gemini-operator.ts:2799`, `deep-dive.ts:244`, `operator-bootstrap-pack.ts:260`), so the plan follows
  it. The probe reports it on staging.
- F4 [minor] — ACCEPTED: tests add `supabase/config.toml` and `supabase/seed.sql`.
- F5 [minor] — ACCEPTED: plan states governance patterns apply to v1 PRs, as wanted.
- F6 [minor] — ACCEPTED: probe response carries a `note`; plan says only a real push is definitive.
- F7 [minor] — ACCEPTED: covered by F1 (single allowlist).
- Q3: `VITANA_REPOS` in repo-mirrors.ts is the full runner list (both repos). The mirrors are
  anonymous public clones (no token); write access only ever goes through the gateway.

## Partner round 2
F1–F7 closed. New: F8 [minor] other read-only FRONTEND_DEPLOY_TOKEN resolvers (deep-dive.ts:244,
operator-bootstrap-pack.ts:260, testing.ts:144/306) remain — DEFERRED as a cleanup follow-up (read-only
callers, out of scope). Verdict: CONVERGED.

## Record
- Plan hash (sha256 of the text between the plan markers): `d02381b85586ddd6eae74a9c05670d2fdefc0536e6608c5cd84543fee5f9f9d6`
- Partner: plan-sparring-partner, 2 rounds. Verdict: **CONVERGED**.
- Approval: owner "yes built it" in the Claude Code session, 2026-10-09. VTID-05014 allocated after approval.
