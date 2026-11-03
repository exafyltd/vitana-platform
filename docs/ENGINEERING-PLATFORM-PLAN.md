# Engineering Platform — self-hosted GitLab on AWS for governed agent delivery

Based on `vitana-platform@50e55fd3a4` and `vitana-v1@c3d71c83e` (main, 2026-11-02).
Programme: `docs/programs/engineering-platform/program.md`. First slice: spec `eng-platform-p01`.

---

## 1. What the codebase changes about the original plan

| # | Finding (evidence) | Consequence for the plan |
|---|---|---|
| F1 | There is no usable AWS IaC baseline. The only AWS Terraform in the repo is `infra/cognito-migration` (never applied, S3 backend commented out, no state bucket). The real IaC lives in private `exafyltd/vitana-infra`, whose README says "DO NOT terraform apply YET" because its state is stale. A 2026-07-09 bulk-provisioning event created 27 ECS services, and 23 of them are undocumented (`.claude/rules/infrastructure.md`). | Terraform for the new platform starts in a **new, separate state**. Existing resources are read through `data` sources only. Reconciling `vitana-infra` is out of scope and is not a prerequisite. |
| F2 | There is one AWS account (`4728…`), one ECS cluster (`Vitana-ECS-Cluster`), one VPC and security group, and one Aurora cluster, all shared by staging and prod. Staging also writes to the production Supabase project. | "Staging credentials cannot reach production" cannot be achieved with IAM alone in the current account. GitLab and its runners go into a **separate AWS account**. Backend preview environments are blocked until a non-production database exists. |
| F3 | Prod deploys use GitHub OIDC, but the documented trust condition is `repo:exafyltd/vitana-platform:*`, which allows any branch (`scripts/aws/README.md`). Staging deploys and the **prod frontend** deploy use the static keys of IAM user `claude-staging-validation`. | Fix this now, before GitLab exists. The GitLab OIDC trust is pinned to project path, protected ref and environment from day one. |
| F4 | Promotion copies a **tag** (`:<sha>`, `awsdr-latest`) from the staging task def; it is not a digest. Auto-rollback exists only in `AWS-PROD-DEPLOY-GATEWAY.yml` (VTID-04647). | Keep the promote-staging design and pin by `@sha256` digest. Make rollback a shared template job for every service. |
| F5 | Governance already exists, but it is GitHub-native: PLAN-SPAR (allocates VTIDs), PR-GATE, lane-scope, the reviewer agent's verdict bound to head SHA, `land-guard.mjs` with `RUN/merge.lock` (a hand-built serialized merge queue), STAGING-VERIFY, Gate 2 owner PUBLISH, and VTID-AUTO-CLOSE. | These are the functional spec for merge trains and approvals. **Port them; do not redesign them.** |
| F6 | Two agent execution paths exist. (a) The gateway Worker Orchestrator claims tasks from `vtid_ledger` and runs the `autopilot-executor` ECS task. (b) The Kiro lane pipeline uses `kiro-runner` worktrees, `queue.mjs` and a 6-slot `slots.json`. Both write to GitHub through shared tokens (`GITHUB_SAFE_MERGE_TOKEN`, `DEV_AUTOPILOT_GITHUB_TOKEN`, `FRONTEND_DEPLOY_TOKEN`). There is no GitHub App and no webhooks; everything polls. | Isolated agent workspaces already exist. **GitLab runners run CI only.** Agents keep running in the existing executors and receive per-agent GitLab identities. |
| F7 | GitHub coupling is wide: about 30 platform files call `api.github.com` and about 30 use the `gh` CLI; there are 113 + 46 workflows; OASIS topics are named `cicd.github.*`; `kiro-runner/src/repo-mirrors.ts` hardcodes github.com URLs. There is no provider abstraction (the closest are `github-service.ts` and `vitana-repos.ts`). | The **first code deliverable** is a `GitProvider` interface. Porting the workflows, not installing GitLab, is the largest cost of the project. |
| F8 | No service-principal model exists. Agents authenticate with shared secrets (`GATEWAY_SERVICE_TOKEN`, `X-Dev-Memory-Token`, the operator machine token) or by running a human exafy_admin session. Cognito has a known `exafy_admin` gap. | An agent identity registry is needed. It must be designed with the owners of `mt-track-s-authz`, not alongside them. |
| F9 | Multi-tenancy is in Track S / M0. The files currently changing include `routes/approvals.ts`, `lib/permitted-roles.ts`, `require-service-or-admin.ts`, `orb-live.ts`, vitana-v1 `supabase/functions/**`, and the RLS and access-token-hook work. Source code is platform-owned, not tenant-owned. | The engineering platform sits in **platform scope** (exafy_admin plus `/api/v1/dev-access` grants). A tenant-level `developer` role grants nothing in GitLab. The active mt-track files are not touched. |
| F10 | The working console is the gateway's Command Hub. Vitana Dev (`/dev/*` in vitana-v1) is mostly empty pages. Its `DevAuthGuard` checks only that the user is signed in, not their role. | Extend Command Hub. Do not build a third console. Fix `DevAuthGuard` before `/dev` shows anything sensitive. |
| F11 | Agent context already exists: `/api/v1/dev-memory/morning-pack`, `/resume/:vtid`, the codeintel index (RepoWise/Graphify, CODEINTEL-INDEX), `.repowise/decisions.yaml`, `second-brain/`, and the JEV gates (`pr-clash`, `change-risk`, `test-selection`) running in shadow mode. No component is called "Memory Core". | The agent context bundle is these existing endpoints with GitLab MR and branch data added. Conflict detection extends `lane-scope` and `JEV_PR_CLASH`. |
| F12 | DNS for `vitanaland.com` is Cloudflare (a Worker sits in front of the ALB). Route 53 is not used. | Use `gitlab.vitanaland.com` in Cloudflare DNS → ALB, with the ACM certificate validated through Cloudflare. |

---

## 2. Decisions (taken 2026-11-02 on the owner's instruction "you decide for me")

| # | Decision | Reason | Reversible? |
|---|---|---|---|
| D1 | Move source control to GitLab in stages: vitana-v1 first (no `api.github.com` callers, 46 workflows), then vitana-platform. GitHub ends as an archived read-only mirror. Never two-way sync. | The owner asked for self-hosted GitLab; a staged move keeps one source of truth per repo at every moment. | Yes, until GitHub is archived. |
| D2 | GitLab self-managed **Premium**. Install the EE package unlicensed (it runs as Free) and buy Premium before the vitana-v1 cutover (Phase 6). | Merge trains, required approvals, prevent-author-approval, CODEOWNERS, protected environments with deployment approvals and service accounts are Premium. Buying later defers spend until the features are used. | Yes: EE without a licence is Free. |
| D3 | A new AWS **engineering account** in AWS Organizations for GitLab and runners; cross-account OIDC roles into the workload account `4728…`. | Staging and prod share one account, cluster, VPC and Aurora (F2); an account boundary is the only isolation IAM alone cannot undo. | Yes. |
| D4 | Single-node Omnibus EE on EC2 with RDS PostgreSQL, ElastiCache Redis and S3 object storage; Gitaly on encrypted EBS. RPO 1 h, RTO 4 h. | Smallest production-grade topology; components move to a reference architecture without redesign. | Yes. |
| D5 | Kiro writes Terraform and scripts and runs `plan` read-only; the owner runs `apply`. Agents never apply. | Only the owner has AWS admin rights today. | n/a |
| D6 | GitLab local accounts with mandatory 2FA for humans; OIDC SSO after the Cognito migration. | No identity provider is live for SSO today. | Yes. |
| D7 | A non-production database is a dependency of backend preview environments and true staging isolation, tracked outside this program. Until it exists: frontend previews only. | Staging shares the production database (CLAUDE.md, owner-autonomy stop 1). | n/a |

Owner actions that remain (cannot be done by an agent): create the engineering account (D3), purchase Premium (D2, before Phase 6), run the inventory and the OIDC role script (plan `eng-platform-p01` §8), and command the `AWS-PROD-*` follow-ups (prod frontend on OIDC, promotion by digest).

## 3. Target architecture (adjusted)

```
Engineering account (new)                       Workload account 4728… (existing, unchanged)
┌───────────────────────────────────────┐        ┌───────────────────────────────────────┐
│ VPC, private subnets, VPC endpoints    │        │ ECS Vitana-ECS-Cluster, Aurora, Redis │
│ ALB+ACM ← Cloudflare DNS               │        │ ECR vitana/*                          │
│ GitLab Omnibus EC2 (pinned)            │        │                                       │
│   RDS PG · ElastiCache · S3 objects    │ OIDC   │ IAM roles (trust = GitLab issuer):    │
│   AWS Backup · KMS · SSM only          │ ─────▶ │  gl-ecr-push        (main, build)     │
│ Runner manager EC2                     │ STS    │  gl-staging-deploy  (main, env=stg)   │
│   ASG validate   (untrusted, no AWS)   │        │  gl-prod-deploy     (main, env=prod,  │
│   ASG build-stg  (protected main)      │        │                      approval)        │
│   ASG release    (protected env prod)  │        │  gl-tf-plan         (read-only)       │
│   ASG infra      (plan only)           │        │                                       │
└───────────────────────────────────────┘        └───────────────────────────────────────┘
        ▲ HTTPS git push (per-agent token)                   ▲
        │                                                    │ webhooks → gateway
Existing agent executors (unchanged): autopilot-executor ECS task, kiro-runner worktrees
Gateway: GitProvider interface, /api/v1/scm/gitlab/webhook → OASIS → vtid_ledger
Command Hub: MR / pipeline / train / approval views, PUBLISH plays the GitLab prod job
```

**Runner classes (CI only)**
- `validate` runs MR pipelines on agent branches. It has no AWS role apart from its own S3 cache prefix, restricted egress, and no network path to the workload VPC.
- `build-stg` runs only on protected `main`. It pushes to ECR and deploys staging.
- `release` runs only in the protected `production` environment, executes only the promote job, and uses short-lived STS credentials.
- `infra` runs `terraform plan` read-only. `apply` happens only through a protected environment with owner approval.

**Fleet settings.** Docker Autoscaler with `fleeting-plugin-aws`, `capacity_per_instance = 1`, `max_use_count = 1`, no public IP, IMDSv2 required, AMIs built by Image Builder/Packer and versioned. The original "Agent" runner class is dropped because coding agents already have workspaces (F6).

---

## 4. How existing governance maps to GitLab

| Today (GitHub) | GitLab equivalent | Notes |
|---|---|---|
| PR-GATE VTID title check, scope guard, test-weakening guard (`scripts/ci/pr-gate/gate.mjs`) | Job in the central `ci-templates` MR pipeline, plus a push rule on commit messages | Same scripts, called with `--scm gitlab` |
| PLAN-SPAR (VTID allocation) | Job in the central template | `allocate_global_vtid` is unchanged |
| Reviewer agent verdict bound to head SHA (`store-review.cjs`) | Reviewer service account approves the MR, with "reset approvals on push" turned on | Head binding is enforced natively. The existing review record is kept. |
| `land-guard merge` + `RUN/merge.lock` + `gh pr update-branch` | Merge train with merged-results pipelines | On CE, keep `land-guard` and point it at the GitLab API |
| `protected-gate-files.json` | CODEOWNERS on gate files plus a separate `ci-templates` project that application agents cannot write to | Templates are included by pinned ref |
| STAGING-VERIFY | `main` pipeline stage that blocks the release job | |
| Gate 2, owner PUBLISH | `production` protected environment with owner deployment approval. Command Hub PUBLISH calls the GitLab API. | Promotes by digest, no rebuild |
| Gateway auto-rollback (VTID-04647) | Template job used by every service | |
| VTID-AUTO-CLOSE | MR-merged webhook → OASIS → `/oasis/tasks/:vtid/complete` | |
| `cicd.github.*` OASIS topics | New `scm.*`, `pipeline.*`, `train.*` and `deploy.*` topics | Old topics keep being emitted during the transition |
| Crons and alerts in workflows (ALERT-*, CRON-*, monitors) | EventBridge (already used) or GitLab scheduled pipelines | These are not CI; move them out |

---

## 5. Phases

Each phase has its own VTIDs through PLAN-SPAR and runs through the normal lane, review and land flow. New AWS resources each get their own VTID (infrastructure rule §1b).

**Phase 0: Discovery and decisions (read-only)**
- Kiro writes a read-only AWS inventory script covering accounts, VPCs, IAM roles and trusts, ECR, ECS, secrets and costs. The owner runs it with ReadOnlyAccess, and the output goes into `docs/`.
- Verify the live trust policy of `AWS_PROD_ROLE_ARN`.
- Record decisions D1–D7.
- File the spec as `.kiro/specs/engineering-platform-gitlab/`.
- Exit: decisions recorded and inventory merged.

**Phase 1: Fix now (useful under any D1 option)**
- Narrow the GitHub OIDC trust to `ref:refs/heads/main` plus the environment.
- Move the stage deploys and the prod frontend deploy to OIDC, then delete the `claude-staging-validation` keys.
- Pin promotion by digest.
- Remove dead paths: `AUTO-DEPLOY.yml`'s missing `EXEC-DEPLOY` target, and the Cloud Run URL in `emit-deploy-telemetry`.
- Exit: no static AWS keys in any CI. Prod role not assumable from a non-main ref.

**Phase 2: GitLab foundation (engineering account)**
- Terraform with a new S3 state, `use_lockfile`, KMS and versioning.
- VPC, ALB with ACM, Cloudflare DNS, pinned Omnibus, RDS, ElastiCache, S3 object storage, SSM-only access, CloudTrail/Config/Security Hub enabled in the new account.
- AWS Backup plus `gitlab-backup` to S3, then a **restore into a scratch instance**.
- Group layout: `vitana/platform`, `vitana/v1`, `vitana/ci-templates`, `vitana/infra`. `main` protected and nobody pushes to it directly.
- Repos imported (a push mirror from GitHub during the transition).
- Exit: A01–A04.

**Phase 3: CI runner fleet**
- Runner manager, four ASGs, hardened AMI pipeline, S3 cache with lifecycle rules, per-class runner tokens, protected runners for build and release.
- Run the existing unit and test suites on GitLab against the mirror and compare results with GitHub.
- Concurrency starts at 10.
- Exit: A05, A08 (CI part).

**Phase 4: Provider abstraction and events (gateway code)**
- A `GitProvider` interface. `GitHubProvider` wraps the existing `github-service.ts` with no change in behaviour; `GitLabProvider` is new.
- Migrate call sites one module per lane: `dev-autopilot-execute.ts`, `kiro-push-branch.ts`, `cicd.ts`, `vitana-repos.ts`, `kiro-runner/repo-mirrors.ts`, then the rest.
- Webhook receiver at `/api/v1/scm/gitlab/webhook` with secret-token check → OASIS → projector.
- `scripts/collab/*.mjs` move from `--gh` to `--scm`.
- Exit: one contract test suite passes against both providers. A14 done; A15 partly done.

**Phase 5: Agent identity**
- GitLab service accounts per agent role: worker-frontend, worker-backend, worker-memory, autopilot-executor, kiro-lane-executor, lane-reviewer, verification-engine. All have Developer role, so none can push to `main` or approve their own MRs.
- Tokens are scoped per project and kept in Secrets Manager with rotation.
- Every commit carries `VTID:`, `Execution-ID:` and `Agent:` trailers.
- A minimal `engineering_agents` registry in platform scope, designed with the mt-track-s-authz owners. It needs an approved migration plan.
- Exit: A06, A12, A13.

**Phase 6: Pilot cutover of vitana-v1**
- Port its workflows to the central templates: MR pipeline, `main` delivery, and frontend previews on S3/CloudFront.
- GitLab becomes the source of truth for vitana-v1, and GitHub becomes a read-only push mirror.
- Run the lane pipeline on GitLab for two weeks.
- Exit (frontend): A17, A19, A20, A21, A22, A23, A25.

**Phase 7: vitana-platform cutover**
- Port the deploy workflows into per-service template jobs. Move crons and alerts to EventBridge.
- Turn merge trains on.
- Retire the GitHub OIDC role and the shared GitHub tokens.
- Exit: A18, A26, A27, A29.

**Phase 8: Scale and resilience**
- Run 10, then 20, then 50 concurrent agents. Raise the existing caps on purpose: the 6 lane slots, the fixed worker-runner count, and the merge train's 20 parallel pipelines.
- Conflict tests through lane-scope and JEV pr-clash, moved out of shadow mode.
- Tenant-isolation tests: agent tokens and runners cannot reach prod Aurora or tenant memory.
- DR drill, cost review.
- Exit: A11, A28, A30.

**Scheduling constraints**
- Do not schedule the cutovers in the same window as mt-track DB applies.
- Avoid the GCP Vertex carve-out deadline (about 2026-12-16).

---

## 6. Explicitly not doing (versus the original plan)
- No GitLab runner class for coding agents; agents keep their existing executors.
- No Route 53; DNS stays on Cloudflare.
- No GitLab container registry; ECR stays.
- No backend per-MR preview environments until a non-prod database exists (D7). Frontend previews only.
- No new "Engineering Control Center"; Command Hub is extended.
- No attempt to make Terraform authoritative for existing infrastructure.
- No new user or role model. Platform scope comes from the existing exafy_admin and dev-access grants.

## 7. Main risks
- Effort is dominated by porting about 160 workflows and about 60 GitHub call sites, not by installing GitLab.
- A single-node GitLab is a single point of failure. The RTO must be accepted explicitly.
- 50 agents generate heavy API and webhook load. Size by requests per second and load-test before Phase 8.
- Premium seat cost, including how agent service accounts are licensed.
- Running two providers during the transition: there must be one source of truth per repo at any moment, never two-way sync.

## 8. Acceptance criteria
Keep A01–A30 from the original plan, with these changes:
- **A11** is redefined as: no agent token or runner can read production tenant data, secrets or memory.
- **A20** is frontend only until D7 is resolved.

New criteria:
- **A31**: no static AWS keys in any CI.
- **A32**: OIDC trusts are pinned to project, protected ref and environment.
- **A33**: the GitProvider contract suite passes for both providers.
- **A34**: GitHub repos are archived or read-only after cutover.

## Sources
- [GitLab merge trains](https://docs.gitlab.com/ci/pipelines/merge_trains/)
- [Docker Machine executor deprecation, removal in GitLab 20.0 (May 2027)](https://gitlab.com/gitlab-org/gitlab/-/issues/498268)
- [Docker Autoscaler executor](https://docs.gitlab.com/runner/executors/docker_autoscaler/)
- [GitLab reference architectures](https://docs.gitlab.com/administration/reference_architectures/)
