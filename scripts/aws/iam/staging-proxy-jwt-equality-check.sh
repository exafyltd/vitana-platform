#!/usr/bin/env bash
#
# Owner check: is the staging JWT secret equal to the production JWT secret?
#
#   scripts/aws/iam/staging-proxy-jwt-equality-check.sh <staging-secret-id> <production-secret-id>
#
# Prints EQUAL or NOT EQUAL to stdout and nothing else there. Both values are read into shell variables and
# compared. No value, no hash and no trace is printed, logged or written, and set -x is not used. A failed read
# stops the script with the AWS CLI's own error on stderr. That error can include a secret id, never a value. A
# secret with no SecretString, or a SecretString whose text is the literal word None, stops the script with a
# fixed message on stderr and no result.
#
# Needs credentials allowed secretsmanager:GetSecretValue on both secrets (eu-central-1). Run by the owner only.
set -euo pipefail

SECRETS_REGION="eu-central-1"

if [ "$#" -ne 2 ] || [ -z "$1" ] || [ -z "$2" ]; then
  echo "usage: $0 <staging-secret-id> <production-secret-id>" >&2
  exit 2
fi

# "&& printf x" keeps the AWS call's exit status, so set -e stops on a failed read. The x marks the end of the
# value, so a trailing newline inside a secret is compared too.
staging_raw="$(aws secretsmanager get-secret-value --region "$SECRETS_REGION" --secret-id "$1" \
  --query SecretString --output text && printf x)"
production_raw="$(aws secretsmanager get-secret-value --region "$SECRETS_REGION" --secret-id "$2" \
  --query SecretString --output text && printf x)"
staging_value="${staging_raw%x}"
production_value="${production_raw%x}"
unset staging_raw production_raw

# The CLI prints None when a secret has no SecretString (a binary secret). Two Nones must not compare as EQUAL.
if [ "$staging_value" = $'None\n' ] || [ "$production_value" = $'None\n' ]; then
  echo "error: a secret has no SecretString; no comparison made" >&2
  exit 1
fi

if [ "$staging_value" = "$production_value" ]; then
  echo "EQUAL"
else
  echo "NOT EQUAL"
fi
unset staging_value production_value
