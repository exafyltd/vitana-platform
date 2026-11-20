# Preview publishing: proposed infrastructure (not applied)

Status: planning only. Nothing in this folder has been applied to AWS. Each file is an input for a governed change.

| File | Purpose |
|---|---|
| ecr-repository.json | Dedicated IMMUTABLE repository `vitana/gateway-preview`, scan on push, AWS-managed KMS |
| lifecycle-policy.json | Keep 20 shadow-* images; expire untagged after 7 days |
| trust-policy.json | Trust only the GitLab OIDC provider, for one project, one branch, the STS audience and the protected CI config |
| role-policy.json | ECR upload and read on that repository only; no delete; no ECS, IAM, Secrets Manager or S3 |

Provider: no change. The live provider accepts only `https://sts.amazonaws.com`, so the preview job uses that audience.
The staging roles keep their conditions untouched. The new role separates itself through `ref_path` and `project_path`.

Blocked before apply:
1. `ci_config_ref_uri` in trust-policy.json must be replaced with the exact value from one real GitLab token, read through a governed claims check that prints claims only, never the token.
2. The live `gl-platform-staging` and `gl-v1-staging` trust policies must be read through an authorised path, to confirm the change does not touch them.
