# Plan: GitLab frontend production deploy for vitana-v1 (revision 2)

Change class: standard (deploy path, CI, IAM). Three sparring rounds, converged. Owner approved at Gate 1.

<!-- plan:begin -->
## Goal
Add a manual, main-only GitLab production deploy for the vitana-v1 community app (dr-app.vitanaland.com, ECS service vitana-community-app-awsdr), pinned to a commit that passed STAGING-VERIFY. The GitHub production workflow stays as the documented fallback until a follow-up plan retires it.

## Proposal
1. Generator, not hand edit: add a production key per service in config/delivery/services.json; extend scripts/eng/pipeline-gen.mjs to emit deploy-production:community-app.
2. Runner: deploy class vitana-eng-deploy (runner 8).
3. Auth: new role gl-v1-prod, audience aws:v1:prod, trust pinned to project_path:vitana/vitana-v1:ref_type:branch:ref:main, ECR push and ECS UpdateService/DescribeServices/RegisterTaskDefinition scoped to vitana-community-app-awsdr. Trust and policy JSON in scripts/aws/iam/. Role creation is an owner step.
4. Trigger rules: when manual, main only, EXPECTED_COMMIT required (job does not start without it). Always manual, independent of DELIVERY_MODE.
5. Pin: script compares EXPECTED_COMMIT with the built commit and the STAGING-VERIFY record; mismatch or missing evidence fails before any AWS call.
6. Build: new hidden job .build-image-prod in infra/gitlab-engineering/ci/tpl-deploy.yml, VITE_GATEWAY_BASE=https://gateway.vitanaland.com. Staging .build-image unchanged.
7. Auth job: new hidden job .deploy-production-auth in tpl-deploy.yml, V1_PROD_ID_TOKEN aud aws:v1:prod, role gl-v1-prod only. .deploy-staging-auth unchanged.
8. Smoke and rollback: live bundle must name gateway.vitanaland.com and not the preview host; on failure roll back to the previous task definition.
9. Concurrency: GitLab resource_group prod-frontend-deploy. Cross-system lock with the GitHub workflow: deferred to a follow-up plan (owner-accepted residual risk).
10. Governance: RUNBOOK-delivery-aws.md line 6 changes in the same change.

## Files in scope
- config/delivery/services.json
- scripts/eng/pipeline-gen.mjs
- infra/gitlab-engineering/ci/tpl-deploy.yml
- infra/gitlab-engineering/ci/v1-delivery.gitlab-ci.yml (regenerated)
- infra/gitlab-engineering/RUNBOOK-delivery-aws.md
- scripts/aws/iam/gl-v1-prod-trust.json, gl-v1-prod-policy.json (new)

## Owner steps (outside the code)
- Create role gl-v1-prod per item 3.
- Add audience aws:v1:prod to the OIDC provider (setup-gitlab-oidc.sh).

## Test plan
- Generator unit tests: the production key emits one job with the rules above.
- GitLab CI lint of the regenerated file.
- Rehearsal identity check with the rehearsal role (passed).
- No production run in this change.

## Out of scope
- Production run; GitHub workflow changes; IAM creation by this change; cleanup of vitana-gitlab-deploy-role.
<!-- plan:end -->

## Sparring record
Rounds: 3 (local partner plan-sparring-partner). Verdict: converged. Findings and planner responses are kept in the scratchpad copy; they are to be committed as docs/validation/<VTID>/plan-sparring.md after allocation.

CI PLAN-SPAR run 43518530657 escalated on round 1 with evidence_floor_not_met (the gateway partner's read_file calls returned HTTP 403; session eaabfd60-7137-4175-ae9d-1e3afac661a1, plan hash 5ff30873e05e5be1b9eee0dd8742ff5179ceeac72b283313f414fbfb403df309). This commit resubmits the same plan text for a new CI sparring session. Owner approval at Gate 1 was given in chat.
