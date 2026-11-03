# Tasks — eng-gitlab-m1
Authoritative plan: `plan.md`. VTIDs from CI PLAN-SPAR. Branches `kiro/eng-gitlab-m1/<lane>`; PR titles
`VTID-xxxxx (eng-gitlab-m1/<lane>): …`; trailers `Collab-Session` and `Collab-Lane: eng-gitlab-m1/<lane>`; identity
`kiro-agent[bot]`; evidence in `docs/validation/<VTID>/`.

<!-- lane: gitlab-infra -->
## Lane `gitlab-infra` (vitana-platform)
- [ ] I1 Write `services/gateway/test/eng-gitlab-m1-infra.test.ts`; record it red on base.
- [ ] I2 Terraform in `infra/gitlab-engineering/`: versions and state backend, VPC and subnets, NAT, load balancer and
      certificate, GitLab and runner machines, security groups, backup bucket, state bucket, KMS keys, IAM roles,
      Secrets Manager entries, outputs (DNS records).
- [ ] I3 Bootstrap templates: GitLab Omnibus with the pinned version, runner install and registration, nightly backup.
- [ ] I4 Runbook `infra/gitlab-engineering/RUNBOOK.md`: owner steps 1–8 of `plan.md` §6, exact commands.
- [ ] I5 Evidence: test red then green; `terraform fmt -check` and `terraform validate` output; the monthly cost estimate.

**Acceptance**
- Change types: Infrastructure/CI.
- Outcome: the owner can create the GitLab and runner machines with one reviewed Terraform run, and both are private.
- States: n/a: infrastructure code.
- Surfaces: `infra/gitlab-engineering/` only.
- Locales: n/a. Accessibility: n/a.
- Contract: plan §3 values exactly (CIDR, instance types, names, ports, secret names).
- Staging proof: not verified on staging: no product path changes. The verification is the owner's first apply and
  plan §6 steps 6–8.
- No secret value in Git or in Terraform outputs; the root password is generated and stored in Secrets Manager.

<!-- lane: gitlab-ci -->
## Lane `gitlab-ci` (vitana-platform and vitana-v1)
- [ ] C1 Write the two per-repository tests (`eng-gitlab-m1-ci.test.ts` in each repository); record them red on base.
- [ ] C2 `.gitlab-ci.yml` in vitana-platform: typecheck, the Jest suite in parallel shards, build. Commands and Node
      version from the repository's own scripts and `CICDL-GATEWAY-CI.yml`.
- [ ] C3 `.gitlab-ci.yml` in vitana-v1: lint, the test script, build.
- [ ] C4 Mirror pipeline in `infra/gitlab-engineering/mirror/.gitlab-ci.yml` (scheduled, every 5 minutes, all branches).
- [ ] C5 Evidence: tests red then green; local run of each job's commands where the sandbox allows; the job list.

**Acceptance**
- Change types: Infrastructure/CI.
- Outcome: each mirrored branch gets the same checks as on GitHub, on our runner, without AWS access.
- States: n/a.
- Surfaces: the two `.gitlab-ci.yml` files and the mirror file.
- Locales: n/a. Accessibility: n/a.
- Contract: every job has the `vitana-eng` tag; no AWS name in any job; every run line exists in the repository.
- Staging proof: not verified on staging: CI configuration only. The verification is the first green pipeline on each
  GitLab project (plan §6 step 7).
