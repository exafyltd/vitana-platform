# Rights of the settings sync, milestone 2 (plan eng-gitlab-m2, lane settings, plan section 3.3).
#
# A second file of the same Terraform module as main.tf (milestone 1): same provider, state, region, account and GitLab role, used by
# reference. Nothing in main.tf, fleet.tf or monitoring.tf is edited, and this file declares no provider, no backend and no variable, so
# the owner's setup.sh apply needs no new -var flag. It creates no secret: the fleet lane creates the empty fleet runner token secret, the
# sync creates its own agent secrets, and the signing token of the webhook is put there by the owner. This file only says what the role of
# the GitLab machine (the settings sync runs there as root) may do with them.
#
# The sync (scripts/eng/gitlab-settings.mjs) makes exactly these Secrets Manager calls and no others:
#   get-secret-value  on agents/<username>, fleet-runner-token, webhook-signing-token
#   put-secret-value  on agents/<username> and fleet-runner-token
#   create-secret     on agents/<username> (when put-secret-value finds no secret); it passes no tags and no KMS key
# so TagResource is not granted and nothing here can delete a secret, change a policy or read any other secret.
#
# Secret ARNs end in a dash and six random characters that AWS adds, so the two fixed secrets are written with ??????, which matches those
# six characters and not a longer name. The agent secrets are one per account and are made at run time, so their ARN is a prefix, agents/*
# (the one wildcard in this file; the prefix is the limit).
#
# Keys. The fleet runner token secret is encrypted with the key of main.tf (the fleet lane sets kms_key_id = aws_kms_key.main.arn), and
# the role already holds the two rights below on that key through main.tf; they are repeated here so that this policy stands on its own.
# The sync creates the agent secrets without naming a key, so they are encrypted with the AWS managed key aws/secretsmanager. Its key
# policy is fixed by AWS and lets every principal of the account use it, but only when Secrets Manager makes the request for that
# principal (kms:ViaService = secretsmanager.<region>.amazonaws.com), so those secrets need no statement here and none can be written:
# the key is created on first use, and a data source for its alias would stop the plan on an account where it does not exist yet.

locals {
  # arn:aws:secretsmanager:<region>:<account>:secret:<name>-<six characters>
  settings_secret_arn_prefix = "arn:aws:secretsmanager:${var.region}:${data.aws_caller_identity.me.account_id}:secret:vitana/engineering/gitlab"
}

data "aws_iam_policy_document" "settings" {
  statement {
    sid       = "AgentTokens"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue", "secretsmanager:CreateSecret", "secretsmanager:DescribeSecret"]
    resources = ["${local.settings_secret_arn_prefix}/agents/*"]
  }
  statement {
    sid       = "FleetRunnerToken"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue", "secretsmanager:DescribeSecret"]
    resources = ["${local.settings_secret_arn_prefix}/fleet-runner-token-??????"]
  }
  statement {
    sid       = "WebhookSigningToken"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = ["${local.settings_secret_arn_prefix}/webhook-signing-token-??????"]
  }
  statement {
    sid       = "UseKeyForTheEncryptedSecrets"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.main.arn]
  }
}

resource "aws_iam_role_policy" "settings" {
  name   = "settings"
  role   = aws_iam_role.gitlab.id
  policy = data.aws_iam_policy_document.settings.json
}
