# GitHub → GitLab cutover — evidence tracker

**Owner of this record:** the Claude Code session on branch `ccr-ec7d9a8c-yf17sj` (vitana-platform).
**Last evidence run:** 2026-11-15, ~10:55 UTC. Re-run the checks and update this file before reporting status.
**Overall status: NOT COMPLETE.** 19 of 106 checklist lines are verified with evidence. Several are failing, and most of the rest need access or owner decisions this session does not have.

## Summary

| Status | Meaning |
|---|---|
| ✅ Verified | Checked against live evidence in this run (cited below) |
| 🟡 Partial | Some of the item is evidenced; the rest is not |
| ❌ Failing | Evidence shows it is not working |
| ⬜ Not verified | Not checked yet, or no access from this session |
| 👤 Owner | Needs an owner decision or action; cannot be closed by Claude |

Count by status across the 106 lines (each line counted once, by its primary status): ✅ 19 · 🟡 13 · ❌ 11 · ⬜ 52 · 👤 11.

**Tracker count mismatch:** the checklist header says `0/65`, but the checklist lines add up to 106 (24 repository, 30 config/CI/secrets/integrations, 14 deployment, 15 cutover, 15 post-cutover, 8 acceptance). This file tracks all 106 lines. The owner should confirm the intended denominator.

## Sources of evidence (2026-11-15)

- GitHub: `exafyltd/vitana-platform` and `exafyltd/vitana-v1`, read through the GitHub MCP tools and `git ls-remote https://github.com/...`.
- GitLab: `vitana/vitana-platform` (project id 2) and `vitana/vitana-v1` (project id 3), read through the GitLab MCP tools. Note: the `plugin:gitlab:gitlab` connector reports "needs authorization", but the GitLab MCP tools return data. Plain `git` over HTTPS to GitLab is refused (sign-in redirect), so GitLab refs come only from the MCP.
- Branch-by-branch comparison: `docs/cutover/evidence/2026-11-15/vitana-platform-branches.tsv` and `vitana-v1-branches.tsv`.

## Head SHAs at evidence time

| Repo | GitHub `main` | GitLab `main` | Equal |
|---|---|---|---|
| vitana-platform | `4d48a2e5df52807e01101a1229e09f5ba94ce75f` (2026-11-15T09:38:11Z) | `4d48a2e5…` | ✅ |
| vitana-v1 | `78455457b9c5672ca203234009c00fb985a4ae9a` (2026-11-13T23:13:09Z) | `78455457…` | ✅ |

## 1. Repository migration

### vitana-platform

| # | Item | Status | Evidence |
|---|---|---|---|
| P1 | GitLab project exists and is accessible | ✅ | GitLab project id 2, `vitana/vitana-platform`, private |
| P2 | Correct namespace and project URL confirmed | 👤 | Path resolves to `https://gitlab.vitanaland.com/vitana/vitana-platform`. The owner must confirm `vitana` is the intended namespace. |
| P3 | All branches migrated | ✅ | 1,203 of 1,203 GitHub heads present on GitLab with identical SHAs (`…-branches.tsv`) |
| P4 | All tags migrated | ✅ | `command-hub-v4-golden` on both sides, same commit `4f12cf8d160e813183ee94bf154e556af2bb88e9`. GitHub's annotated tag object `0bb0da2c` was not compared to GitLab. |
| P5 | Full Git history preserved | 🟡 | Every head SHA matches, so history is identical for all refs. No object-level integrity check (`fsck`) has been run. |
| P6 | Latest GitHub main SHA recorded | ✅ | `4d48a2e5df52807e01101a1229e09f5ba94ce75f` |
| P7 | Latest GitLab main SHA recorded | ✅ | `4d48a2e5df52807e01101a1229e09f5ba94ce75f` |
| P8 | GitHub and GitLab histories reconciled | ✅ | 1,203 of 1,203 refs match. Equal main SHA. |
| P9 | All commits and refs verified | 🟡 | Refs verified. Objects not verified. |
| P10 | Git LFS objects migrated, if applicable | ✅ | No `.gitattributes` at the root of `main` on either side. `main` is the same commit on both, so the tree is identical. Subdirectories not checked. |
| P11 | Submodules and external dependencies verified | ✅ | No `.gitmodules` at root of `main` on either side (same commit). |
| P12 | Repository permissions and collaborators configured | ⬜ | Not yet pulled. GitHub collaborators and GitLab project members need listing. |

### vitana-v1

| # | Item | Status | Evidence |
|---|---|---|---|
| V1 | GitLab project exists and is accessible | ✅ | GitLab project id 3, `vitana/vitana-v1`, private |
| V2 | Correct namespace and project URL confirmed | 👤 | Path resolves. Owner to confirm. |
| V3 | All branches migrated | ✅ | 399 of 399 GitHub heads present on GitLab with identical SHAs |
| V4 | All tags migrated | ✅ | No tags on either side |
| V5 | Full Git history preserved | 🟡 | Same as P5 |
| V6 | Latest GitHub main SHA recorded | ✅ | `78455457b9c5672ca203234009c00fb985a4ae9a` |
| V7 | Latest GitLab main SHA recorded | ✅ | `78455457b9c5672ca203234009c00fb985a4ae9a` |
| V8 | GitHub and GitLab histories reconciled | ✅ | 399 of 399 refs match |
| V9 | All commits and refs verified | 🟡 | Refs verified. Objects not verified. |
| V10 | Git LFS objects migrated, if applicable | ✅ | No `.gitattributes` at root of `main` (same commit on both sides) |
| V11 | Submodules and external dependencies verified | ✅ | No `.gitmodules` at root of `main` |
| V12 | Repository permissions and collaborators configured | ⬜ | Not yet pulled |

**Note:** the GitLab `main` branch of vitana-v1 tracks a root-level `.env` file (blob `9a73ade7…`). Its contents were **not** inspected, and must not be printed into logs or evidence. Owner and security review: confirm whether it holds secrets, whether it is also on GitHub, and whether it should be untracked and its values rotated.

## 2. GitLab configuration and CI/CD

### 2.3 GitLab project configuration

| # | Item | Status | Evidence |
|---|---|---|---|
| C1 | Branch protection configured | 🟡 | `main` is `protected: true` on both GitLab projects, with `developers_can_push` and `developers_can_merge` both false. GitHub branch protection for `main` not checked. |
| C2 | Default branch confirmed | ✅ | `main` is the default on both GitLab projects, and on both GitHub repos |
| C3 | Merge request policies configured | ⬜ | Not checked (MR approval rules API not queried) |
| C4 | Required reviewers and approvals configured | ⬜ | Not checked |
| C5 | CODEOWNERS migrated | 🟡 | No `.github/CODEOWNERS` on either GitHub repo or on GitLab vitana-v1. vitana-platform GitLab `.github` not checked. |
| C6 | Repository access roles verified | ⬜ | Not checked |

### 2.4 CI/CD pipeline migration

| # | Item | Status | Evidence |
|---|---|---|---|
| D1 | GitHub Actions workflows inventoried | ✅ | vitana-v1: **47** workflow files in `.github/workflows`. vitana-platform: **116** files. |
| D2 | Equivalent GitLab CI pipelines implemented | ❌ | No `.gitlab-ci.yml` at root of either GitLab repo. Pipelines do run on both (for example vitana-platform pipeline 405), so the CI config path is non-default and was not identified. |
| D3 | Pipeline stages and dependencies verified | ⬜ | Job-level detail not inspected |
| D4 | Build jobs execute successfully | ❌ | vitana-platform `main` pipeline id **405** (sha `4d48a2e5`, 2026-11-15 09:40Z) **failed**. The last successful `main` pipeline was pipeline id 350 (2026-11-13). vitana-v1: in the last 20 pipelines (ids 376–402, 2026-11-14 11:01Z → 11:58Z), **none succeeded**. Latest id 402 failed; ids 385, 386 and 391 canceled. |
| D5 | Automated tests execute successfully | ❌ | Same pipeline failures. Job logs not inspected yet. |
| D6 | Linting and quality checks execute successfully | ⬜ | Not inspected |
| D7 | Artifacts and caching configured | ⬜ | Not inspected |
| D8 | Pipeline failure notifications configured | ⬜ | Not inspected |

### 2.5 Secrets and infrastructure

| # | Item | Status | Evidence |
|---|---|---|---|
| S1 | GitHub Actions secrets inventoried | ⬜ | No secrets API in this session; owner or GitHub admin needed. |
| S2 | GitLab CI/CD variables configured | ⬜ | Not checked |
| S3 | Protected variables configured | ⬜ | Not checked |
| S4 | Environment-specific credentials configured | ⬜ | Not checked |
| S5 | Deploy keys and SSH keys configured | ⬜ | Not checked |
| S6 | GitLab runners registered and operational | ⬜ | Pipelines fail (not stuck pending), so runners appear to pick up jobs. Not confirmed. |
| S7 | AWS access and IAM permissions verified | ⬜ | No AWS access from this session (`472838866351` / `eu-central-1` only from CI). |
| S8 | Container registry access verified | ⬜ | Not checked (ECR per platform rules) |
| S9 | External service credentials verified | ⬜ | Not checked |

### 2.6 Integrations and automation

| # | Item | Status | Evidence |
|---|---|---|---|
| I1 | GitHub webhooks inventoried | ⬜ | Not checked |
| I2 | GitLab webhooks configured | ⬜ | Not checked |
| I3 | External MCP and automation integrations checked | ⬜ | `.mcp.json` exists in both repos. Contents not reviewed. |
| I4 | Issue and task tracking integrations verified | ⬜ | Not checked |
| I5 | Dependency and package registries checked | ⬜ | Not checked |
| I6 | Release automation verified | ⬜ | Not checked |
| I7 | Bot accounts and service tokens checked | ⬜ | Review needed: GitLab `main` commits are authored by `GitLab_full`, `group_2_bot_…@noreply.gitlab.vitanaland.com` and `kiro-agent-I`. |

## 3. Deployment and production readiness

| # | Item | Status | Evidence |
|---|---|---|---|
| R1 | GitLab deployment pipeline operational | ❌ | Same failures as D4 |
| R2 | Development deployment verified | ⬜ | No dev environment access |
| R3 | Staging deployment verified | ⬜ | Staging verification runs in GitHub Actions and is not checked here |
| R4 | Production deployment verified | ⬜ | Not checked. Production deploys are owner-gated. |
| R5 | AWS infrastructure dependencies verified | ⬜ | No AWS access |
| R6 | Environment variables and configuration validated | ⬜ | Not checked |
| R7 | Database connectivity verified | ⬜ | Not checked |
| R8 | Database migrations checked | ⬜ | Not checked |
| R9 | Frontend and backend compatibility tested | ⬜ | Not checked |
| R10 | Domain and DNS configuration checked | ⬜ | Not checked |
| R11 | SSL certificates verified | ⬜ | Not checked |
| R12 | Monitoring and logging operational | ⬜ | Not checked |
| R13 | Health checks and alerts operational | ⬜ | Not checked |
| R14 | Production smoke tests passed | ⬜ | Not checked |

## 4. Cutover execution

| # | Item | Status | Evidence |
|---|---|---|---|
| X1 | Cutover owner and technical contacts confirmed | 👤 | Not in the record. Owner must name them. |
| X2 | Final migration freeze announced | 👤 | Not done as far as the record shows |
| X3 | All active GitHub development work identified | 🟡 | **vitana-v1: 60 open PRs** (list is complete, under 100). **vitana-platform: 100+ open PRs** (first page full at 100, not paginated). Many of the open vitana-platform PRs are `plan(` or `VTID-` branches. GitLab MRs are also in use (for example MR !49 on vitana-platform). |
| X4 | Open pull requests and branches reconciled | ⬜ | Not started. Needs a decision per PR. |
| X5 | Final GitHub → GitLab synchronization completed | 🟡 | Main SHAs match right now. GitHub is still taking merges, so this is not final. |
| X6 | Final commit SHAs compared | 🟡 | Yes at `2026-11-15 ~10:55Z` (see head SHA table). Re-run at freeze. |
| X7 | GitLab selected as authoritative source | 👤 | Owner decision |
| X8 | Developers instructed to change Git remotes | ⬜ | Not done |
| X9 | Developer local environments verified | ⬜ | Not done |
| X10 | CI/CD pipelines run from GitLab | ❌ | Pipelines run, but fail (D4) |
| X11 | Production deployment source switched to GitLab | ⬜ | Production workflows still live on GitHub (`AWS-PROD-DEPLOY-*.yml`). Not switched. |
| X12 | GitHub write access restricted | 👤 | Owner decision and admin action |
| X13 | GitHub mirrors and reverse synchronization reviewed | 🟡 | Mirror push appears active: a GitHub merge at 09:38:11Z produced a GitLab pipeline at 09:40:06Z with the same SHA. Mirror configuration not read. |
| X14 | No unexpected commits arriving in GitHub | ⬜ | GitHub is receiving commits today (`4d48a2e5` at 09:38Z), so this cannot pass yet. |
| X15 | Final cutover sign-off recorded | 👤 | Owner sign-off |

## 5. Post-cutover validation and closure

| # | Item | Status | Evidence |
|---|---|---|---|
| Z1 | Both GitLab repositories confirmed operational | ❌ | Both fail CI (D4) |
| Z2 | Both main branches confirmed correct | 🟡 | Equal to GitHub. Correctness is an owner check. |
| Z3 | Developers can clone, pull and push | ⬜ | Not tested. Clone over HTTPS from this session is refused (sign-in redirect). |
| Z4 | Merge requests work correctly | ⬜ | MRs exist and have pipelines. Not tested end to end. |
| Z5 | CI/CD pipelines pass | ❌ | D4 |
| Z6 | Staging and production deployments verified | ⬜ | Not checked |
| Z7 | AWS integrations verified | ⬜ | Not checked |
| Z8 | Monitoring confirms normal operation | ⬜ | Not checked |
| Z9 | No missing commits or branches | ✅ | Branches: 1,203/1,203 (platform) and 399/399 (v1), identical SHAs. Re-verify at freeze. |
| Z10 | GitHub repositories switched to read-only or archive as appropriate | 👤 | Owner decision |
| Z11 | Old GitHub workflows disabled where appropriate | 👤 | Owner decision. Note: `archive/main-pre-cutover-4c4694b7` already exists on GitHub (platform). |
| Z12 | Old credentials and tokens reviewed | ⬜ | Not started. Includes the `.env` note in §1. |
| Z13 | Migration documentation completed | 🟡 | This file is a start. Existing cutover docs to review: GitHub PR #1694 (vitana-v1, "record GitLab delivery cutover decisions (2026-11-14)") and GitHub PR #5085 (vitana-platform, "GitLab cutover status for Claude (2026-11-14)", draft). |
| Z14 | Team informed of final GitLab workflow | ⬜ | Not done |
| Z15 | Final cutover approval documented | 👤 | Owner approval |

## 6. Final acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| A1 | Both repositories have identical intended migration history | 🟡 | Identical refs and main SHAs as of this run |
| A2 | GitLab is the single source of truth | ❌ | GitHub still receives merges. Not decided. |
| A3 | All developers are working from GitLab | ❌ | Not done |
| A4 | All pipelines and deployments work | ❌ | D4, R1 |
| A5 | Production is operating correctly | ⬜ | Not checked |
| A6 | No outstanding migration blockers remain | ❌ | Failing pipelines, open PRs, `.env` review, owner decisions |
| A7 | Rollback strategy documented | ⬜ | Not written |
| A8 | Technical owner signs off | 👤 | Owner sign-off |

## Blockers, by owner

**Owner (👤):** confirm the two namespaces (P2, V2); name the cutover owner and technical contacts (X1); decide GitLab as authoritative (X7); announce the freeze (X2); decide the open-PR policy (X3/X4); restrict GitHub writes (X12); decide read-only or archive for GitHub (Z10/Z11); sign off (X15, Z15, A8); confirm the denominator (65 vs 106).

**Claude can do next, without the owner:**
1. Read the failing job logs for vitana-platform pipeline 405 and vitana-v1 pipeline 402 (GitLab `get_job`) and fix forward within the three-attempt limit.
2. Identify the GitLab CI config path, and why no `.gitlab-ci.yml` is at root.
3. Pull GitHub collaborators and GitLab members (P12, C6).
4. Check the GitHub workflow inventory on GitLab for the platform repo (D1 platform side is evidenced on GitHub only).
5. Re-run the branch and SHA comparison at freeze (X6, Z9) and append the result here.

**Security item to raise now:** the committed `.env` in vitana-v1 (§1 note). Do not print its contents.

## Run log

- **2026-11-15 ~10:55 UTC** — First evidence run. Branch comparison, head SHAs, pipeline status, workflow inventory, open PR counts, CODEOWNERS/LFS/submodule checks. Files: this tracker and `docs/cutover/evidence/2026-11-15/`.

## Run log (continued, 2026-11-15 ~11:10 UTC): GitHub retirement directive

**Blocker resolved: `v1.gitlab-ci.yml` vs `v1-delivery.gitlab-ci.yml`.**
- Canonical name is `v1-delivery.gitlab-ci.yml`. Commit `350b5783` (VTID-05719) switched vitana-v1's CI file to the delivery pipeline. `infra/gitlab-engineering/settings/gitlab-settings.json` (`projects.vitana-v1.ci_file`) and `config/delivery/services.json` both name it, and `pipeline-gen` writes it.
- The schema test in `scripts/eng/gitlab-settings.test.mjs` still asserted the old name and failed on main. Fixed in `cffb4c80`: the test now matches the config the sync reads. `gitlab-settings.test.mjs` passes 56/56 locally. No runtime change.

**Still open (not a cosmetic fix, needs an owner decision):**
- `scripts/eng/free-tier-guard.test.mjs` has four central-CI failures (cases 6, 7, 10 and 12). They fail the same way on main. Case 6 still expects `v1.gitlab-ci.yml`. Cases 7 and 10 check the milestone-1 central file, and case 7 says "no deploy", but `v1-delivery` has a `deploy` stage (`check`, `build`, `deploy`). Changing these assertions would hide a real difference between the promised structure and what the sync ships, so they are left for the owner. Options: keep `v1-delivery` and rewrite the milestone-3.3 promise, or revert the config to `v1.gitlab-ci.yml`.
- GitLab vitana-v1 pipeline 402 (MR !1 head `4dc5cbb5`) failed. Job IDs are not exposed by the pipeline read, so job logs are not yet read.
- The vitana-platform `unit` failure on PR #5099 was the same settings-test mismatch. It is now fixed on this branch.
- `.env` tracked on GitLab `main` in vitana-v1: still not reviewed; contents not read.

**Directive status (2026-11-15):** inventory of GitHub controls, workflows and integrations is NOT STARTED beyond the workflow count (47 in v1, 116 in platform). Retirement actions (branch protection changes, webhook/token removal, read-only/archive of GitHub) are NOT STARTED and are held for owner approval, since they are irreversible or affect access.

**PR #5099 `unit` at head `d764d726` (2026-11-15 11:20Z): 9 failing tests, none caused by this branch.**
- 4 are the central-CI guard cases in `scripts/eng/free-tier-guard.test.mjs` (open owner decision above).
- 5 are in `scripts/eng/fleet-classes-structure.test.mjs` (cases 8, 9, 10, 14, 20: `vitana-eng` and `vitana-eng-deploy` job tags, seccomp/AppArmor for the BuildKit service, `.build-image` rootless setup). They reproduce locally on the same code. That file and its inputs are not changed on this branch. The lanes `build-class-retag-2` and `deploy-path` in `.kiro/specs/agentic-delivery` track this as known work.
- Branch changes: only `docs/cutover/**` and `scripts/eng/gitlab-settings.test.mjs`.
