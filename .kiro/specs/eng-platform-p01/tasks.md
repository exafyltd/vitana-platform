# Tasks — eng-platform-p01
Authoritative plan: `plan.md`. VTIDs from CI PLAN-SPAR. Branch `kiro/eng-platform-p01/<lane>`; PR title
`VTID-xxxxx (eng-platform-p01/<lane>): …`; trailers `Collab-Session` + `Collab-Lane: eng-platform-p01/<lane>`; identity
`kiro-agent[bot]`; evidence in `docs/validation/<VTID>/`.

<!-- lane: program-doc -->
## Lane `program-doc` (vitana-platform)
- [ ] P1 Write `docs/ENGINEERING-PLATFORM-PLAN.md`: findings with `file:line` on the lane base, decisions D1-D7 with
      reasons (plan §1), target architecture, today's gates mapped to GitLab features, phases 0-8 with exit criteria,
      acceptance criteria A01-A34, explicitly-not-done list, risks, and the open owner actions of plan §8.
- [ ] P2 Re-check every cited `file:line` at the lane base; fix any that moved.
- [ ] P3 Evidence: `docs/validation/<VTID>/staging-tests.json` with a `not verified on staging: docs only` note.

**Acceptance**
- Change types: Tooling/docs.
- Outcome: the owner and every later plan of this program read one document that states the decisions, the phases and
  the acceptance criteria, with evidence they can open.
- States: n/a: document. Surfaces: `docs/`. Locales: n/a: internal English doc. Accessibility: n/a.
- Contract: n/a: no boundary crossed.
- Staging proof: not verified on staging: docs only, deploys nothing.
- Every `file:line` resolves on `origin/main` at the lane head; decisions D1-D7 match plan §1 exactly.

<!-- lane: aws-inventory -->
## Lane `aws-inventory` (vitana-platform)
- [ ] I1 Write the test `services/gateway/test/eng-platform-inventory-readonly.test.ts` (plan §6); record it red on base.
- [ ] I2 Write `scripts/aws/inventory-readonly.sh` per plan §4 (account/region guard, read-only verbs only, local
      `--out`, denied calls recorded and skipped, `--help`; IAM users with groups, group policies and boundary).
- [ ] I3 Real runs: `--help`; a run without credentials stops at the account guard with a non-zero exit.
- [ ] I4 Evidence: red/green test output, both runs, `staging-tests.json` with the Jest file as `existing`.

**Acceptance**
- Change types: Infrastructure/CI, Tooling/docs.
- Outcome: the owner gets one command that lists the AWS estate (network, IAM trusts, keys' age, ECR, ECS, data
  stores, ALB rules, buckets, secret names, security services, cost) into local files, with no write anywhere.
- States: denied API call → recorded in `summary.md` and skipped; wrong account → exit non-zero before any call.
- Surfaces: owner's shell. Locales: n/a. Accessibility: n/a.
- Contract: exit 0 on a completed run (even with denied calls), non-zero on guard failure; output layout documented in
  the script header.
- Staging proof: not verified on staging: a local script, deploys nothing; covered by the Jest file and the real runs.
- No `get-secret-value`, `--with-decryption` or mutating verb in the script (test asserts it).

<!-- lane: oidc-roles -->
## Lane `oidc-roles` (vitana-platform)
- [ ] O1 Write `services/gateway/test/eng-platform-oidc-roles.test.ts` (plan §6); record it red on base.
- [ ] O2 Write `scripts/aws/iam/eng-platform-oidc-{staging-deploy,v1-preview,drift-readonly,prod-deploy}-trust.json`
      and `eng-platform-oidc-{v1-preview,drift-readonly}-policy.json` with exactly the §3 values.
- [ ] O3 Write `scripts/aws/setup-github-oidc-roles.sh`: dry-run default, `--apply`, `--narrow-prod-trust <role>`,
      staging role permissions copied from `claude-staging-validation` at run time (user policies, group policies,
      permissions boundary), account/region guard.
- [ ] O4 Real run: `--help`; dry-run without credentials stops at the guard.
- [ ] O5 Evidence: red/green, runs, `staging-tests.json` (`existing`: the Jest file).

**Acceptance**
- Change types: Infrastructure/CI, Tooling/docs.
- Outcome: the owner can create the three keyless CI roles and narrow the prod deploy trust with one reviewed script,
  seeing the exact change before applying it.
- States: role exists → updated in place; prod role name wrong → script exits before any change.
- Surfaces: owner's shell; consumers are the workflows of lanes `stage-oidc-*` through the §3 variables.
- Locales: n/a. Accessibility: n/a.
- Contract: trust `sub` values and role names exactly as plan §3; `StringEquals` only; `aud` `sts.amazonaws.com`.
- Staging proof: not verified on staging: the roles are created by the owner (plan §8 step 2); the Jest file covers it.
- Script never creates access keys and never deletes the IAM user.

<!-- lane: stage-oidc-platform -->
## Lane `stage-oidc-platform` (vitana-platform)
- [ ] S1 Write `services/gateway/test/eng-platform-stage-oidc-workflows.test.ts` (plan §6); record it red on base.
- [ ] S2 Apply the §3 credential shape with `AWS_STAGING_ROLE_ARN` to the eight static-key workflows of plan §2, and
      `id-token: write` to each `permissions`; only the staging leg of `AWS-PROVISION-APPILIX-SECRETS.yml`.
- [ ] S3 `MIGRATION-DRIFT-CHECK.yml` aurora steps: `vars.AWS_DRIFT_ROLE_ARN || secrets.AWS_PROD_ROLE_ARN`; with the
      variable set, `--secret-arn` = the `vitana/aurora/prod/claude-readonly` secret, never the master secret.
- [ ] S3b `vtid-05009-provision-pack-token-workflow.test.ts`: replace only the `:24` `id-token` assertion with "every
      `role-to-assume` is `${{ vars.AWS_STAGING_ROLE_ARN }}`" (plan §4); every other assertion unchanged.
- [ ] S4 Parse every changed workflow; run the full `services/gateway` Jest file set that reads these workflows
      (`vtid-05009-provision-pack-token-workflow`, `vtid-04324-ecs-scale-allowlist`) unchanged and green.
- [ ] S5 Evidence: red/green, YAML parse output, `staging-tests.json` (`existing`: the Jest file).

**Acceptance**
- Change types: Infrastructure/CI.
- Outcome: once the owner sets `AWS_STAGING_ROLE_ARN` / `AWS_DRIFT_ROLE_ARN`, staging deploys, provisioning, alerts and
  the drift check run with short-lived OIDC credentials; until then they run exactly as today.
- States: variable unset → static keys (today); set → OIDC, keys ignored.
- Surfaces: the nine workflow files of plan §4. Locales: n/a. Accessibility: n/a.
- Contract: plan §3 credential-step shape; no `secrets.` in any `if:`; no `AWS-PROD-*` file and no prod leg changed.
- Staging proof: not verified on staging (OIDC path): role not created yet (owner step); the key path is exercised by
  the next staging deploy; the Jest file is the `existing` ref.
- Every sibling static-key workflow in vitana-platform is covered (the test lists them by grep, not by name).

<!-- lane: stage-oidc-v1 -->
## Lane `stage-oidc-v1` (vitana-v1)
- [ ] V1 Write `src/lib/eng-platform-stage-oidc.test.ts` (plan §6); record it red on base.
- [ ] V2 `AWS-STAGE-DEPLOY-FRONTEND.yml` with `AWS_STAGING_ROLE_ARN`; both preview workflows with
      `AWS_PREVIEW_ROLE_ARN`; `id-token: write` added; the missing-secret checks accept the role variable.
- [ ] V3 Parse the three workflows; `npm test` green.
- [ ] V4 Evidence: red/green, parse output, `staging-tests.json` (`existing`: the Vitest file).

**Acceptance**
- Change types: Infrastructure/CI.
- Outcome: once the owner sets the two variables, vitana-v1 staging and PR preview deploys stop holding long-lived AWS
  keys; PR previews get a role that can only write the preview bucket and invalidate the preview distribution.
- States: variables unset → today's keys; set → OIDC only; neither keys nor variable → the existing "missing" notice.
- Surfaces: the three workflow files. Locales: n/a. Accessibility: n/a.
- Contract: plan §3 shape; `AWS-PROD-DEPLOY-FRONTEND.yml` unchanged.
- Staging proof: not verified on staging (OIDC path): role not created yet; the next PR preview and staging deploy run
  the unchanged key path; the Vitest file is the `existing` ref.
- Every static-key workflow in vitana-v1 except `AWS-PROD-DEPLOY-FRONTEND.yml` is covered (grep-based test).
