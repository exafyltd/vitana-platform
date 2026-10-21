# AWS S3 mirror runway (Phase 1 W2 Track A — VTID-03200)

This directory wires the GCS → S3 artifact mirror that the W3+ Bedrock canary
will depend on. It is **dormant** until the operator provisions AWS. Nothing
here runs against AWS automatically; all jobs early-exit (or refuse, for the
smoke) when the secrets below are unset.

## Repository secrets the operator must set

Set these on `exafyltd/vitana-platform` once an AWS account exists
(`gh secret set <NAME>`):

| Secret         | Required | Default     | Purpose                                              |
|----------------|----------|-------------|------------------------------------------------------|
| `AWS_BUCKET`   | yes      | —           | Target S3 bucket name (no `s3://`), e.g. `vitana-artifacts`. |
| `AWS_ROLE_ARN` | yes      | —           | IAM role the workflows assume via GitHub OIDC.       |
| `AWS_REGION`   | no       | `us-east-1` | Bucket region.                                       |

```bash
gh secret set AWS_BUCKET   --repo exafyltd/vitana-platform --body "vitana-artifacts"
gh secret set AWS_ROLE_ARN --repo exafyltd/vitana-platform --body "arn:aws:iam::<ACCOUNT_ID>:role/vitana-gha-mirror"
gh secret set AWS_REGION   --repo exafyltd/vitana-platform --body "us-east-1"   # optional
```

Do **not** commit these values. The GCP side already uses Workload Identity
Federation (`GCP_WIF_PROVIDER` / `GCP_WIF_SA_EMAIL`); this is the AWS mirror of
that same keyless pattern — no static AWS access keys.

## One-time AWS setup (GitHub OIDC federation)

1. Create the GitHub OIDC provider (once per AWS account):
   - URL: `https://token.actions.githubusercontent.com`
   - Audience: `sts.amazonaws.com`
2. Create an IAM role (`vitana-gha-mirror`) with `s3:PutObject`, `s3:GetObject`,
   `s3:ListBucket`, `s3:DeleteObject` on the bucket, and this trust policy
   (scoped to this repo — same federation idea as our GCP WIF):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:exafyltd/vitana-platform:*"
        }
      }
    }
  ]
}
```

Put the resulting role ARN into `AWS_ROLE_ARN`.

## Proving the wiring

`SMOKE-AWS-MIRROR.yml` (`workflow_dispatch` only) runs `smoke-mirror.ts`:
writes a dated marker to `gs://vitana-artifacts-staging/smoke/`, mirrors it to
S3, asserts it landed, then cleans up both copies.

```bash
gh workflow run SMOKE-AWS-MIRROR.yml --ref main
```

With no secrets set it fails immediately with `AWS_BUCKET secret not set` —
that is the expected pre-provisioning state. Once the secrets land it should
go green, after which `MIRROR-ARTIFACTS-S3.yml` will also begin mirroring
eval-coverage reports and dataset manifests on its daily schedule (weights
follow in W3).
