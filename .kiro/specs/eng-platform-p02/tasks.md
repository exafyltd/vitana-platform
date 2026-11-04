# Tasks — eng-platform-p02
Authoritative plan: `plan.md`. VTIDs from CI PLAN-SPAR. Branch `kiro/eng-platform-p02/prod-frontend-oidc`; PR title
`VTID-xxxxx (eng-platform-p02/prod-frontend-oidc): …`; trailers `Collab-Session` and
`Collab-Lane: eng-platform-p02/prod-frontend-oidc`; identity `kiro-agent[bot]`; evidence in `docs/validation/<VTID>/`.

<!-- lane: prod-frontend-oidc -->
## Lane `prod-frontend-oidc` (vitana-v1)
- [ ] T1 Grep the repo for tests and scripts that read `DEPLOY.yml` or `AWS-PROD-DEPLOY-FRONTEND.yml`. List them in
      `docs/validation/<VTID>/outputs/`.
- [ ] T2 Write `src/lib/eng-platform-prod-frontend-oidc.test.ts`. Record it red on base.
- [ ] T3 `AWS-PROD-DEPLOY-FRONTEND.yml`: top-level permissions (`contents: read`, `id-token: write`); credential step in
      the plan §3 shape.
- [ ] T4 `DEPLOY.yml`: `aws_prod` job permissions (`contents: read`, `id-token: write`); comment updated.
- [ ] T5 Green: the lane test, every test from T1, YAML parse of both files. Record in `commands.log`.

**Acceptance**
- Change types: Infrastructure/CI.
- Outcome: the production community app deploys with a keyless role once the owner sets `AWS_PROD_FRONTEND_ROLE_ARN`.
  Until then the deploy is unchanged.
- States: n/a: workflow files only.
- Surfaces: the two production workflow files. Callers: `DEPLOY.yml` (its `aws_prod` job) and direct dispatch from PUBLISH.
- Locales: n/a. Accessibility: n/a.
- Contract: the credential step has the plan §3 shape; `secrets: inherit` stays; no production target changes.
- Staging proof: not verified on staging: a production workflow. The proof is rollout step 5 of `plan.md` §6.
- Sibling sweep: every AWS credential step on the production frontend path is listed by the T1 grep. Only the frontend
  step changes.
