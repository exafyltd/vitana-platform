# Owner verification for the staging proxy replacement task

Every command below is for the owner to run. Nothing here was run by the agent. Run them with credentials for account 472838866351 in eu-central-1. None of them reads a secret value: `describe-secret` returns metadata, and `simulate-principal-policy` returns a policy decision.

The role arn:aws:iam::472838866351:role/vitana-postgrest-staging-execution-role and its inline policy were relayed from a live check by ChatGPT. The parent has not verified them. Run block 0 first. If block 0 disagrees with the relayed facts, stop and report before running anything else.

Each code block starts with the marker `# Owner-run`.

## 0. Confirm the relayed role and its inline policy

Owner-run. Reads the trust policy. It should trust ecs-tasks.amazonaws.com.

```bash
# Owner-run
aws iam get-role --role-name vitana-postgrest-staging-execution-role --query 'Role.AssumeRolePolicyDocument' --output json
```

Owner-run. Lists the attached managed policies. It should include AmazonECSTaskExecutionRolePolicy.

```bash
# Owner-run
aws iam list-attached-role-policies --role-name vitana-postgrest-staging-execution-role --output table
```

Owner-run. Reads the inline policy. Compare it with scripts/aws/iam/staging-proxy-execution-role-policy.json. The only grant should be GetSecretValue on the two vitana/gateway/staging/ secrets.

```bash
# Owner-run
aws iam get-role-policy --role-name vitana-postgrest-staging-execution-role --policy-name staging-proxy-two-secrets-only --output json
```

## 1. Exact ARNs of the two staging secrets (metadata only)

Owner-run. Returns the name, ARN and KMS key id. A null KmsKeyId means the secret uses the AWS managed key.

```bash
# Owner-run
aws secretsmanager describe-secret --region eu-central-1 --secret-id vitana/gateway/staging/postgrest-authenticator-uri --query '{Name:Name,ARN:ARN,KmsKeyId:KmsKeyId}' --output json
```

Owner-run. Same metadata for the JWT secret.

```bash
# Owner-run
aws secretsmanager describe-secret --region eu-central-1 --secret-id vitana/gateway/staging/postgrest-jwt-secret --query '{Name:Name,ARN:ARN,KmsKeyId:KmsKeyId}' --output json
```

## 2. Image pull and log write (identity policies on the role)

Owner-run. Simulates the ECR actions the execution role needs to pull the proxy image from vitana/postgrest-aurora-proxy. Expected: allowed on every row. The postgrest container uses the public postgrest/postgrest image, so it needs no ECR grant.

```bash
# Owner-run
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::472838866351:role/vitana-postgrest-staging-execution-role \
  --action-names ecr:GetAuthorizationToken ecr:BatchCheckLayerAvailability ecr:GetDownloadUrlForLayer ecr:BatchGetImage \
  --resource-arns arn:aws:ecr:eu-central-1:472838866351:repository/vitana/postgrest-aurora-proxy \
  --query 'EvaluationResults[].[EvalActionName,EvalResourceName,EvalDecision]' --output table
```

Owner-run. Simulates the log write actions on the log group of the service. Expected: allowed on every row.

```bash
# Owner-run
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::472838866351:role/vitana-postgrest-staging-execution-role \
  --action-names logs:CreateLogStream logs:PutLogEvents \
  --resource-arns "arn:aws:logs:eu-central-1:472838866351:log-group:/ecs/vitana-postgrest-aurora-staging:*" \
  --query 'EvaluationResults[].[EvalActionName,EvalResourceName,EvalDecision]' --output table
```

## 3. The two staging secret reads

Owner-run. Simulates GetSecretValue on the two exact ARNs from block 1. Replace the two placeholders with those ARNs. Expected: allowed on both rows.

```bash
# Owner-run
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::472838866351:role/vitana-postgrest-staging-execution-role \
  --action-names secretsmanager:GetSecretValue \
  --resource-arns "<ARN of vitana/gateway/staging/postgrest-authenticator-uri from block 1>" "<ARN of vitana/gateway/staging/postgrest-jwt-secret from block 1>" \
  --query 'EvaluationResults[].[EvalResourceName,EvalDecision]' --output table
```

Owner-run. Prints the ARN of one existing production secret. It is metadata only. The example name is the production JWT secret that AWS-PROD-DEPLOY-POSTGREST-AURORA-PROXY.yml:96 names as SECRET_JWT. Use a different existing production secret if you prefer.

```bash
# Owner-run
aws secretsmanager describe-secret --region eu-central-1 --secret-id vitana/supabase/prod/jwt-secret --query ARN --output text
```

Owner-run. Simulates GetSecretValue on that production ARN. Replace the placeholder with the ARN printed above. Expected: implicitDeny.

```bash
# Owner-run
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::472838866351:role/vitana-postgrest-staging-execution-role \
  --action-names secretsmanager:GetSecretValue \
  --resource-arns "<ARN of the production secret printed above>" \
  --query 'EvaluationResults[].[EvalResourceName,EvalDecision]' --output table
```

Owner-run. Run only if KmsKeyId from block 1 is not null. Simulates kms:Decrypt on that key, since reading a customer managed key's secret also needs the decrypt grant. Replace the placeholder with the key ARN.

```bash
# Owner-run
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::472838866351:role/vitana-postgrest-staging-execution-role \
  --action-names kms:Decrypt \
  --resource-arns "<KMS key ARN for the secret>" \
  --query 'EvaluationResults[].[EvalResourceName,EvalDecision]' --output table
```

## 4. The deploy role may pass the new role (run after the PassRole policy is applied)

Owner-run. Run only after the owner applies scripts/aws/iam/staging-proxy-passrole-policy.json to vitana-gha-staging-deploy. Supplies the iam:PassedToService context key, because the simulator checks a condition only when its key is passed. Expected: allowed.

```bash
# Owner-run
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::472838866351:role/vitana-gha-staging-deploy \
  --action-names iam:PassRole \
  --resource-arns arn:aws:iam::472838866351:role/vitana-postgrest-staging-execution-role \
  --context-entries ContextKeyName=iam:PassedToService,ContextKeyValues=ecs-tasks.amazonaws.com,ContextKeyType=string \
  --query 'EvaluationResults[].[EvalActionName,EvalResourceName,EvalDecision]' --output table
```

## What these simulations do not cover

- They evaluate the identity-based policies attached to the role, and its permissions boundary if one is set. They do not evaluate the role's trust policy. A passing result does not show that ECS can assume the role.
- They do not launch a task, pull an image, write a log line or read a secret. The result is a policy decision, not an operation.
- They do not evaluate a resource-based policy on the secret or the key unless you pass one in.
- Block 0 reads the live attachments and inline policy. The simulations use the same live state at the time of the call.
- They do not check the ECS network path, the security group, or the Aurora endpoint. Run the health checks in the deploy procedure for that.
