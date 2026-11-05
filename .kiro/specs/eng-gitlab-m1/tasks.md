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
- [ ] I4 Evidence the lane produces itself: test red then green; the mutation run (each property broken once in a scratch copy, the test
      must go red); the two gateway commands of plan §5 with their output (`pnpm install` then `pnpm run typecheck` fails with TS2664,
      `npm ci` then `pnpm run typecheck` passes); `terraform fmt -check` and `terraform validate`; the monthly cost estimate; the
      comparison of every file with the archive the owner ran. The owner's runs of plan §6 steps 0 to 3 (the first green pipeline of
      each mirrored project next to GitHub's result for the same `main` commit, the backup listing, the restore result, pasted output)
      are the evidence of the late lane `gitlab-verify`, which depends on this lane.

**Acceptance**
- Change types: Infrastructure/CI, Tooling/docs.
- Outcome: the owner can rebuild the same GitLab from git with one reviewed Terraform run and `setup.sh`, and knows how to
  restore it; the platform's central CI file in git is the corrected one. The green pipelines of the mirrored repositories on our
  own runner are the Outcome of lane `gitlab-verify`.
- States: the corrected platform CI file not yet pasted into GitLab (the type check job fails until the owner does step 0 of
  plan §6); AWS account not yet activated (the script waits); low EC2 vCPU limit (smaller machines, `grow` later); DNS record
  late (the runner waits and `setup.sh runner` registers it); GitHub token missing (the mirror idles and says so).
- Surfaces: `infra/gitlab-engineering/`, `scripts/eng/gitlab-m1-structure.test.mjs`; no product code.
- Locales: n/a. Accessibility: n/a.
- Contract: plan §3 values exactly (names, sizes, ports, secret names); the files are what runs today, except the install steps
  of `host/ci-platform.yml` (plan §4).
- Staging proof: not verified on staging: no product path changes. Verification: the structure test and the evidence of I4.
  The owner's runs of plan §6 steps 0 to 3 and acceptance A01 to A05 as plan §9 states them are recorded by lane `gitlab-verify`
  (it depends on this lane); the plan is `done` only when both lanes are.
- No secret value in git or in Terraform outputs; the Cloudflare and GitHub tokens are typed hidden and kept in memory or
  in Secrets Manager only.

<!-- lane: gitlab-verify -->
## Lane `gitlab-verify` (vitana-platform; late lane)
- [ ] V1 Give the owner one message with the exact steps of plan §6 steps 0 to 3 from `infra/gitlab-engineering/RUNBOOK.md`
      (sections 6 to 8) as they are on `main`: paste the corrected `platform.gitlab-ci.yml` into GitLab; run a pipeline on both
      mirrored projects; list the backup bucket after 02:15 UTC; run the restore test. Nothing in the message is a routine step.
- [ ] V2 Record the owner's pasted output in `docs/validation/<VTID>/outputs/`: for steps 0 and 1 each GitLab job result next to
      GitHub's result for the same `main` commit (GitHub's side is read with `gh api`, read only) and a note for every difference;
      the backup listing; the output of RUNBOOK section 8 steps B and C.
- [ ] V3 If a pipeline or a RUNBOOK command fails: fix `host/ci-platform.yml`, `host/ci-v1.yml` or `RUNBOOK.md` in this lane, in the
      same PR, and say so in the evidence. Never loosen a check to get green. A failure that needs a file outside the lane's `paths`
      is a new lane added through `_plan` (a `done` lane is never reopened).
- [ ] V4 `acceptance.md` maps A01 to A05 of plan §9 to the recorded output, one `AC-` entry each with a `TEST:` line; the PR body says
      "not verified on staging" with the reason.

**Acceptance**
- Change types: Infrastructure/CI, Tooling/docs.
- Outcome: the running GitLab is shown to do what plan §9 says: HTTPS with a valid certificate (A01), rebuildable from git (A02, with
  lane `gitlab-infra`), an encrypted nightly backup that exists (A03), a restore that reproduces the project count and one commit hash
  (A04), a runner that runs jobs (A05), and the first green pipelines of both mirrored projects next to GitHub's results.
- States: the owner has not run a step yet (the lane waits); a pipeline fails on GitLab and passes on GitHub (recorded as a difference,
  then fixed under V3); the restore fails (the RUNBOOK is fixed under V3); the backup bucket is empty after 02:15 UTC (a finding for
  `backup.sh`, fixed through `_plan`).
- Surfaces: `docs/validation/<VTID>/`; `host/ci-platform.yml`, `host/ci-v1.yml` and `RUNBOOK.md` only when a run shows a defect.
- Locales: n/a. Accessibility: n/a.
- Contract: no run is made from a session; every output is pasted by the owner from CloudShell or the GitLab pages; no write to a
  live system from session tools; no secret in the pasted output (token values are removed before they are committed).
- Staging proof: not verified on staging: no product path changes. The evidence is the owner's runs against the live GitLab.
