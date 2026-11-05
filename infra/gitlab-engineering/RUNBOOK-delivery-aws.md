# Runbook: GitLab delivery on AWS (plan agentic-delivery §3.2, §3.6, §3.7, §3.8, §7, §10; VTID-05546)

GitLab builds the images of both repositories without a privileged daemon, pushes them by digest, deploys them to
staging, rolls back a deploy that does not serve, and publishes vitana-v1 merge-request previews. Jobs sign in to AWS
with a short-lived per-job ID token; no AWS key exists on the GitLab side. Production is not touched by anything here:
it stays the owner's PUBLISH.

Files: `ci/tpl-deploy.yml` (the six jobs), `terraform/fleet-classes.tf` (runner classes main and deploy),
`scripts/eng/deploy/` (build, push, deploy, rollback, previews, target-group setup), `scripts/aws/setup-gitlab-oidc.sh`
and `scripts/aws/iam/gitlab-oidc-*.json` (the OIDC provider and the six roles).

## A1. Sign-in to AWS, secrets, target groups (owner, CloudShell, account 472838866351, eu-central-1)

1. Dry run first. It only reads and prints every call it would make:

   ```bash
   git clone https://github.com/exafyltd/vitana-platform.git && cd vitana-platform
   scripts/aws/setup-gitlab-oidc.sh --preview-distribution-id <value of vitana-v1 secret PREVIEW_CF_DISTRIBUTION_ID>
   ```

   Read the output: `[READ]` lines ran; `[DRY-RUN]` lines are the exact calls `--apply` makes. It stops unless the
   account is `472838866351` and the region `eu-central-1`.
2. Apply: the same command with `--apply`. It creates or updates:
   - the IAM OIDC provider `https://gitlab.vitanaland.com` with the audiences `aws:v1:staging`, `aws:platform:staging`,
     `aws:v1:preview`, `aws:verify`, `aws:record`, `aws:assist`;
   - the roles of plan §7, each with its trust (`aud` pinned with StringEquals, `sub` pinned to the project path and
     ref) and one inline policy:

     | Role | aud | sub (`project_path:<path>:ref_type:branch:ref:<ref>`) | May |
     |---|---|---|---|
     | `gl-v1-staging` | `aws:v1:staging` | `vitana/vitana-v1` `main` | push ECR `vitana/community-app`; update `vitana-community-app-staging`; pass its task roles |
     | `gl-platform-staging` | `aws:platform:staging` | `vitana/vitana-platform` `main` | push ECR `vitana/{gateway,erp-bridge,kiro-runner,postgrest-aurora-proxy}`; update those four staging services; pass their task roles |
     | `gl-v1-preview` | `aws:v1:preview` | `vitana/vitana-v1` any branch | `vitana-pr-previews/mr-*` and `gl-main/*`; invalidate the preview distribution |
     | `gl-verify` | `aws:verify` | both projects, `main` | read `vitana/ci/test-user` |
     | `gl-record` | `aws:record` | both projects, `main` | read `vitana/ci/oasis-recorder`, `vitana/ci/gateway-service-token` |
     | `gl-assist` | `aws:assist` | `vitana/vitana-v1` `assist/*` and `main` | read `vitana/ci/llm-keys` |

     `ecs:RegisterTaskDefinition` and `ecs:DescribeTaskDefinition` have no resource-level permissions in IAM, so they
     are on `*`; `ecs:UpdateService` is limited to the role's own staging services and `iam:PassRole` to the task
     roles those services run with now, so a registered definition cannot run anywhere else.
   - the staging target groups' deregistration delay to 30 seconds (`scripts/eng/deploy/staging-tg-setup.sh`, called
     by the setup script in the same mode), so a staging service stabilises in a few minutes.
3. Fill the secrets it lists as `NEEDS A VALUE` (each is JSON keyed by the GitHub secret names it replaces):

   | Secret | Read by | Keys |
   |---|---|---|
   | `vitana/ci/test-user` | `.staging-verify` (`gl-verify`) | the test-user secrets STAGING-VERIFY uses on GitHub |
   | `vitana/ci/oasis-recorder` | `.record` (`gl-record`) | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE` |
   | `vitana/ci/gateway-service-token` | `.vtid-close` (`gl-record`) | `GATEWAY_SERVICE_TOKEN` |
   | `vitana/ci/llm-keys` | `.assist` (`gl-assist`) | the LLM keys I18N-PROPAGATE uses on GitHub |

   ```bash
   aws secretsmanager put-secret-value --region eu-central-1 --secret-id <name> --secret-string file://<json file>
   ```
4. GitLab CI variables (not secrets) for the preview jobs: `PREVIEW_CF_DISTRIBUTION_ID`, `PREVIEW_CF_DOMAIN`.

## A2. Runner classes (owner, the M2 entry point)

`terraform/fleet-classes.tf` adds two Auto Scaling groups next to M2's untrusted fleet:

| Class | Group | Tag | Max | Machines |
|---|---|---|---|---|
| main | `vitana-eng-fleet-main` | `vitana-eng-main` (protected runner) | 12 | single use, 80 % spot |
| deploy | `vitana-eng-fleet-deploy` | `vitana-eng-deploy` | 6 | single use, On-Demand only |

Both: min 0 and desired 0 (the runner scales them), IMDSv2 with hop limit 1, no public IP, no instance profile, egress
80, 443 and DNS only. Apply with the M2 entry point and set `fleet_class_ami_id` to the M2 job image. A vCPU quota that
is too low makes the Terraform check print the exact `aws service-quotas request-service-quota-increase` command; run
it and apply again when AWS has raised the quota. Grow the GitLab host to m6i.2xlarge with M1 `setup.sh grow`.

Until the M2 fleet lane is on `main`, these parts wait (they live in M2's files): the fleet manager's runner blocks for
the two classes (`host/fleet-manager-install.sh`), SSH from the fleet manager to the class machines, and the manager's
permissions on the two groups. The settings sync must also allow job artifacts of at least 2 GB (the OCI archives).

## How a deploy runs, and how to read a failed one

`build-image:<svc>` (main) → `push-image:<svc>` (deploy) → `deploy-staging:<svc>` (deploy) → on failure
`rollback-staging:<svc>` (deploy) → `staging-verify:<svc>` (main, lane verify-on-gitlab).

| Job log says | Meaning | What to do |
|---|---|---|
| `could not sign in as role gl-…` (exit 4) | the role is missing or its trust does not match the job | run A1 `--apply`; check the project path and ref of the pipeline |
| `… outside the staging allowlist of plan §3.10 … refused` (exit 2) | the job named a service, cluster or repository that is not a staging target | fix the service list (lane pipelines); nothing was written |
| `SUPERSEDED: staging already serves …` (exit 0) | a newer landing is already deployed; nothing written | none; that landing's own verification covers this commit |
| `SHADOW: rendered …` (exit 0) | `DELIVERY_MODE` is not `live`; the rendered definition and its diff are in the `deploy-out/` artifact | none before the cut |
| `ROLLED BACK …: not stable` / `does not serve` (exit 1) | the new revision did not stabilise or did not serve its build stamp; the service is back on the captured revision | read the ECS service events and the task logs of the failed revision, then fix forward |
| `FAILED: … the rollback failed too` (exit 1) | the re-point did not finish; `rollback-staging` retries it from `deploy-state.json` | check `rollback-staging`; if it is red too, re-point by hand to `captured_task_definition` in the artifact |

Artifacts of `deploy-staging`: `deploy-runs.json` (`[{service, sha, started_at, finished_at, outcome}]`, read by
STAGING-VERIFY), `deploy-state.json` (the captured revision and the phase reached), `deploy-out/task-definition.json`
and `deploy-out/task-definition.diff.json`.

## Previews

`preview-build` (untrusted) builds `--base=/mr-<iid>/` against the staging gateway; `preview-upload` (deploy) writes
`s3://vitana-pr-previews/mr-<iid>/` and invalidates `/mr-<iid>/*`; the environment `review/mr-<iid>` stops on close and
`preview-stop` removes only that prefix. Before the cut only `gl-main/` is written (shadow). GitHub previews keep
`pr-<n>/`.

## Drain a class

1. Pause new jobs of the class: GitLab Admin → CI/CD → Runners → the runner tagged `vitana-eng-main` or
   `vitana-eng-deploy` → Pause (jobs wait in the queue; nothing is lost).
2. Wait until its running jobs finish (Runners → Jobs). A deploy job must finish or roll back; never cancel one
   mid-rollout (if you must, run its `rollback-staging` job by hand).
3. Set the group to zero: `aws autoscaling update-auto-scaling-group --region eu-central-1 --auto-scaling-group-name
   vitana-eng-fleet-main --max-size 0` (or `vitana-eng-fleet-deploy`). Single-use machines end with their job.
4. Undo: set `--max-size` back to 12 or 6 (or apply Terraform again) and unpause the runner.
