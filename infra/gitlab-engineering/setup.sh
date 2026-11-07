#!/bin/bash
# Self-hosted GitLab CI, milestone 1 (plan eng-gitlab-m1). Run in AWS CloudShell, signed in to the
# management account 472838866351.
#
#   bash setup.sh            create the account (once), certificate, infrastructure; prints the DNS records
#   bash setup.sh status     progress of the GitLab host and the runner
#   bash setup.sh password   the GitLab root password
#   bash setup.sh token      store the GitHub read-only token for the mirror
#   bash setup.sh diag       which services of the new AWS account AWS has activated yet
#   bash setup.sh runner     (re)register the CI runner if its first registration did not happen
#   bash setup.sh grow       switch both machines to the full size once AWS has raised the EC2 vCPU limit (a few minutes of downtime)
#
# DNS lives in Cloudflare. The script asks once for a Cloudflare API token (Zone > DNS > Edit on vitanaland.com only;
# typed hidden, kept in memory, never written to disk) and adds the two DNS records itself. Press Enter instead of
# pasting a token and it prints the records for you to add by hand.
#
# Safe to run again: every step checks what already exists.
set -uo pipefail
# CloudShell sets AWS_REGION to the region it was opened in, and the AWS CLI prefers it over AWS_DEFAULT_REGION.
# Everything here lives in Frankfurt, so set both.
export AWS_PAGER="" AWS_REGION=eu-central-1 AWS_DEFAULT_REGION=eu-central-1
HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="$HERE/state.env"
MGMT=472838866351
DOMAIN=gitlab.vitanaland.com
TF_VERSION=1.17.1
GITLAB_VERSION=19.5.3-ee.0
RUNNER_VERSION=19.5.2-1
SIZE_GITLAB=m6i.xlarge   # grows/shrinks with the EC2 vCPU limit of the new account, see quota_check
SIZE_RUNNER=m6i.xlarge
EMAIL="${VITANA_ENG_EMAIL:-d.stevanovic+vitana-engineering@vitanaland.com}"
ADMIN_EMAIL="${VITANA_ENG_ADMIN_EMAIL:-d.stevanovic@vitanaland.com}"
touch "$STATE"
. "$STATE"
save() { grep -v "^$1=" "$STATE" > "$STATE.tmp" || true; echo "$1=$2" >> "$STATE.tmp"; mv "$STATE.tmp" "$STATE"; }
die() { echo "ERROR: $*" >&2; exit 1; }

ensure_account() {
  local req st
  if [ -z "${ACCOUNT_ID:-}" ]; then
    [ "$(aws sts get-caller-identity --query Account --output text)" = "$MGMT" ] || die "run this in the management account $MGMT"
    ACCOUNT_ID="$(aws organizations list-accounts --query "Accounts[?Name=='vitana-engineering' && Status=='ACTIVE'].Id | [0]" --output text)"
    if [ -z "$ACCOUNT_ID" ] || [ "$ACCOUNT_ID" = None ]; then
      echo "Creating the AWS account vitana-engineering (root e-mail $EMAIL) ..."
      req="$(aws organizations create-account --email "$EMAIL" --account-name vitana-engineering --query CreateAccountStatus.Id --output text)" || die "create-account failed"
      for i in $(seq 1 60); do
        st="$(aws organizations describe-create-account-status --create-account-request-id "$req" --query 'CreateAccountStatus.[State,FailureReason,AccountId]' --output text)"
        case "$st" in
          SUCCEEDED*) ACCOUNT_ID="$(echo "$st" | awk '{print $3}')"; break ;;
          FAILED*) die "account creation failed: $st  (use another e-mail:  VITANA_ENG_EMAIL=name+x@vitanaland.com bash $0)" ;;
        esac
        sleep 10
      done
    fi
    [ -n "$ACCOUNT_ID" ] && [ "$ACCOUNT_ID" != None ] || die "account was not created in time; run the script again"
    save ACCOUNT_ID "$ACCOUNT_ID"
  fi
  echo "AWS account vitana-engineering: $ACCOUNT_ID"
}

assume() {   # temporary admin credentials for the new account (1 hour)
  local c=""
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  for i in $(seq 1 30); do
    c="$(aws sts assume-role --role-arn "arn:aws:iam::$ACCOUNT_ID:role/OrganizationAccountAccessRole" --role-session-name vitana-eng --duration-seconds 3600 --query Credentials --output json 2>/dev/null)" && break
    c=""; sleep 10
  done
  [ -n "$c" ] || die "cannot assume OrganizationAccountAccessRole in $ACCOUNT_ID yet; wait a minute and run again"
  export AWS_ACCESS_KEY_ID="$(jq -r .AccessKeyId <<<"$c")" AWS_SECRET_ACCESS_KEY="$(jq -r .SecretAccessKey <<<"$c")" AWS_SESSION_TOKEN="$(jq -r .SessionToken <<<"$c")"
}

quota_value() {
  local v
  v="$(aws service-quotas get-service-quota --service-code ec2 --quota-code L-1216C47A --query Quota.Value --output text 2>/dev/null)" || return 1
  echo "${v%.*}"
}

quota_request() {   # a brand-new AWS account often starts with a low EC2 vCPU limit; we need 8 (two m6i.xlarge)
  local v
  v="$(quota_value)" || return 0
  [ -n "$v" ] || return 0
  if [ "$v" -lt 8 ] 2>/dev/null; then
    echo "The EC2 vCPU limit of the new account is $v; we need 8. Asking AWS to raise it to 32 ..."
    aws service-quotas request-service-quota-increase --service-code ec2 --quota-code L-1216C47A --desired-value 32 >/dev/null 2>&1 \
      || echo "(automatic request failed: open Service Quotas > EC2 > Running On-Demand Standard instances and request 32)"
  fi
}

quota_check() {   # full size needs 8 vCPUs; a brand-new account may start at 5, so do not block on AWS: start small
  local v
  v="$(quota_value)" || return 0
  [ -n "$v" ] || return 0
  for i in $(seq 1 30); do
    [ "$v" -ge 8 ] 2>/dev/null && return 0
    sleep 10
    v="$(quota_value)" || return 0
  done
  if [ "$v" -ge 4 ] 2>/dev/null; then
    SIZE_GITLAB=m6i.large; SIZE_RUNNER=m6i.large
    echo "AWS has not raised the EC2 vCPU limit yet (it is $v, full size needs 8)."
    echo "Starting with smaller machines (2 vCPU each) so you are not blocked. When AWS has raised the limit, run this script again and it grows them."
  else
    die "the EC2 vCPU limit of the new account is $v and we need at least 4. Ask AWS to raise it (Service Quotas > EC2 > Running On-Demand Standard instances), then run again:  bash $HERE/setup.sh"
  fi
}

# >>> readiness
# A brand-new AWS account is not usable at once: AWS activates its services in the background (minutes, sometimes
# hours). Until then calls fail with SubscriptionRequiredException / OptInRequired / PendingVerification.
PROBES=(
  "ec2|aws ec2 describe-vpcs"
  "acm|aws acm list-certificates"
  "elb|aws elbv2 describe-load-balancers"
  "kms|aws kms list-keys"
  "secrets|aws secretsmanager list-secrets"
  "s3|aws s3api list-buckets"
  "ssm|aws ssm describe-instance-information"
)
MISS=""
not_active() {   # does this error text say the account is not activated yet?
  case "$1" in *SubscriptionRequired*|*OptInRequired*|*PendingVerification*|*"needs a subscription"*|*"not subscribed"*) return 0 ;; esac
  return 1
}
probe_all() {   # sets MISS to the services that are not active yet; with "show" it prints one line per service
  local spec label out ami
  MISS=""
  for spec in "${PROBES[@]}"; do
    label="${spec%%|*}"
    if out="$(${spec#*|} 2>&1)"; then
      [ "${1:-}" = show ] && printf '  %-8s ready\n' "$label"
    elif not_active "$out"; then
      MISS="$MISS $label"
      [ "${1:-}" = show ] && printf '  %-8s NOT ACTIVE YET\n' "$label"
    else
      [ "${1:-}" = show ] && printf '  %-8s ready (error is not about activation: %s)\n' "$label" "$(echo "$out" | head -1 | cut -c1-90)"
    fi
  done
  ami="$(aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text 2>/dev/null)"
  if [ -n "$ami" ]; then
    out="$(aws ec2 run-instances --dry-run --image-id "$ami" --instance-type t3.nano 2>&1)"
    if not_active "$out"; then
      MISS="$MISS launch"
      [ "${1:-}" = show ] && printf '  %-8s NOT ACTIVE YET\n' "launch"
    else
      [ "${1:-}" = show ] && printf '  %-8s ready\n' "launch"
    fi
  fi
  return 0
}
wait_ready() {
  local i
  for i in $(seq 1 180); do
    probe_all
    if [ -z "$MISS" ]; then
      [ "$i" -gt 1 ] && echo "$(date -u +%H:%M) The new AWS account is active now."
      return 0
    fi
    if [ "$i" = 1 ]; then
      echo "The new AWS account is not fully activated by AWS yet (waiting for:$MISS)."
      echo "That is normal for a brand-new account. It usually clears within 5 to 60 minutes, rarely longer."
      echo "I check every minute and continue by myself. Keep this window open; if it disconnects, run the same command again."
    elif [ $((i % 5)) = 0 ]; then
      echo "$(date -u +%H:%M) still waiting for:$MISS"
    fi
    sleep 60
    assume   # the temporary credentials last one hour
  done
  die "AWS has not activated the new account after 3 hours (still waiting for:$MISS). Open a free AWS Support case of type 'Account and billing' and ask them to activate the services of account $ACCOUNT_ID, then run this script again."
}
# <<< readiness

# >>> cloudflare
CF_API=https://api.cloudflare.com/client/v4
CF_ZONE_NAME=vitanaland.com
CF_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
CF_ZONE_ID=""
CF_ASKED=0
cf_call() {   # method path [json body]; the token goes to curl on stdin so it never shows in the process list
  local m="$1" p="$2" d="${3:-}"
  printf 'header = "Authorization: Bearer %s"\n' "$CF_TOKEN" | curl -sS -m 30 --config - -X "$m" -H "Content-Type: application/json" ${d:+--data "$d"} "$CF_API$p"
}
cf_setup() {   # 0 = DNS records can be written through the Cloudflare API
  local r
  [ -n "$CF_ZONE_ID" ] && return 0
  if [ -z "$CF_TOKEN" ] && [ "$CF_ASKED" = 0 ]; then
    CF_ASKED=1
    echo "Cloudflare: paste an API token (Zone > DNS > Edit, only for $CF_ZONE_NAME) and I add the DNS records for you."
    echo "The token is typed hidden, kept in memory and not saved. Press Enter to add the records by hand instead."
    read -rsp "Cloudflare API token: " CF_TOKEN; echo
  fi
  [ -n "$CF_TOKEN" ] || return 1
  r="$(cf_call GET "/zones?name=$CF_ZONE_NAME&status=active")" || { echo "Cloudflare is not reachable from here."; return 1; }
  CF_ZONE_ID="$(jq -r '.result[0].id // empty' <<<"$r" 2>/dev/null)"
  if [ -z "$CF_ZONE_ID" ]; then
    echo "Cloudflare did not accept the token for $CF_ZONE_NAME: $(jq -r '[.errors[]?.message] | join("; ")' <<<"$r" 2>/dev/null | cut -c1-200)"
    echo "(It needs the permission Zone > DNS > Edit for the zone $CF_ZONE_NAME.) I will print the records for you instead."
    CF_TOKEN=""
    return 1
  fi
  return 0
}
cf_cname() {   # name target: create or update a DNS-only CNAME in Cloudflare; 0 on success
  local name="$1" target="$2" r id body
  cf_setup || return 1
  r="$(cf_call GET "/zones/$CF_ZONE_ID/dns_records?name=$name")" || return 1
  id="$(jq -r '.result[0].id // empty' <<<"$r" 2>/dev/null)"
  body="$(jq -nc --arg n "$name" --arg c "$target" '{type:"CNAME",name:$n,content:$c,ttl:1,proxied:false,comment:"vitana-engineering GitLab (setup.sh)"}')"
  if [ -n "$id" ]; then r="$(cf_call PUT "/zones/$CF_ZONE_ID/dns_records/$id" "$body")"; else r="$(cf_call POST "/zones/$CF_ZONE_ID/dns_records" "$body")"; fi
  if [ "$(jq -r '.success' <<<"$r" 2>/dev/null)" = true ]; then echo "Cloudflare: $name -> $target (DNS only) is set."; return 0; fi
  echo "Cloudflare refused the record $name: $(jq -r '[.errors[]?.message] | join("; ")' <<<"$r" 2>/dev/null | cut -c1-300)"
  return 1
}
# <<< cloudflare

ensure_cert() {
  local st rec recname rectarget
  CERT_ARN="$(aws acm list-certificates --certificate-statuses PENDING_VALIDATION ISSUED --query "CertificateSummaryList[?DomainName=='$DOMAIN'].CertificateArn | [0]" --output text)"
  if [ -z "$CERT_ARN" ] || [ "$CERT_ARN" = None ]; then
    CERT_ARN="$(aws acm request-certificate --domain-name "$DOMAIN" --validation-method DNS --query CertificateArn --output text)" || die "certificate request failed"
  fi
  save CERT_ARN "$CERT_ARN"
  st="$(aws acm describe-certificate --certificate-arn "$CERT_ARN" --query Certificate.Status --output text)"
  if [ "$st" != ISSUED ]; then
    rec=""
    for i in $(seq 1 30); do
      rec="$(aws acm describe-certificate --certificate-arn "$CERT_ARN" --query 'Certificate.DomainValidationOptions[0].ResourceRecord.[Name,Value]' --output text 2>/dev/null)"
      case "$rec" in ""|None*) rec=""; sleep 3 ;; *) break ;; esac
    done
    [ -n "$rec" ] || die "certificate validation record not available yet; run again"
    recname="$(echo "$rec" | awk '{print $1}' | sed 's/\.$//')"
    rectarget="$(echo "$rec" | awk '{print $2}' | sed 's/\.$//')"
    if ! cf_cname "$recname" "$rectarget"; then
      echo
      echo "=========== ADD THIS RECORD IN CLOUDFLARE NOW (zone vitanaland.com) ==========="
      echo "  Type:   CNAME      Proxy status: DNS only (grey cloud)"
      echo "  Name:   $recname"
      echo "  Target: $rectarget"
      echo "================================================================================"
    fi
    echo "Waiting up to 15 minutes for the certificate (it is issued a minute or two after the record exists) ..."
    for i in $(seq 1 90); do
      st="$(aws acm describe-certificate --certificate-arn "$CERT_ARN" --query Certificate.Status --output text)"
      [ "$st" = ISSUED ] && break
      sleep 10
    done
    [ "$st" = ISSUED ] || die "certificate not issued yet. Make sure the record above exists in Cloudflare (DNS only), then run:  bash $HERE/setup.sh"
  fi
  echo "Certificate issued."
}

ensure_state_bucket() {
  TFSTATE="vitana-engineering-tfstate-$ACCOUNT_ID"
  if ! aws s3api head-bucket --bucket "$TFSTATE" 2>/dev/null; then
    aws s3api create-bucket --bucket "$TFSTATE" --region eu-central-1 --create-bucket-configuration LocationConstraint=eu-central-1 >/dev/null || die "cannot create the state bucket"
    aws s3api put-bucket-versioning --bucket "$TFSTATE" --versioning-configuration Status=Enabled
    aws s3api put-bucket-encryption --bucket "$TFSTATE" --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
    aws s3api put-public-access-block --bucket "$TFSTATE" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  fi
}

ensure_terraform() {
  if [ ! -x /tmp/tf/terraform ]; then
    mkdir -p /tmp/tf
    curl -fsSL "https://releases.hashicorp.com/terraform/$TF_VERSION/terraform_${TF_VERSION}_linux_amd64.zip" -o /tmp/tf/tf.zip || die "Terraform download failed"
    python3 -c "import zipfile; zipfile.ZipFile('/tmp/tf/tf.zip').extractall('/tmp/tf')" && chmod +x /tmp/tf/terraform || die "Terraform unpack failed"
  fi
  export PATH="/tmp/tf:$PATH" TF_DATA_DIR=/tmp/vitana-eng-tfdata TF_IN_AUTOMATION=1
}

run_terraform() {
  local cur
  cd "$HERE/terraform" || die "terraform directory missing"
  terraform init -input=false -reconfigure -backend-config="bucket=$TFSTATE" -backend-config="key=gitlab-engineering/terraform.tfstate" \
    -backend-config="region=eu-central-1" -backend-config="use_lockfile=true" -backend-config="encrypt=true" >/tmp/tf-init.log 2>&1 \
    || { tail -25 /tmp/tf-init.log; die "terraform init failed"; }
  # Never resize machines that already exist by accident: keep their size unless "grow" asked for it.
  if [ "${GROW:-0}" != 1 ]; then
    cur="$(terraform state show -no-color aws_instance.gitlab 2>/dev/null | awk '$1 == "instance_type" {print $3}' | tr -d '"')"
    [ -z "$cur" ] || SIZE_GITLAB="$cur"
    cur="$(terraform state show -no-color aws_instance.runner 2>/dev/null | awk '$1 == "instance_type" {print $3}' | tr -d '"')"
    [ -z "$cur" ] || SIZE_RUNNER="$cur"
  fi
  terraform apply -input=false -auto-approve -var "certificate_arn=$CERT_ARN" -var "gitlab_version=$GITLAB_VERSION" \
    -var "runner_version=$RUNNER_VERSION" -var "domain=$DOMAIN" -var "admin_email=$ADMIN_EMAIL" \
    -var "gitlab_instance_type=$SIZE_GITLAB" -var "runner_instance_type=$SIZE_RUNNER" || die "terraform apply failed. Read the message above. For PendingVerification or VcpuLimitExceeded wait a while, then run again; the script continues where it stopped"
  save ALB_DNS "$(terraform output -raw alb_dns)"
  save GITLAB_ID "$(terraform output -raw gitlab_instance_id)"
  save RUNNER_ID "$(terraform output -raw runner_instance_id)"
  . "$STATE"
}

store_token() {
  local t
  echo "GitHub token for the mirror: fine-grained, read-only, repositories exafyltd/vitana-platform and exafyltd/vitana-v1,"
  echo "permissions Contents: Read-only + Metadata: Read-only.  (GitHub > Settings > Developer settings > Fine-grained tokens)"
  read -rsp "Paste the token (Enter to skip for now): " t; echo
  if [ -n "$t" ]; then
    aws secretsmanager put-secret-value --secret-id vitana/engineering/gitlab/github-mirror-token --secret-string "$t" >/dev/null && echo "Token stored. The mirror starts within 5 minutes." || echo "Could not store the token."
  else
    echo "Skipped. Later:  bash $HERE/setup.sh token"
  fi
}

ssm_run() {   # instance-id, shell command; SSM_WAIT = number of 3-second polls to wait for the result (default 20)
  local cid st i waits="${SSM_WAIT:-20}"
  cid="$(aws ssm send-command --instance-ids "$1" --document-name AWS-RunShellScript --parameters "$(jq -nc --arg c "$2" '{commands:[$c]}')" --query Command.CommandId --output text 2>/dev/null)" || { echo "(SSM not ready yet for $1)"; return; }
  for i in $(seq 1 "$waits"); do
    sleep 3
    st="$(aws ssm get-command-invocation --command-id "$cid" --instance-id "$1" --query Status --output text 2>/dev/null)"
    case "$st" in
      InProgress|Pending|Delayed|"") if [ "$waits" -gt 20 ] && [ $((i % 20)) = 0 ]; then echo "  ... still working ($((i * 3)) s)" >&2; fi ;;
      *) break ;;
    esac
  done
  aws ssm get-command-invocation --command-id "$cid" --instance-id "$1" --query StandardOutputContent --output text 2>/dev/null
}

find_instance() {   # Name tag -> id of a machine that is not terminated, or nothing
  aws ec2 describe-instances --filters "Name=tag:Name,Values=$1" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[0].InstanceId | [0]' --output text 2>/dev/null | grep -v '^None$' || true
}
machines_exist() { [ -n "$(find_instance vitana-eng-gitlab)" ]; }

case "${1:-run}" in
  run)
    cf_setup || true
    ensure_account; assume
    if machines_exist; then echo "The machines already exist; keeping their size."; else quota_request; fi
    wait_ready; ensure_cert
    machines_exist || quota_check
    assume; ensure_state_bucket; ensure_terraform
    echo "Building the infrastructure (about 10 minutes) ..."
    run_terraform
    echo
    if cf_cname "$DOMAIN" "$ALB_DNS"; then
      echo "================ DONE: INFRASTRUCTURE IS UP AND DNS IS SET ================"
    else
      echo "================ DONE: INFRASTRUCTURE IS UP. NEXT, IN CLOUDFLARE ================"
      echo "  Type:   CNAME      Proxy status: DNS only (grey cloud)"
      echo "  Name:   gitlab"
      echo "  Target: $ALB_DNS"
      echo "================================================================================="
    fi
    CF_TOKEN=""
    echo "GitLab installs itself on the new machine (about 15 minutes). Check progress:  bash $HERE/setup.sh status"
    echo "Then open https://$DOMAIN  (user: root; password: bash $HERE/setup.sh password)"
    echo
    store_token
    ;;
  status)
    ensure_account >/dev/null; assume; . "$STATE"
    GITLAB_ID="${GITLAB_ID:-$(find_instance vitana-eng-gitlab)}"; RUNNER_ID="${RUNNER_ID:-$(find_instance vitana-eng-runner)}"
    echo "--- GitLab host ${GITLAB_ID:-?}"
    ssm_run "$GITLAB_ID" 'tail -n 14 /var/log/vitana-bootstrap.log; echo; cat /var/log/vitana-bootstrap.done 2>/dev/null; gitlab-ctl status 2>/dev/null | head -5'
    echo "--- Runner host ${RUNNER_ID:-?}"
    ssm_run "$RUNNER_ID" 'tail -n 8 /var/log/vitana-bootstrap.log; gitlab-runner verify 2>&1 | tail -3'
    ;;
  runner)
    ensure_account >/dev/null; assume; . "$STATE"
    RUNNER_ID="${RUNNER_ID:-$(find_instance vitana-eng-runner)}"
    [ -n "$RUNNER_ID" ] || die "the runner machine does not exist yet; run the main command first"
    echo "Registering the runner (waits until the runner machine can reach https://$DOMAIN, up to 30 minutes) ..."
    SSM_WAIT=620 ssm_run "$RUNNER_ID" "$(cat "$HERE/host/runner-fix.sh")"
    ;;
  grow)
    ensure_account >/dev/null; assume; . "$STATE"
    v="$(quota_value)" || v=""
    { [ -n "$v" ] && [ "$v" -ge 8 ]; } 2>/dev/null || die "the EC2 vCPU limit in Frankfurt is ${v:-unknown}; full size needs 8. Ask AWS to raise it first (Service Quotas > EC2 > Running On-Demand Standard instances)."
    [ -n "${CERT_ARN:-}" ] || die "run the main command first"
    ensure_state_bucket; ensure_terraform
    SIZE_GITLAB=m6i.xlarge; SIZE_RUNNER=m6i.xlarge; GROW=1
    echo "Growing both machines to full size (GitLab restarts: a few minutes of downtime) ..."
    run_terraform
    ;;
  password)
    ensure_account >/dev/null; assume
    aws secretsmanager get-secret-value --secret-id vitana/engineering/gitlab/root-password --query SecretString --output text
    ;;
  token)
    ensure_account >/dev/null; assume
    store_token
    ;;
  diag)
    ensure_account >/dev/null; assume
    echo "Services of the new AWS account $ACCOUNT_ID:"
    probe_all show
    if [ -z "$MISS" ]; then echo "All ready."; else echo "Not active yet:$MISS  (AWS activates these in the background; the main command waits for it by itself)"; fi
    ;;
  *) die "usage: bash $0 [run|status|password|token|diag|runner|grow]" ;;
esac
