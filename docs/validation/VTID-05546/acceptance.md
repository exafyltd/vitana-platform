Change types: Infrastructure/CI.

# VTID-05546 acceptance (agentic-delivery/deploy-path)
Lane `deploy-path` of plan `agentic-delivery` (vitana-platform), tasks D1-D7 of `.kiro/specs/agentic-delivery/tasks.md`;
plan §3.2, §3.6 step 2, §3.7, §3.8, §3.10, §7 and §9. Builder session `kiro-exafy-202611051643-bc0a` (seat exafy),
driver `kiro-exafy-202611041929-802c`. Nothing here calls AWS, GitLab or a staging system: every AWS and registry call
goes through an injectable runner, and the setup script was run only against a stub `aws`.

Outcome: GitLab can build the images of both repositories without a privileged daemon (rootless BuildKit, OCI
archive), push them by digest to their own staging ECR repository, deploy them to staging by copying the live task
definition and changing only the image digest, the commit variables and (live mode) the env overrides, roll back a
deploy that does not stabilise or does not serve its build stamp, and publish vitana-v1 merge-request previews under
`mr-<iid>/`. Every job signs in with a per-job ID token through the six roles of plan §7, whose trust pins `aud` and
`sub`; no AWS key exists on the GitLab side. The owner applies the roles, the OIDC provider, the secrets and the 30 s
deregistration delay with one script (A1), dry run by default, and the runner classes with the M2 entry point (A2).
Parts that live in M2's files wait for lane eng-gitlab-m2/fleet (see "Waits for M2 fleet").

AC-1 `deploy` copies the live task definition and changes only the image digest, the commit variables
(`GIT_COMMIT_SHA`, `COMMIT_SHA`, `BUILD_INFO_MARKER` for the gateway) and, in live mode, the service's env overrides
(`PM_AGENT_ENABLED=false`, `DELIVERY_HOST_VITANA_PLATFORM=gitlab`, `DELIVERY_HOST_VITANA_V1=gitlab`); read-only fields
are not sent back; secrets and sidecars are untouched; an override cannot replace a secret or a commit variable.
TEST: scripts/eng/deploy/deploy-ecs.test.mjs "live mode changes only the image digest, the commit variables and the env overrides"; "an env override cannot replace a secret or a commit variable".

AC-2 Shadow mode (`DELIVERY_MODE` not `live`) renders the definition and its diff as artifacts and makes no ECS write;
env overrides are never applied in shadow mode; the deploy-runs entry is `skipped` (the reader ignores it, as it ignores
a skipped GitHub run).
TEST: scripts/eng/deploy/deploy-ecs.test.mjs "shadow mode renders the definition and makes no ECS write".

AC-3 A service, cluster or ECS service outside the plan §3.10 allowlist, or an image outside the service's own ECR
repository, is refused (exit 2) before any AWS call.
TEST: scripts/eng/deploy/deploy-ecs.test.mjs "a service outside the plan §3.10 allowlist is refused before any AWS call"; "an image outside the service ECR repository is refused before any AWS call"; "the CLI refuses a service outside the allowlist (exit 2) and its rollback without a state does nothing".

AC-4 A deploy that finds a newer descendant already served ends `superseded` (exit 0) and writes nothing to ECS; a
served commit that is not a descendant does not supersede.
TEST: scripts/eng/deploy/deploy-ecs.test.mjs "a deploy that finds a newer descendant served ends superseded and writes nothing"; "a served commit that is not a descendant does not supersede".

AC-5 A stabilise failure or a wrong build stamp re-points the service to the revision captured before any write, waits
for the old stamp, records `rolled_back` and ends the job red (exit 1).
TEST: scripts/eng/deploy/deploy-ecs.test.mjs "a stabilise failure re-points to the captured revision and ends red"; "a wrong build stamp re-points to the captured revision and ends red".

AC-6 `.rollback-staging` (on failure) re-points when the deploy job stopped after its update (killed or timed out),
and changes nothing when the deploy job changed nothing, was superseded, was shadow, succeeded or already rolled back.
TEST: scripts/eng/deploy/deploy-ecs.test.mjs "the rollback job re-points when the deploy job stopped after the update"; "the rollback job changes nothing when the deploy job changed nothing or already rolled back".

AC-7 A missing role (or a trust that does not match the job) fails the job (exit 4) and names the role; nothing is
written.
TEST: scripts/eng/deploy/deploy-ecs.test.mjs "a missing role fails the job and names the role".

AC-8 The deploy-runs file is `[{"service","sha","started_at","finished_at","outcome"}]`, exactly these keys in this
order, ISO times, one entry per service and commit, for `gateway` and `community-app` (the community app is read by its
`vitana-app-version` stamp, family pinned to `vitana-community-app`, image the only change).
TEST: scripts/eng/deploy/deploy-ecs.test.mjs "it writes the deploy-runs file of the contract lane verify-on-gitlab reads".

AC-9 `push-image` pushes the OCI archive with skopeo (no daemon), outputs the digest and the image by digest, tags
`<sha12>` in live mode and only `shadow-<sha12>` in shadow mode, gives the ECR password on stdin only, and refuses a
target outside the service's ECR repository, registry account or region before any call.
TEST: scripts/eng/deploy/push-image.test.mjs "it pushes the archive, outputs the digest and the image by digest"; "shadow mode pushes only a shadow-<sha12> tag"; "it refuses a target outside the service ECR repository"; "a push without a digest fails the job".

AC-10 Previews: only `mr-<iid>/` (live mode) and `gl-main/` exist (trailing slash required, so `mr-12/` never matches
`mr-123/`); upload writes and invalidates only its prefix; teardown removes only its own `mr-<iid>/`; shadow mode writes
only `gl-main/`; only the community app has a preview.
TEST: scripts/eng/deploy/preview.test.mjs "a merge request preview is uploaded to mr-<iid>/ only and that path is invalidated"; "only the prefixes mr-<iid>/ and gl-main/ exist"; "shadow mode writes only the gl-main/ preview"; "teardown removes only its own prefix"; "only the community app has a preview, and the distribution id is required".

AC-11 The OIDC provider is `https://gitlab.vitanaland.com` with the six audiences; each trust policy has one statement,
the GitLab provider as the only principal (no `*`), StringEquals on `aud`, and `sub` pinned to the project paths and
refs of plan §7 (StringLike only for `<v1>*` and `<v1>assist/*`).
TEST: scripts/eng/gitlab-oidc-structure.test.mjs "the OIDC provider is gitlab.vitanaland.com with exactly the six audiences"; "each trust policy: StringEquals on aud, sub pinned to the plan §7 project paths and refs, no * principal".

AC-12 Each permission policy names exactly the resources of plan §7; `*` only for the three actions IAM cannot scope
(`ecr:GetAuthorizationToken`, `ecs:DescribeTaskDefinition`, `ecs:RegisterTaskDefinition`); no wildcard action; PassRole
only to ECS tasks; no production role, resource or name.
TEST: scripts/eng/gitlab-oidc-structure.test.mjs "each permission policy names only the resources of plan §7"; "there is no production role".

AC-13 `setup-gitlab-oidc.sh` is a dry run by default that makes only read calls and prints every call exactly
(`[READ]`, `[DRY-RUN]`), lists which secrets exist and which need a value, includes the target-group step, skips the
preview role without a distribution id, and stops (exit 4) unless the account is 472838866351 and the region
eu-central-1, before any write (wrong region: before any AWS call).
TEST: scripts/eng/gitlab-oidc-structure.test.mjs "the setup script is a dry run by default and prints every call it would make"; "the setup script skips the preview role without a distribution id"; "the setup script stops outside account 472838866351 or region eu-central-1".

AC-14 Runner classes (Terraform): two groups `vitana-eng-fleet-main` (max 12) and `vitana-eng-fleet-deploy` (max 6,
On-Demand only), min 0 and desired 0 left to the runner, scale-in protection, AZRebalance suspended, IMDSv2 required
with hop limit 1, no public IP, encrypted gp3 with the M1 key, no instance profile and no IAM resource, egress tcp 80,
tcp 443 and DNS (VPC only) and no ingress; a quota that is too low makes the check print the request command.
TEST: scripts/eng/fleet-classes-structure.test.mjs "two new groups, main and deploy: …"; "IMDSv2 required with hop limit 1, …"; "no instance policy: …"; "egress tcp 80, tcp 443 and DNS only, and no ingress"; "a quota that is too low makes the Terraform check print the request".

AC-15 Plan §3.2 structure rules over every CI file in `infra/gitlab-engineering/ci/`: a job tagged `vitana-eng` declares
no `id_tokens` and names no secret; a job tagged `vitana-eng-deploy` runs no repository script (every `node`/`bash`/`sh`
target is a `$CENTRAL_DIR/` script of platform main; no `npm`, `npx`, `make`, `./`, `source`). Checked also with the
CI files of lanes pipelines and verify-on-gitlab present (outputs/cross-lane-job-classes.txt: 9/9 pass).
TEST: scripts/eng/fleet-classes-structure.test.mjs "a job tagged vitana-eng declares no id_tokens and names no secret"; "a job tagged vitana-eng-deploy runs no repository script".

AC-16 `tpl-deploy.yml` defines the six jobs of plan §9 as hidden jobs: `.build-image` on the main class with no ID
token, rootless BuildKit pinned by digest and `--oci-worker-no-process-sandbox`, never privileged; `.push-image`,
`.deploy-staging`, `.rollback-staging` on the deploy class with exactly the audiences `aws:v1:staging` and
`aws:platform:staging` (the role chosen by project path); `.preview-upload` and `.preview-stop` with only
`aws:v1:preview`; the deploy job's artifacts kept on failure for the rollback job; `build-image.sh` refuses without the
no-process-sandbox flag.
TEST: scripts/eng/fleet-classes-structure.test.mjs "tpl-deploy defines the six jobs of plan §9: build on the main class, the rest on the deploy class"; "build-image.sh refuses without --oci-worker-no-process-sandbox".

States: role missing → `could not sign in as role gl-…`, exit 4, nothing written (AC-7); outside the allowlist → exit 2,
no call (AC-3, AC-9, AC-10); superseded → exit 0, no ECS write, entry `superseded` (AC-4); not stable or wrong stamp →
rollback to the captured revision, entry `rolled_back`, job red (AC-5); rollback failed → entry `failed`, job red,
`.rollback-staging` retries (AC-6); shadow mode → only `shadow-<sha12>` images, rendered definitions and the `gl-main/`
preview (AC-2, AC-9, AC-10); a closed merge request → `.preview-stop` removes `mr-<iid>/` (AC-10); quota too low → the
Terraform check prints the request (AC-14).
Surfaces: GitLab main-class and deploy-class jobs (`tpl-deploy.yml`); the staging ECR repositories and ECS services of
plan §3.10 (`Vitana-ECS-Cluster`: `vitana-community-app-staging`, `vitana-gateway`, `vitana-erp-bridge`,
`vitana-kiro-runner`, `vitana-postgrest-aurora-proxy`); `s3://vitana-pr-previews` (`mr-*`, `gl-main/*`); the preview
CloudFront distribution; IAM (owner's apply only).
Locales: n/a. Accessibility: n/a.

Contract:
- Deploy-runs file: writer `scripts/eng/deploy/lib.mjs:127` (`writeDeployRun`, outcomes at `:125`), called by
  `scripts/eng/deploy/deploy-ecs.mjs:226` (`deploy`) and `:316` (`rollback`); reader
  `origin/kiro/agentic-delivery/verify-on-gitlab:scripts/ci/staging-verify/run.mjs:208` (`deployRunsFromEntries`: keys
  service, sha, started_at, finished_at, outcome; `skipped` ignored by `deployCutoff`, `scripts/ci/staging-verify/lib.cjs:475`).
  The file path is `$CI_PROJECT_DIR/deploy-runs.json` on both sides (`tpl-deploy.yml:94-106` writes it as an artifact,
  `tpl-verify.yml:56` reads `DEPLOY_RUNS_FILE`).
- Job names of plan §9: `tpl-deploy.yml:26` `.build-image`, `:80` `.push-image`, `:94` `.deploy-staging`, `:108`
  `.rollback-staging`, `:146` `.preview-upload`, `:153` `.preview-stop`; extended by lane pipelines at
  `v1-delivery.gitlab-ci.yml:1142,1186,1264,1687,1726,1768,1811` and the same names in `platform-delivery.gitlab-ci.yml`
  (`origin/kiro/agentic-delivery/pipelines`).
- Variables: lane pipelines passes `DEPLOY_SERVICE`, `DEPLOY_ECR_REPOSITORY`, `DEPLOY_IMAGE_CONTEXT`,
  `DEPLOY_DOCKERFILE`, `DEPLOY_ECS_CLUSTER`, `DEPLOY_ECS_SERVICE`, `DEPLOY_RUNS_FILE`, live-only `DEPLOY_ENV_OVERRIDES`
  (`platform-delivery.gitlab-ci.yml:3601-3607,3676`), `PREVIEW_SERVICE`, `PREVIEW_PREFIX`, `PREVIEW_BASE`
  (`v1-delivery.gitlab-ci.yml:1111-1112,1151-1152,1195-1196`); `tpl-deploy.yml` reads every one of them by these names
  (`PREVIEW_BASE` is used by lane pipelines' own `.preview-build`). `DEPLOY_ENV_OVERRIDES` is read by
  `deploy-ecs.mjs` from the environment (`main`, `envOverrides`).
- Roles and audiences of plan §7: `scripts/aws/iam/gitlab-oidc-*.json`; consumers `tpl-deploy.yml:60,62,128`
  (`aws:v1:staging`, `aws:platform:staging`, `aws:v1:preview`), `tpl-verify.yml:57,89` (`gl-verify`, `gl-record`,
  lane verify-on-gitlab), `tpl-assist.yml:37,45` (`aws:assist`, `gl-assist`, lane pipelines). The plan names the
  assist role `gl-assist` in §7 and `gl-v1-assist` in §3.9; the §7 table and lane pipelines use `gl-assist`, so this lane
  does too.
- Difference to name for lane pipelines: the generated `preview-upload` job sets `environment.name`, `on_stop` and
  `auto_stop_in` but no `environment.url`, so the merge request shows the environment without a link. The template cannot
  add the URL (it would also reach `preview-upload:main`, which has no environment); the generated job can add
  `url: "https://$PREVIEW_CF_DOMAIN/mr-$CI_MERGE_REQUEST_IID/"`. `preview.mjs` prints the URL in the job log meanwhile.

Staging proof: not verified on staging at merge: nothing deploys on merge (no service reads these files;
`run.mjs check-pr` reports no suite needed, outputs/staging-check-pr.txt). Proven by the tests above and, per plan §9,
by lane `cutover`'s shadow run (the `gl-main/` preview, `shadow-<sha12>` images, rendered task definitions) and the
rehearsal's real staging deploys.

Red on base: outputs/red-on-base.txt — on `origin/main` 19/19 fail (the three script test files fail as whole files,
their modules do not exist); against no-behaviour stubs outside the repo 39/39 fail.
Green: outputs/green.txt — 39/39 pass. UNIT full command (outputs/unit-all.txt): 686 tests, 685 pass, 0 fail, 1 skipped
(pre-existing). Terraform 1.17.1 `fmt -check` and `validate` with M1's `main.tf`: outputs/terraform.txt (valid).
Setup dry run: outputs/setup-gitlab-oidc-dry-run.txt (stub `aws`, 0 write calls).

Waits for M2 fleet (lane eng-gitlab-m2/fleet, claimed by kiro-exafy-202611021438-cff7; no
`origin/kiro/eng-gitlab-m2/fleet` branch at 2026-11-05T17:10Z, so `host/fleet-manager-install.sh` was not created here):
- D4 edit of `infra/gitlab-engineering/host/fleet-manager-install.sh`: one runner block per class — `vitana-eng`
  (untrusted, `idle_count = 4`, max 96), `vitana-eng-main` (max 12), `vitana-eng-deploy` (max 6), each
  `docker-autoscaler` on its own group (`vitana-eng-fleet`, `vitana-eng-fleet-main`, `vitana-eng-fleet-deploy`),
  `capacity_per_instance = 1`, `max_use_count = 1` (single use), `privileged = false` everywhere, seccomp and AppArmor
  unconfined only for the main class's build jobs (either a separate build runner block or `services_security_opt` for
  a BuildKit service, chosen when proven on the M2 image), tokens from
  `vitana/engineering/gitlab/vitana-eng-fleet-{main,deploy}-runner-token` (created by `fleet-classes.tf`).
- The tests of that edit in `fleet-classes-structure.test.mjs` (three runner blocks with their tags, `idle_count = 4`
  and the §5 maxima, single use, `privileged = false`, unconfined only for main-class builds, the main runner registered
  as protected). They are not written as skipped or empty tests; they come with the edit.
- In M2's `fleet.tf` terms (the fleet lane or the edit): SSH ingress to the two class security groups from
  `vitana-eng-fleet-manager` only; the manager role's `SetDesiredCapacity`, `SetInstanceProtection`,
  `TerminateInstanceInAutoScalingGroup` on the two new groups and read of the two token secrets; `fleet_class_ami_id`
  from the M2 job image. Until then the classes are inert (no ingress, so no job machine is used): fail closed.
- `terraform validate` of `fleet-classes.tf` together with `fleet.tf` (done with M1's `main.tf` only).
- D7 rootless builds of the vitana-v1 `Dockerfile` and `services/gateway` on the M2 job image with cold and cached
  times, or the recorded switch to rootless Buildah (plan R5). No working container engine exists in this session
  (podman without conmon), so no local build was recorded either.

Decisions taken (inside the plan):
- The deploy job re-points inline on a stabilise or stamp failure, and `.rollback-staging` (on failure) re-points again
  only when the deploy job did not (killed or timed out), reading `deploy-state.json`; both are idempotent.
- A superseded deploy writes a deploy-runs entry with outcome `superseded` (its own artifact, not a live system); a
  shadow deploy writes `skipped`. "Writes nothing" is read as no ECS or ECR write.
- Services without a build stamp (ERP bridge, Kiro runner, PostgREST proxy) are checked by the ECS primary deployment
  running the new revision; their commit variables are updated only where the live definition already has them.
- `gl-platform-staging` keeps the deploy permissions of `vitana-gha-staging-deploy` for the four platform services and
  drops what the GitLab deploy job does not use (secret describe and token provisioning, the Aurora describe, the
  Bedrock and Appilix managed policies, community-app create): narrower, as "nothing more" asks.
- `ecs:RegisterTaskDefinition` has no resource-level permission in IAM, so it is on `*`; the family is pinned by
  `deploy-ecs.mjs` (community app: `vitana-community-app`; others: the live family), and UpdateService and PassRole stay
  limited, so a registered definition runs nowhere else.
- Secret ARNs use the `-??????` suffix form, so `vitana/ci/test-user` never matches another secret with that prefix.
- No thumbprint is passed to the OIDC provider (optional; IAM verifies the certificate against its trusted CAs).
- The two staging audiences are both requested by the staging jobs and the role is chosen by `CI_PROJECT_PATH`, so no
  audience comes from a variable; the other project's token cannot assume its role (`sub` pins the project path).
- The BuildKit layer cache uses the runner's S3 cache (`type=local`), not ECR: the main class holds no ECR role in
  §7, and giving it one would widen the roles table.
- The deploy class is On-Demand only and the main class 80 % spot (a deploy must not lose its machine mid-rollout).
- DNS egress of the class machines goes to the VPC CIDR only.
- Deploy-class jobs install `awscli` and `skopeo` from Debian at job start (node:20-bookworm); the M2 job image can
  bake them in later.
- GitLab's default maximum artifact size (100 MB) is below an OCI archive; the settings sync must allow at least 2 GB
  (named in the runbook for the settings owner).
