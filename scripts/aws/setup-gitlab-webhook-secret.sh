#!/usr/bin/env bash
#
# VTID-05541 (plan eng-gitlab-m2 3.5, rollout step 7) — copy the GitLab webhook signing token from the
# engineering account into the staging gateway's secret.
#
#   source  vitana/engineering/gitlab/webhook-signing-token     account vitana-engineering (AWS Organizations)
#   target  vitana/gateway/staging/gitlab-webhook-signing-token account 472838866351, eu-central-1
#
# The settings sync of plan 3.3 creates the source (format whsec_<base64>). AWS-STAGE-DEPLOY-GATEWAY.yml
# ("Resolve GitLab webhook signing token") wires the target into GITLAB_WEBHOOK_SIGNING_TOKEN on the next
# staging deploy; while the target is absent the route answers 401 to an unsigned request and 500
# not_configured to a signed one. Production is not wired in this milestone, so this script has no
# production mode.
#
# Owner-run, from AWS CloudShell in the workload account 472838866351. DRY RUN BY DEFAULT: without --apply
# it only checks (who am I, which account is the engineering account, does the source exist, does the
# target exist) and never reads a secret value. With --apply it reads the source through a 15-minute
# session of the engineering account's role and writes the target with the caller's own credentials.
# The value is never printed, never put on a command line (it goes to the CLI through a mode-600 file
# that is removed on exit) and never written anywhere else.
#
# USAGE
#   scripts/aws/setup-gitlab-webhook-secret.sh                          # dry run
#   scripts/aws/setup-gitlab-webhook-secret.sh --apply                  # copy
#   scripts/aws/setup-gitlab-webhook-secret.sh --source-account 123456789012 [--source-role NAME] [--apply]
#
# --source-account   the engineering account id (default: the ACTIVE account named vitana-engineering
#                    in AWS Organizations)
# --source-role      the role assumed in it (default: OrganizationAccountAccessRole, the role AWS
#                    Organizations creates in an account it creates)

set -euo pipefail

REGION="eu-central-1"
WORKLOAD_ACCOUNT="472838866351"
ENG_ACCOUNT_NAME="vitana-engineering"
SOURCE_SECRET="vitana/engineering/gitlab/webhook-signing-token"
TARGET_SECRET="vitana/gateway/staging/gitlab-webhook-signing-token"
SOURCE_ROLE="OrganizationAccountAccessRole"
SOURCE_ACCOUNT=""
APPLY=0

say() { echo "[setup-gitlab-webhook-secret] $*"; }
die() { echo "[setup-gitlab-webhook-secret] ERROR: $1" >&2; exit "${2:-1}"; }
usage() { echo "Usage: $0 [--apply] [--source-account <12-digit id>] [--source-role <role name>]" >&2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --source-account) [[ $# -ge 2 ]] || { usage; exit 2; }; SOURCE_ACCOUNT="$2"; shift 2 ;;
    --source-role) [[ $# -ge 2 ]] || { usage; exit 2; }; SOURCE_ROLE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

[[ "$SOURCE_ROLE" =~ ^[A-Za-z0-9+=,.@_-]{1,64}$ ]] || die "--source-role '$SOURCE_ROLE' is not a role name" 2

# 1. Only in the workload account (CLAUDE.md IF-THEN 11).
CALLER=$(aws sts get-caller-identity --query Account --output text)
[[ "$CALLER" == "$WORKLOAD_ACCOUNT" ]] || die "these credentials are for account '$CALLER'; run this in account $WORKLOAD_ACCOUNT (eu-central-1)" 3

# 2. The engineering account.
if [[ -z "$SOURCE_ACCOUNT" ]]; then
  SOURCE_ACCOUNT=$(aws organizations list-accounts \
    --query "Accounts[?Name=='${ENG_ACCOUNT_NAME}' && Status=='ACTIVE'].Id" --output text 2>/dev/null || true)
  SOURCE_ACCOUNT="${SOURCE_ACCOUNT//[[:space:]]/ }"
  SOURCE_ACCOUNT="${SOURCE_ACCOUNT# }"; SOURCE_ACCOUNT="${SOURCE_ACCOUNT% }"
  [[ -n "$SOURCE_ACCOUNT" && "$SOURCE_ACCOUNT" != "None" && "$SOURCE_ACCOUNT" != *" "* ]] \
    || die "no single ACTIVE account named $ENG_ACCOUNT_NAME found in AWS Organizations; pass --source-account <id>" 4
fi
[[ "$SOURCE_ACCOUNT" =~ ^[0-9]{12}$ ]] || die "--source-account '$SOURCE_ACCOUNT' is not a 12-digit account id" 2
[[ "$SOURCE_ACCOUNT" != "$WORKLOAD_ACCOUNT" ]] || die "the source must be the engineering account, not $WORKLOAD_ACCOUNT" 2
ROLE_ARN="arn:aws:iam::${SOURCE_ACCOUNT}:role/${SOURCE_ROLE}"

# 3. A short session in the engineering account, used only for the source reads.
read -r SRC_KEY SRC_SECRET SRC_TOKEN < <(aws sts assume-role --role-arn "$ROLE_ARN" \
  --role-session-name vitana-gitlab-webhook-secret --duration-seconds 900 \
  --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text 2>/dev/null || true) || true
[[ -n "${SRC_KEY:-}" && -n "${SRC_SECRET:-}" && -n "${SRC_TOKEN:-}" ]] || die "could not assume $ROLE_ARN" 5
# The session credentials reach the CLI through its environment only (a subshell), never through an
# argument list that other processes could read.
source_aws() (
  unset AWS_PROFILE AWS_DEFAULT_PROFILE
  export AWS_ACCESS_KEY_ID="$SRC_KEY" AWS_SECRET_ACCESS_KEY="$SRC_SECRET" AWS_SESSION_TOKEN="$SRC_TOKEN"
  aws "$@"
)

# 4. Both secrets (metadata only).
source_aws secretsmanager describe-secret --region "$REGION" --secret-id "$SOURCE_SECRET" --query ARN --output text >/dev/null 2>&1 \
  || die "$SOURCE_SECRET not found in account $SOURCE_ACCOUNT (or not readable by $SOURCE_ROLE); the settings sync creates it" 6
if aws secretsmanager describe-secret --region "$REGION" --secret-id "$TARGET_SECRET" --query ARN --output text >/dev/null 2>&1; then
  TARGET_EXISTS=1
else
  TARGET_EXISTS=0
fi

say "source: $SOURCE_SECRET (account $SOURCE_ACCOUNT, role $SOURCE_ROLE)"
say "target: $TARGET_SECRET (account $WORKLOAD_ACCOUNT, $REGION) — $([[ $TARGET_EXISTS == 1 ]] && echo exists || echo absent)"

if [[ "$APPLY" -ne 1 ]]; then
  say "[dry run] would copy the source value to the target ($([[ $TARGET_EXISTS == 1 ]] && echo 'update if it differs' || echo 'create'))"
  say "[dry run] no secret value was read and nothing was written; re-run with --apply"
  exit 0
fi

# 5. Copy through a private file, never through argv or stdout.
WORK=$(mktemp -d)
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
VALUE_FILE="$WORK/value"
( umask 077
  source_aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SOURCE_SECRET" \
    --query SecretString --output text > "$VALUE_FILE.raw" ) || die "could not read $SOURCE_SECRET" 6
VALUE=$(cat "$VALUE_FILE.raw")
rm -f "$VALUE_FILE.raw"
[[ "$VALUE" =~ ^whsec_[A-Za-z0-9+/]+={0,2}$ ]] || { VALUE=""; die "the value of $SOURCE_SECRET is not in whsec_<base64> form; nothing was written" 7; }
( umask 077; printf '%s' "$VALUE" > "$VALUE_FILE" )

if [[ "$TARGET_EXISTS" == 1 ]]; then
  CURRENT=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$TARGET_SECRET" \
    --query SecretString --output text 2>/dev/null || true)
  if [[ "$CURRENT" == "$VALUE" ]]; then
    VALUE=""; CURRENT=""
    say "$TARGET_SECRET already holds the current value — unchanged"
    exit 0
  fi
  CURRENT=""
  aws secretsmanager put-secret-value --region "$REGION" --secret-id "$TARGET_SECRET" \
    --secret-string "file://$VALUE_FILE" >/dev/null
  say "updated $TARGET_SECRET"
else
  aws secretsmanager create-secret --region "$REGION" --name "$TARGET_SECRET" \
    --description "GitLab webhook signing token for the staging gateway route /api/v1/internal/gitlab/webhook (VTID-05541)" \
    --secret-string "file://$VALUE_FILE" --tags Key=vtid,Value=VTID-05541 >/dev/null
  say "created $TARGET_SECRET"
fi
VALUE=""
say "The next staging gateway deploy wires it (deploy log: 'resolved $TARGET_SECRET -> GITLAB_WEBHOOK_SIGNING_TOKEN')."
