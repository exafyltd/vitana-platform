# VTID-05328 — IAM status (ci-ecr-public-pull)

Status at PR time (2026-10-28): **not applied** (no session has AWS credentials; applying is a live IAM write that
Kiro and CI never make, collaboration §7a).

Until it is applied, every login step logs the `::warning` "ECR Public login failed" fallback and builds pull
anonymously, exactly as before this change.

To apply (owner or an IAM admin, CloudShell, account `472838866351`), after this PR is merged:

```bash
bash scripts/aws/iam/ci-ecr-public-pull-iam-check.sh   # read-only: prints what is missing + the exact commands
# then run the printed put-user-policy (claude-staging-validation) / put-role-policy (vitana-gateway-awsdr-deploy-role)
```

Evidence to record here and in the lane log: the first `AWS-STAGE-DEPLOY-GATEWAY.yml` run after applying logs
`ecr-public-login: authenticated` (run link).
