# Sparring round 3 — escalated

Session: `52ba3de1-35fb-4b65-877b-c9ab716852ff` · plan hash `93ace55bedcb2d553980e0e8f6a7aa2a96a0e8cc1027348255d4744fd6722d83`

## Summary

Round 3 review. All three round-2 findings were ACCEPTED (none rejected/deferred); I verified each accepted fix is actually present in the revised plan (git-hooks required status item §3.2.2; per-step stamps enumerated §3.2.1; hooks message derived from hookDefs() §3.2.6), so none need re-raising. The earlier R1 findings are also substantively addressed by the revision. I raise two new findings: (1) the parallel-builder worktrees (§3.2.4) have no services/gateway/node_modules, and installScript only installs deps for main checkouts (findRepos excludes linked worktrees), so the pre-commit tsc gate (§3.2.2) will false-block any gateway commit made from a builder worktree; (2) the `pr-body` helper's specified arguments cannot produce a PR body that passes the five-marker `--pr-body-check` it is itself tested against, because VALIDATION_PROFILE and OASIS_IMPACT values are not among its inputs.

## Findings

### R3-F1 [major]

§3.2.4 introduces parallel builders that commit inside linked worktrees (<vitana-platform>/.agents/wt/<lane>), while §3.2.2 makes the git pre-commit hook run tsc in 'that worktree's services/gateway'. But dependencies are only ever installed for MAIN checkouts: findRepos returns only directories whose .git is a real directory (skipping worktrees whose .git is a file), and installScript iterates exactly that list to npm-ci services/gateway. A linked worktree has no services/gateway/node_modules, so the pre-commit tsc run there cannot resolve any module and will false-block the commit (or the tsc invocation fails finding tsconfig deps). Today's checkCommit runs in the main checkout where setup installed deps; the new parallel-builder path breaks that invariant for any gateway lane built by a sub-agent.

- `exafyltd/vitana-platform:scripts/collab/kiro-web-session.mjs:160` — for (const e of entries) { if (!e.isDirectory()) continue; const dir = path.join(workspace, e.name); try { if (!statSync(path.join(dir, '.git')).isDirectory()) continue; } catch { continue; }
- `exafyltd/vitana-platform:scripts/collab/kiro-web-session.mjs:175` — for (const r of repos) { if (r.slug === 'exafyltd/vitana-platform') depDirs.push(path.join(r.dir, 'services', 'gateway')); if (r.slug === 'exafyltd/vitana-v1') depDirs.push(r.dir); }
- `exafyltd/vitana-platform:scripts/collab/kiro-web-session.mjs:141` — From a linked worktree (.git is a file) the main checkout is found through git rev-parse --git-common-dir, so hooks never land next to a worktree.

Suggestion: Specify how a builder worktree gets the gateway type dependency tree for the pre-commit tsc. Options: share node_modules via a symlink from the main checkout, run tsc from the main checkout with --project pointing at the worktree, or scope the pre-commit tsc's cwd/tsBuildInfoFile such that node_modules is resolvable in worktrees. Add a test that `git-pre-commit` succeeds (or skips tsc) when run from a linked worktree that has no local node_modules, and document the dependency-resolution assumption for parallel builders. As a minimum, note explicitly that a gateway lane built by a parallel sub-agent will need node_modules present in its worktree.

### R3-F2 [major]

The `pr-body` helper's specified CLI (§3.2.2) only takes `--vtid --scope --acceptance --payload`, yet the five markers that `--pr-body-check` requires are VALIDATION_PROFILE, SCOPE_ALLOWLIST, ACCEPTANCE, MERGE_PAYLOAD_PREVIEW and OASIS_IMPACT. There is no input for VALIDATION_PROFILE (which must be one of command_hub_frontend / gateway_backend) and no input for OASIS_IMPACT (yes|no). As specified, `pr-body` cannot emit a body that satisfies the very test §3.2.7 asserts ("pr-body output passes validator-path-guard.cjs --pr-body-check"), so the first-push body path (§3.2.2) it is meant to enable would still be blocked, or the test itself is unsatisfiable.

- `exafyltd/vitana-platform:scripts/ci/validator-path-guard.cjs:360` — const PR_BODY_REQUIREMENTS = [ { code: 11, name: 'VALIDATION_PROFILE', ... }, { code: 12, name: 'SCOPE_ALLOWLIST', ...}, { code: 13, name: 'ACCEPTANCE', ...}, { code: 14, name: 'MERGE_PAYLOAD_PREVIEW', ...}, { code: 15, name: 'OASIS_IMPACT', ...} ];
- `exafyltd/vitana-platform:.github/pull_request_template.md:39` — VALIDATION_PROFILE: gateway_backend
SCOPE_ALLOWLIST: services/gateway/src/**, docs/validation/**
ACCEPTANCE: docs/validation/VTID-XXXXX/acceptance.md
MERGE_PAYLOAD_PREVIEW: none (describe what a merge deploys, or keep "none")
OASIS_IMPACT: no

Suggestion: Add `--profile <command_hub_frontend|gateway_backend>` and `--oasis <yes|no>` (or equivalent) to the `pr-body` helper so it can fill all five required declarations, and adjust the helper's signature and the §3.2.7 test accordingly. Alternatively, if the intent is to default profile/OASIS, state the defaults explicitly and verify they satisfy the path-ownership guard for the lane's actual changed files (a default `gateway_backend` profile would reject a command_hub_frontend PR's src/frontend changes).
