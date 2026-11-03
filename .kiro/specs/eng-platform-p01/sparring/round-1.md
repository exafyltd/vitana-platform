# Sparring round 1 — in_progress

Session: `89610500-8153-4f3d-a268-9edaa3ec8d3d` · plan hash `76bfa1a57a5c755edec1de367190d373962cecbf72678c37701076af8fdf1913`

## Summary

The plan is well-researched with thorough evidence. Most premises about the existing codebase check out against the pinned commits. I verified 20+ line-level references across both repos. One major concern: the enumeration of static-key workflows may be incomplete — several AWS-named workflows in vitana-platform were not checked against the plan's inventory, which matters because the rollout step 3 deletes the IAM user's access keys. Otherwise the design is sound: the dual-path credential expression, the role trust scoping, and the staged rollout with fallback are all well-considered.

## Findings

### R1-F1 [major]

The plan claims exactly eight vitana-platform workflows use AWS_STAGING_ACCESS_KEY_ID static keys (§2 'Every other static-key user'). The workflow directory contains at least three additional AWS-named workflows not in that list: AWS-STAGING-VALIDATION.yml, AWS-OPS-ECS-SCALE-UNGOVERNED.yml, and AWS-REHEARSAL-AURORA-CLONE.yml. If any of these use the staging static keys, they are not covered by lane stage-oidc-platform, and deleting the IAM user's access keys in §8 step 3 would break them silently.

- `exafyltd/vitana-platform:.github/workflows:1` — file  AWS-OPS-ECS-SCALE-UNGOVERNED.yml
file  AWS-REHEARSAL-AURORA-CLONE.yml
file  AWS-STAGING-VALIDATION.yml
- `exafyltd/vitana-platform:.github/workflows/ALERT-APP-USERS-IDENTITY-DRIFT.yml:70` — aws-access-key-id: ${{ secrets.AWS_STAGING_ACCESS_KEY_ID }}
            aws-secret-access-key: ${{ secrets.AWS_STAGING_SECRET_ACCESS_KEY }}

Suggestion: Before merging, read every workflow in vitana-platform's .github/workflows/ (and vitana-v1's) for references to AWS_STAGING_ACCESS_KEY_ID or AWS_STAGING_SECRET_ACCESS_KEY, and either add the missing files to lane stage-oidc-platform's paths list, or document them in §10 as explicitly out-of-scope with the reason they are safe to leave on static keys (or document that they don't actually use those secrets). The inventory script from lane aws-inventory could include a grep across workflows as a cross-check.

### R1-F2 [minor]

The plan's §2 cites MIGRATION-DRIFT-CHECK.yml's MasterUserSecret.SecretArn at ':143-144' and the Data API query at ':147-149', but the actual lines are 144-145 and 148-150 respectively (each reference is off by one).

- `exafyltd/vitana-platform:.github/workflows/MIGRATION-DRIFT-CHECK.yml:142` — CLUSTER_ARN=$(aws rds describe-db-clusters --region $R --db-cluster-identifier vitana-aurora-prod \
              --query 'DBClusters[0].DBClusterArn' --output text)
            SECRET_ARN=$(aws rds describe-db-clusters --region $R --db-cluster-identifier vitana-aurora-prod \
              --query 'DBClusters[0].MasterUserSecret.SecretArn' --output text)
            SQL="..."
            tries=0
            until aws rds-data execute-statement --region $R --resource-arn "$CLUSTER_ARN" \
                  --secret-arn "$SECRET_ARN" --database vitana --sql "$SQL" \

Suggestion: Correct the line references to :144-145 for MasterUserSecret.SecretArn and :148-150 for the Data API query. Cosmetic only but important for future auditors tracing the plan.

### R1-F3 [minor]

ALERT-APP-USERS-IDENTITY-DRIFT.yml (lines 34-42) explicitly documents that the staging IAM user's permission to call rds-data:ExecuteStatement on vitana-aurora-prod and secretsmanager:GetSecretValue on the claude-readonly secret is 'UNVERIFIED'. The plan's staging role copies this user's permissions, inheriting the same uncertainty. If the user lacks those permissions today, the workflow is already broken; if it has them, the staging OIDC role (which is meant for staging deploys) silently carries production data-plane access.

- `exafyltd/vitana-platform:.github/workflows/ALERT-APP-USERS-IDENTITY-DRIFT.yml:34` — # UNVERIFIED FROM THIS SESSION: whether the AWS_STAGING_ACCESS_KEY_ID/
# AWS_STAGING_SECRET_ACCESS_KEY identity this workflow reuses (already
# used by AWS-STAGE-DEPLOY-GATEWAY.yml/I18N-DB-SEED.yml for ECS/ECR work)
# also carries rds-data:ExecuteStatement on vitana-aurora-prod and
# secretsmanager:GetSecretValue on vitana/aurora/prod/claude-readonly (the
# read-only secret this session used directly). If not, the "Query Aurora"
# step below fails with AccessDenied
- `exafyltd/vitana-platform:.github/workflows/ALERT-APP-USERS-IDENTITY-DRIFT.yml:59` — AURORA_CLUSTER_ARN: 'arn:aws:rds:eu-central-1:472838866351:cluster:vitana-aurora-prod'
    AURORA_SECRET_ARN: 'arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana/aurora/prod/claude-readonly-ZJGHXq'

Suggestion: The aws-inventory lane's output (or a targeted IAM policy simulation) should resolve this before the OIDC roles are created: check whether claude-staging-validation's effective policies include rds-data and secretsmanager permissions on the production cluster. If they do, consider whether ALERT-APP-USERS-IDENTITY-DRIFT.yml should use the drift-readonly role instead of the staging-deploy role, since its access pattern is read-only production data, not staging deployment. At minimum, document the finding in the program document's risks section.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
