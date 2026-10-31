# VTID-05328 — decisions taken by the builder
- **Protected gate files changed (§3a):** `.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml` and
  `.github/workflows/AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml`. Merge needs a legacy Claude review on the current head or
  the owner's instruction, not a reviewer-agent accept alone. Kept in this PR (plan allows a follow-up split).
- **Policy file has two statements, not one.** `tasks.md` P4 names Sid `EcrPublicPull` with the STS action conditioned on
  `sts:AWSServiceName`. A condition on one statement applies to every action in it, and `ecr-public:GetAuthorizationToken`
  carries no `sts:AWSServiceName` key, so a single conditioned statement would deny it. `EcrPublicPull` holds
  `ecr-public:GetAuthorizationToken`; `EcrPublicPullBearerToken` holds the conditioned `sts:GetServiceBearerToken`
  (same split as AWS's `AmazonElasticContainerRegistryPublicReadOnly`). Same two actions, same least privilege.
- **Sanity test names all five platform build jobs** (sparring R2-F1), not the "four" in the plan text.
- **Check script simulates the STS action with the `sts:AWSServiceName=ecr-public.amazonaws.com` context entry**, so
  the conditioned statement evaluates as it will at login time.
