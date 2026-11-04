# Tasks — eng-gitlab-m1
Authoritative plan: `plan.md`. VTID from CI PLAN-SPAR. Branch `kiro/eng-gitlab-m1/gitlab-infra`; PR title
`VTID-xxxxx (eng-gitlab-m1/gitlab-infra): …`; trailers `Collab-Session` and `Collab-Lane: eng-gitlab-m1/gitlab-infra`;
identity `kiro-agent[bot]`; evidence in `docs/validation/<VTID>/`. Node tests: `node --test scripts/eng/*.test.mjs`
(dependency-free; `UNIT.yml` runs them on every PR).

<!-- lane: gitlab-infra -->
## Lane `gitlab-infra` (vitana-platform)
- [ ] I1 Write `scripts/eng/gitlab-m1-structure.test.mjs` (plan §5), including the pin of the exact job scripts of
      `host/ci-platform.yml` and the check that RUNBOOK section 6 embeds that file unchanged; record it red on base.
- [ ] I2 Commit the running bundle to `infra/gitlab-engineering/` unchanged in behaviour: `setup.sh`, `terraform/main.tf`,
      `host/*.sh`, `host/ci-platform.yml`, `host/ci-v1.yml`. Fix only what the test or review shows. One correction is already
      known and in scope: `host/ci-platform.yml` installs the gateway with `npm ci --no-audit --no-fund` in the `typecheck` job and
      with `pnpm install --frozen-lockfile` in the `gateway-jest` job, and has no shared install (plan §3, premises P6 and P10).
- [ ] I3 `infra/gitlab-engineering/RUNBOOK.md`: owner steps, the `setup.sh` commands, how to read `status`, the restore
      procedure (scratch machine from the latest backup, compare project count and one commit hash), and a "Not built yet"
      list (the items of plan §10: CloudTrail, Config, Security Hub, RDS and ElastiCache, object storage, AWS Backup, bot-only
      `main` protection, the unported GitHub checks).
- [ ] I4 Evidence: test red then green; the mutation run (each property broken once in a scratch copy, the test must go red);
      the two gateway commands of plan §5 with their output (`pnpm install` then `pnpm run typecheck` fails with TS2664, `npm ci`
      then `pnpm run typecheck` passes); `terraform fmt -check` and `terraform validate`; the monthly cost estimate; the first
      green pipeline of each mirrored project next to GitHub's result for the same `main` commit; the backup listing; the
      restore result (owner steps, pasted output).

**Acceptance**
- Change types: Infrastructure/CI, Tooling/docs.
- Outcome: the owner can rebuild the same GitLab from git with one reviewed Terraform run and `setup.sh`, and knows how to
  restore it; the mirrored repositories get green pipelines on our own runner.
- States: the corrected platform CI file not yet pasted into GitLab (the type check job fails until the owner does step 0 of
  plan §6); AWS account not yet activated (the script waits); low EC2 vCPU limit (smaller machines, `grow` later); DNS record
  late (the runner waits and `setup.sh runner` registers it); GitHub token missing (the mirror idles and says so).
- Surfaces: `infra/gitlab-engineering/`, `scripts/eng/gitlab-m1-structure.test.mjs`; no product code.
- Locales: n/a. Accessibility: n/a.
- Contract: plan §3 values exactly (names, sizes, ports, secret names); the files are what runs today, except the install steps
  of `host/ci-platform.yml` (plan §4).
- Staging proof: not verified on staging: no product path changes. Verification: the structure test, the owner's runs of plan
  §6 steps 1 to 3, and acceptance A01 to A05 as plan §9 states them.
- No secret value in git or in Terraform outputs; the Cloudflare and GitHub tokens are typed hidden and kept in memory or
  in Secrets Manager only.
