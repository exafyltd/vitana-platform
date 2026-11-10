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
The parts that waited for lane eng-gitlab-m2/fleet are built in round 2 (AC-17 to AC-25, "Round 2: after M2 fleet"):
the fleet manager scales all three classes with one runner block each, SSH from the manager reaches the class
machines, and the manager's role covers the two class groups, their machines and their tokens.

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
with hop limit 1, no public IP, encrypted gp3 with the M1 key, no instance profile (the only IAM resource is the fleet
manager's policy of AC-23), egress tcp 80, tcp 443 and DNS (VPC only), ingress only tcp 22 from the fleet manager; a
quota that is too low makes the check print the request command.
TEST: scripts/eng/fleet-classes-structure.test.mjs "two new groups, main and deploy: …"; "IMDSv2 required with hop limit 1, …"; "no instance policy: the class machines get no instance profile, …"; "egress tcp 80, tcp 443 and DNS only; ingress only tcp 22 from the fleet manager"; "a quota that is too low makes the Terraform check print the request".

AC-15 Plan §3.2 structure rules over every CI file in `infra/gitlab-engineering/ci/`: a job tagged `vitana-eng` declares
no `id_tokens` and names no secret; a job tagged `vitana-eng-deploy` runs no repository script (every `node`/`bash`/`sh`
target is a `$CENTRAL_DIR/` script of platform main; no `npm`, `npx`, `make`, `./`, `source`). Checked also with the
CI files of lanes pipelines and verify-on-gitlab present (outputs/cross-lane-job-classes.txt: 9/9 pass; round 2, with
lane settings' CI files too: 21/21).
TEST: scripts/eng/fleet-classes-structure.test.mjs "a job tagged vitana-eng declares no id_tokens and names no secret"; "a job tagged vitana-eng-deploy runs no repository script".

AC-16 `tpl-deploy.yml` defines the six jobs of plan §9 as hidden jobs: `.build-image` on the main class with no ID
token, rootless BuildKit pinned by digest and `--oci-worker-no-process-sandbox`, never privileged; `.push-image`,
`.deploy-staging`, `.rollback-staging` on the deploy class with exactly the audiences `aws:v1:staging` and
`aws:platform:staging` (the role chosen by project path); `.preview-upload` and `.preview-stop` with only
`aws:v1:preview`; the deploy job's artifacts kept on failure for the rollback job; `build-image.sh` refuses without the
no-process-sandbox flag.
TEST: scripts/eng/fleet-classes-structure.test.mjs "tpl-deploy defines the six jobs of plan §9: build on the main class, the rest on the deploy class"; "build-image.sh refuses without --oci-worker-no-process-sandbox".

Round 2 (after M2 fleet, #4716; D4 `host/fleet-manager-install.sh` and the fleet-dependent parts of D1, D4 and D7):

AC-17 The fleet manager renders three runner blocks, `vitana-eng-fleet` (untrusted, tag `vitana-eng`),
`vitana-eng-fleet-main` (tag `vitana-eng-main`, a protected runner) and `vitana-eng-fleet-deploy` (tag
`vitana-eng-deploy`), each scaling its own group, at the maxima of plan §5 (96 / 12 / 6), the untrusted block with the
warm pool of 4 (`idle_count = 4`) and the classes with none; `concurrent` is the sum and each class has `limit` = its
maximum, so one class never uses up the job slots of another. GitLab binds a runner's tags to its token: each block
takes the token of its own class, and the block's comment names the tag.
TEST: scripts/eng/fleet-classes-structure.test.mjs "the manager renders three runner blocks: vitana-eng on the untrusted group with the warm pool of 4, vitana-eng-main and vitana-eng-deploy on their own groups, at the maxima of plan §5".

AC-18 Every block: one job per machine (`capacity_per_instance = 1`), single use (`max_use_count = 1`),
`privileged = false`, no Docker socket, no privileged service, no extra capability, only the cache volume.
TEST: scripts/eng/fleet-classes-structure.test.mjs "every block: one job per single-use machine, privileged = false, no Docker socket and no extra power".

AC-19 Seccomp and AppArmor are unconfined only for the main class's service containers
(`services_security_opt`), where `.build-image` starts its rootless BuildKit daemon as a service (same pinned image,
`--addr tcp://0.0.0.0:1234 --oci-worker-no-process-sandbox`); no block sets `security_opt`, so every job container of
every class keeps both profiles; `build-image.sh` is the daemon's client over `BUILDKIT_HOST` (it waits for the
service) and keeps the daemonless helper when `BUILDKIT_HOST` is unset; the BuildKit daemon runs only on the main class.
TEST: scripts/eng/fleet-classes-structure.test.mjs "seccomp and AppArmor unconfined only for the main class's build service: no job container of any class loses either profile"; ".build-image starts rootless BuildKit as its service with --oci-worker-no-process-sandbox; the job container is only its client"; "build-image.sh builds through the BuildKit service when BUILDKIT_HOST is set, and with the daemonless helper otherwise".

AC-20 Each block has its own token, once; each class has its own cache path (`vitana-eng-main`, `vitana-eng-deploy`;
the untrusted block keeps M2's), no cache is shared, all use M2's bucket with the M1 key and the manager's signing.
TEST: scripts/eng/fleet-classes-structure.test.mjs "each block has its own token, once, and each class its own cache path: no class reads another class's cache".

AC-21 Fail closed: a class is rendered only when its token is given (no class token gives M2's configuration alone);
a class input that is set but wrong (token kind, group name, a group another block already scales, size 0 or above
999) refuses the whole config, prints nothing on stdout, names the input and never echoes a token.
TEST: scripts/eng/fleet-classes-structure.test.mjs "a class renders only with its token; a wrong class input refuses the whole config, names the input and never echoes a token".

AC-22 Installer: with `/etc/vitana/env.classes` it reads each class token once, from Secrets Manager only (a token in
the env file is ignored), after the untrusted token; it renders the classes that have a token, logs "the class stays
off" for the others (their jobs wait; the untrusted runner starts anyway), writes config.toml with mode 0600 and prints
no token; a class token secret outside `vitana/engineering/gitlab/` is never read and a value that is not a `glrt-`
token is never written. Without the file nothing changes (M2's flow, AC-25).
TEST: scripts/eng/fleet-classes-structure.test.mjs "installer with the class env file of step A2: reads each class token once after the untrusted one, renders the classes that have one, leaves the others off, prints no token"; "installer: a class token secret outside vitana/engineering/gitlab/ is never read, and a value that is not a runner token is never written".

AC-23 Terraform, in `fleet-classes.tf` only (M2's `fleet.tf` is not edited): each class group takes tcp 22 from the
manager's group and the manager's group may go out on tcp 22 to each class group, nothing more; the manager role
(M2) gets one inline policy: SetDesiredCapacity, SetInstanceProtection and TerminateInstanceInAutoScalingGroup on the
two class groups only, SendSSHPublicKey on instances of the two groups as `ubuntu` only, GetSecretValue on the two
class token secrets only (describe and the M1 key's Decrypt are already in M2's policy); the class machines run the M2
job image; the groups launch through M2's custom-suffix Auto Scaling role, which holds the grant on the M1 key, after
both key grants; `force_delete`; the class secrets have no recovery window.
TEST: scripts/eng/fleet-classes-structure.test.mjs "egress tcp 80, tcp 443 and DNS only; ingress only tcp 22 from the fleet manager"; "the fleet manager may scale only the two class groups, open SSH only to their machines as ubuntu, and read only their two runner tokens"; "the classes run on the M2 job image and launch through the Auto Scaling role that holds the key grant".

AC-24 Step A2 of the runbook gives the manager exactly the groups, sizes and token secrets of `fleet-classes.tf`
(`/etc/vitana/env.classes`) and the untrusted sizes of plan §3.2 (96, warm pool 4) both as M2 variables in
`terraform.tfvars` and in the manager's `/etc/vitana/env`, then runs the installer again; the class runners in GitLab
and their tokens come from the settings sync (open item below).
TEST: scripts/eng/fleet-classes-structure.test.mjs "step A2 gives the manager the groups, sizes and token secrets of fleet-classes.tf, and the untrusted sizes of plan §3.2".

AC-25 M2's own tests stay green with the edited installer: without the class file or class tokens the rendered
config, the token rules, the env-file contract and the stub-command flow of M2 are unchanged.
TEST: scripts/eng/fleet-structure.test.mjs (M2 lane fleet, not edited) — 38 tests, 38 pass (outputs/m2-fleet-tests.txt).

States: role missing → `could not sign in as role gl-…`, exit 4, nothing written (AC-7); outside the allowlist → exit 2,
no call (AC-3, AC-9, AC-10); superseded → exit 0, no ECS write, entry `superseded` (AC-4); not stable or wrong stamp →
rollback to the captured revision, entry `rolled_back`, job red (AC-5); rollback failed → entry `failed`, job red,
`.rollback-staging` retries (AC-6); shadow mode → only `shadow-<sha12>` images, rendered definitions and the `gl-main/`
preview (AC-2, AC-9, AC-10); a closed merge request → `.preview-stop` removes `mr-<iid>/` (AC-10); quota too low → the
Terraform check prints the request (AC-14); a class without a runner token → that class stays off and its jobs wait,
the untrusted runner starts anyway (AC-21, AC-22); a wrong class input → no config, the input named (AC-21); the
BuildKit service not answering → the build stops after 2 minutes and says so (AC-19).
Surfaces: GitLab main-class and deploy-class jobs (`tpl-deploy.yml`); the fleet manager's `config.toml` (three runner
blocks) and `/etc/vitana/env.classes`; the staging ECR repositories and ECS services of
plan §3.10 (`Vitana-ECS-Cluster`: `vitana-community-app-staging`, `vitana-gateway`, `vitana-erp-bridge`,
`vitana-kiro-runner`, `vitana-postgrest-aurora-proxy`); `s3://vitana-pr-previews` (`mr-*`, `gl-main/*`); the preview
CloudFront distribution; IAM (owner's apply only).
Locales: n/a. Accessibility: n/a.

Contract:
- Deploy-runs file: writer `scripts/eng/deploy/lib.mjs:127` (`writeDeployRun`, outcomes at `:125`), called by
  `scripts/eng/deploy/deploy-ecs.mjs:226` (`deploy`) and `:316` (`rollback`); reader
  `origin/kiro/agentic-delivery/verify-on-gitlab:scripts/ci/staging-verify/run.mjs:208` (`deployRunsFromEntries`: keys
  service, sha, started_at, finished_at, outcome; `skipped` ignored by `deployCutoff`, `scripts/ci/staging-verify/lib.cjs:475`).
  The file path is `$CI_PROJECT_DIR/deploy-runs.json` on both sides (`tpl-deploy.yml:105-117` writes it as an artifact,
  `tpl-verify.yml:56` reads `DEPLOY_RUNS_FILE`).
- Job names of plan §9: `tpl-deploy.yml:30` `.build-image`, `:91` `.push-image`, `:105` `.deploy-staging`, `:119`
  `.rollback-staging`, `:157` `.preview-upload`, `:164` `.preview-stop`; extended by lane pipelines at
  `v1-delivery.gitlab-ci.yml:1312,1356,1434,1943,1982,2024,2067` and the same names in `platform-delivery.gitlab-ci.yml`
  (`origin/kiro/agentic-delivery/pipelines` at `d5b609bf88`).
- Variables: lane pipelines passes `DEPLOY_SERVICE`, `DEPLOY_ECR_REPOSITORY`, `DEPLOY_IMAGE_CONTEXT`,
  `DEPLOY_DOCKERFILE`, `DEPLOY_ECS_CLUSTER`, `DEPLOY_ECS_SERVICE`, `DEPLOY_RUNS_FILE`, live-only `DEPLOY_ENV_OVERRIDES`
  (`platform-delivery.gitlab-ci.yml:3679-3685,3754`), `PREVIEW_SERVICE`, `PREVIEW_PREFIX`, `PREVIEW_BASE`
  (`v1-delivery.gitlab-ci.yml:1281-1282,1321-1322,1365-1366`); `tpl-deploy.yml` reads every one of them by these names
  (`PREVIEW_BASE` is used by lane pipelines' own `.preview-build`). `DEPLOY_ENV_OVERRIDES` is read by
  `deploy-ecs.mjs` from the environment (`main`, `envOverrides`).
- Roles and audiences of plan §7: `scripts/aws/iam/gitlab-oidc-*.json`; consumers `tpl-deploy.yml:71,73,139`
  (`aws:v1:staging`, `aws:platform:staging`, `aws:v1:preview`), `tpl-verify.yml:57,89` (`gl-verify`, `gl-record`,
  lane verify-on-gitlab), `tpl-assist.yml:37,45` (`aws:assist`, `gl-assist`, lane pipelines). The plan names the
  assist role `gl-assist` in §7 and `gl-v1-assist` in §3.9; the §7 table and lane pipelines use `gl-assist`, so this lane
  does too.
- Runner classes on the manager (round 2): the owner's step A2 writes `/etc/vitana/env.classes`
  (`RUNBOOK-delivery-aws.md:93-99`); the installer reads it and the class token secrets
  (`host/fleet-manager-install.sh:241`) and renders the class blocks (`:70, called at :188`); the group and secret
  names are Terraform's (`fleet-classes.tf:43` `local.fleet_classes`, `:217` the secrets).
- M2 names used by `fleet-classes.tf` (M2's files not edited): `aws_security_group.fleet_manager` (`fleet.tf:158`),
  `aws_iam_role.fleet_manager` (`fleet.tf:261`), `aws_iam_service_linked_role.fleet_autoscaling`
  (`fleet.tf:122`), `aws_kms_grant.fleet_autoscaling` and `.fleet_spot` (`fleet.tf:133, 140`),
  `aws_imagebuilder_image.fleet` (`fleet-ami.tf:127`); used at `fleet-classes.tf:116, 124, 135, 180, 212, 257`.
- BuildKit service: `tpl-deploy.yml:34-43` (service, alias `buildkitd`, `BUILDKIT_HOST`) and
  `scripts/eng/deploy/build-image.sh:53` (reads `BUILDKIT_HOST`); the main block's
  `services_security_opt` at `host/fleet-manager-install.sh:108`.
- Difference to name for lane pipelines: the generated `preview-upload` job sets `environment.name`, `on_stop` and
  `auto_stop_in` but no `environment.url`, so the merge request shows the environment without a link. The template cannot
  add the URL (it would also reach `preview-upload:main`, which has no environment); the generated job can add
  `url: "https://$PREVIEW_CF_DOMAIN/mr-$CI_MERGE_REQUEST_IID/"`. `preview.mjs` prints the URL in the job log meanwhile.

Staging proof: not verified on staging at merge: nothing deploys on merge (no service reads these files;
`run.mjs check-pr` reports no suite needed, outputs/staging-check-pr.txt). Proven by the tests above and, per plan §9,
by lane `cutover`'s shadow run (the `gl-main/` preview, `shadow-<sha12>` images, rendered task definitions) and the
rehearsal's real staging deploys.

Red on base, round 1: outputs/red-on-base.txt — on `origin/main` 19/19 fail (the three script test files fail as whole
files, their modules do not exist); against no-behaviour stubs outside the repo 39/39 fail. Green, round 1:
outputs/green.txt — 39/39 pass.
Red on base, round 2: outputs/red-on-base-fleet.txt — `fleet-classes-structure.test.mjs` on the branch after merging
`origin/main` with M2 fleet (`df45b674ec`, origin/main `f5dd5eb94b` merged in), before the round-2 change: 14 of 21 fail (the 12 new tests and the 2 whose interim assertions round 2 replaces), the 7 unchanged tests pass.
Green, round 2: outputs/green-fleet.txt — 21 of 21 pass. M2's `fleet-structure.test.mjs` with the edited installer:
outputs/m2-fleet-tests.txt (38 of 38 pass). The five test files of this lane: 51 of 51 pass. UNIT full command
(outputs/unit-all.txt): 971 tests, 970 pass, 0 fail, 1 skipped (pre-existing, win32 only). Terraform 1.17.1 `fmt -check` and `validate` of `fleet-classes.tf` with M2's
`fleet.tf` and `fleet-ami.tf` and M1's `main.tf` and `monitoring.tf`: outputs/terraform.txt (valid). Cross-lane:
outputs/cross-lane-job-classes.txt (21 of 21 with the CI files of lanes pipelines `d5b609bf88`, verify-on-gitlab `194f308f9b` and M2 settings `d28e8c960a`; verify-on-gitlab's `tpl-verify-structure.test.mjs` on the same directory 10 of 10).
Setup dry run: outputs/setup-gitlab-oidc-dry-run.txt (stub `aws`, 0 write calls).

Round 2: after M2 fleet (#4716 merged as `f5dd5eb94b`). Built: the class runner blocks and the class step of
`host/fleet-manager-install.sh` (AC-17 to AC-22, AC-25), SSH from the fleet manager, the manager's policy for the two
classes, the M2 job image and the Auto Scaling role with the key grant in `fleet-classes.tf` (AC-23), the BuildKit
service of `.build-image` with `build-image.sh` as its client (AC-19), step A2 of the runbook (AC-24), and `terraform
validate` with `fleet.tf`. Still open (each needs something this lane cannot do here):
- D7 rootless builds of the vitana-v1 `Dockerfile` and `services/gateway` on the M2 job image, with cold and cached
  times, or the recorded switch to rootless Buildah (plan R5): no working container engine exists in this session
  (podman without conmon, outputs of round 1), so the rehearsal (A4) proves it on a main-class machine. Two things to
  check there: Ubuntu 24.04 limits unprivileged user namespaces for processes without an AppArmor profile
  (`kernel.apparmor_restrict_unprivileged_userns`), which the rootless daemon needs, so the M2 job image may need
  that setting (a change to M2's `host/fleet-image/component.yml`, outside this lane) or the switch to Buildah; and
  GitLab's BuildKit guide advises a seccomp profile that allows only the calls BuildKit needs instead of
  `seccomp=unconfined` (https://docs.gitlab.com/ci/docker/using_buildkit/), a narrower alternative for the same service.
- The class runners in GitLab and their tokens: the settings sync must create `vitana-eng-fleet-main` (tag
  `vitana-eng-main`, protected: `access_level` `ref_protected`) and `vitana-eng-fleet-deploy` (tag `vitana-eng-deploy`)
  and store their tokens in `vitana/engineering/gitlab/vitana-eng-fleet-{main,deploy}-runner-token`. Today its schema
  allows the runners `legacy` and `fleet` only (`origin/kiro/eng-gitlab-m2/settings:scripts/eng/gitlab-settings.mjs:69`, `SCHEMA_KEYS.runners`,
  lane eng-gitlab-m2/settings, PR #4711), and no lane's tasks name the class runners: late lane `cut-settings`
  (VTID-05562, `ready`, after `cutover`) owns `gitlab-settings.mjs` and `gitlab-settings.json` for "the settings the cut
  needs that no lane builds yet", and is the natural place (recommendation for the driver: add the two class runners
  and their token secrets to its tasks). Until then the classes stay off (AC-22), and the D1 item "the main class
  registered as a protected runner" cannot be tested in this lane's files: the protection is a property of the runner
  in GitLab, not of `config.toml`.
- Applying it: the owner's steps A1 and A2 (nothing here was run against AWS or GitLab).

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

Decisions taken in round 2 (inside the plan):
- Seccomp and AppArmor for builds: the acceptance of round 1 left two options, a separate build runner block or
  `services_security_opt` for a BuildKit service. A separate block would need a fourth group (two runner blocks cannot
  scale one group) and breaks "three runner blocks", so the BuildKit daemon of `.build-image` became the job's service
  and only the main block sets `services_security_opt`; no block sets `security_opt`, so no job container of any class
  loses a profile. `services_security_opt` is the runner's option for service containers only (`DockerConfig` field
  `ServicesSecurityOpt`, used by `createHostConfigForService`; gitlab-runner MR !3760, runner 15.10,
  https://gitlab.com/gitlab-org/gitlab-runner/-/merge_requests/3760); the values use Docker's `=` form. Residual, named
  for the reviewer: `services_security_opt` applies to every service of a main-class
  job, and lane pipelines' main-class jobs also start `postgres:16` services (21 jobs in `platform-delivery.gitlab-ci.yml`,
  2 in `v1-delivery.gitlab-ci.yml` at `d5b609bf88`), which then run without the two profiles too (unprivileged, no
  added capability, single-use machine without an instance profile). The narrower fix is the custom seccomp profile of
  the open D7 item.
- The class inputs reach the manager in `/etc/vitana/env.classes`, written by the owner's step A2 with `ssm
  send-command` (the pattern of `RUNBOOK-m2-fleet.md` sections 3 and 6). `/etc/vitana/env` is written by M2's
  `fleet.tf` user data, which this lane does not edit and which never runs again on a running manager; the class
  inputs are named `CLASS_*`, not `FLEET_*`, so M2's test that the env file and the installer name the same `FLEET_*`
  variables stays exact.
- Class tokens are read once (no 24-hour wait like the untrusted token): a class without a token stays off and the
  untrusted runner, which the owner may already use, starts as before. Re-running the installer adds the class.
- `concurrent` is the sum of the blocks' maxima and each class block has `limit` = its maximum (plan §5 fairness: one
  class never takes another's job slots); M2's untrusted block is unchanged.
- Each class block sets its own cache `Path` (`vitana-eng-main`, `vitana-eng-deploy`) on M2's bucket, and none sets
  `Shared`: GitLab already keys cache paths by runner token, the explicit path keeps the main class's BuildKit layer
  cache apart from anything a merge-request job could write.
- The class groups launch through M2's custom-suffix Auto Scaling role (`aws_iam_service_linked_role.fleet_autoscaling`)
  after both key grants: with the default role, which has no grant on the M1 key, every launch would fail with
  `Client.InternalError` (M2's reason, `fleet.tf` "key access"). `force_delete` and `recovery_window_in_days = 0`
  follow M2's pattern (a destroy is not blocked by protected machines; a destroyed class can be applied again).
- The variable `fleet_class_ami_id` and its precondition (round 1: fail closed until the image exists) are replaced by
  M2's image (`aws_imagebuilder_image.fleet`), so the classes and the untrusted fleet run the same job image.
- Two assertions of this lane's own round-1 tests pinned the interim state that round 1 said would change ("no IAM
  resource", "no ingress"); round 2 replaces them with exact lists (the one IAM policy and its attachment; the six rule
  shapes including SSH from the manager). No assertion was loosened: each is now an exact match.
- The untrusted class's plan sizes (96, warm pool 4) are M2 variables: step A2 sets them in `terraform.tfvars` and on
  the manager; M2's defaults (24, 0) stay as they are.
- Re-running the installer restarts the runner (M2's flow), so step A2 says to run it before the cut, when no job runs.
