# Sparring round 1 — in_progress

Session: `8cc4dc48-eee4-4db3-9ed8-254d6a5269df` · plan hash `297c48585ee336c257a44e635b0e69a773f9d64a0ea4b90ec8a12f609c4e0628`

## Summary

The plan is well-structured, with sound security reasoning and a safe fallback-first rollout. Most premises about existing code are accurate. One blocker: the plan claims an existing test stays green, but adding `id-token: write` to `AWS-PROVISION-DEV-MEMORY-PACK-TOKEN.yml` will break the vtid-05009 test's explicit negative assertion on that exact string. One minor concern about IAM group-derived permissions that the role-copy script may miss.

## Findings

### R1-F1 [blocker]

The plan states "vtid-05009-provision-pack-token-workflow.test.ts stays green unchanged" (§6), but lane stage-oidc-platform adds `id-token: write` to every workflow's `permissions` block, including `AWS-PROVISION-DEV-MEMORY-PACK-TOKEN.yml`. The existing test at line 24 asserts `expect(wf).not.toContain('id-token: write')`. That assertion will fail, making the test red — not green.

- `exafyltd/vitana-platform:services/gateway/test/vtid-05009-provision-pack-token-workflow.test.ts:19` — it('targets the staging secret with staging keys only (no prod role, no prod name)', () => {
    expect(wf).toContain('SECRET_NAME: vitana/gateway/staging/dev-memory-pack-token');
    expect(wf).toContain('secrets.AWS_STAGING_ACCESS_KEY_ID');
    expect(wf).not.toContain('AWS_PROD_ROLE_ARN');
    expect(wf).not.toContain('vitana/gateway/prod/');
    expect(wf).not.toContain('id-token: write');
  });
- `exafyltd/vitana-platform:.github/workflows/AWS-PROVISION-DEV-MEMORY-PACK-TOKEN.yml:28` — permissions:
  contents: read

Suggestion: Either (a) exclude `AWS-PROVISION-DEV-MEMORY-PACK-TOKEN.yml` from the blanket `id-token: write` addition — it is `workflow_dispatch`-only and needs no preemptive OIDC permission grant, the OIDC switch can add it later — or (b) add `vtid-05009-provision-pack-token-workflow.test.ts` to lane `stage-oidc-platform`'s `paths` and update its assertion (remove or invert line 24). Option (a) is simpler and preserves the existing test's intent that this workflow is staging-keys-only.

### R1-F2 [minor]

The staging OIDC role (`vitana-gha-staging-deploy`) copies "the managed and inline policies attached to IAM user `claude-staging-validation`". IAM users can also inherit permissions from IAM groups and permission boundaries. If any effective permission the user has today comes from a group membership (not from policies directly attached to the user), the role will be under-permissioned. The `ALERT-APP-USERS-IDENTITY-DRIFT.yml` workflow (lines 34-42) already notes that its own RDS Data API / Secrets Manager access via these keys is "UNVERIFIED FROM THIS SESSION", making this gap more concrete.

- `exafyltd/vitana-platform:.github/workflows/ALERT-APP-USERS-IDENTITY-DRIFT.yml:34` — # UNVERIFIED FROM THIS SESSION: whether the AWS_STAGING_ACCESS_KEY_ID/
# AWS_STAGING_SECRET_ACCESS_KEY identity this workflow reuses (already
# used by AWS-STAGE-DEPLOY-GATEWAY.yml/I18N-DB-SEED.yml for ECS/ECR work)
# also carries rds-data:ExecuteStatement on vitana-aurora-prod and
# secretsmanager:GetSecretValue on vitana/aurora/prod/claude-readonly (the
# read-only secret this session used directly). If not, the "Query Aurora"
# step below fails with AccessDenied — a distinct, actionable signal
# ("grant this workflow's identity RDS Data API access"), not a false
# drift alarm. Confirm on the first real run.

Suggestion: The `setup-github-oidc-roles.sh` script (or its documentation) should enumerate group-inherited policies too: `aws iam list-groups-for-user` → per-group `list-attached-group-policies` / `list-group-policies`. If any group policies exist, the script should either attach them to the role or warn loudly. The Phase 0 inventory is the natural place to surface this, so at minimum add IAM group membership to the inventory output.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
