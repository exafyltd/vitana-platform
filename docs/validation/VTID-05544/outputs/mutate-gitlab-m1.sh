#!/usr/bin/env bash
# Mutation check for scripts/eng/gitlab-m1-structure.test.mjs (VTID-05544, lane eng-gitlab-m1/gitlab-infra).
# One property of the bundle is broken at a time in a scratch copy, and the test must go red. A mutation counts as caught only when
#   - the mutated file still parses as what it is (bash -n, a YAML parser, the Terraform formatter's parser), and
#   - the test fails on a named case (a crash before any case runs is CRASH, not a catch).
# A mutation that changes nothing (NOOP), breaks the syntax by accident (INVALID) or leaves the test green (SURVIVED) is reported
# as not caught: it proves nothing, or it shows a property the test does not pin.
# EXPECT_INVALID=1 marks the mutations whose point is a file that does not parse; the harness then requires that it does not.
#
# usage: mutate-gitlab-m1.sh <worktree containing infra/gitlab-engineering and scripts/eng>
# env:   TERRAFORM  path of the terraform binary (default: terraform)
#        PYLIB      directory holding PyYAML, if it is not installed
#        TMPDIR     where the scratch copies go (default /tmp)
#        ONLY       regex on the mutation name: run a subset
set -u
SRC="${1:?worktree}"
TF="${TERRAFORM:-terraform}"
TEST=scripts/eng/gitlab-m1-structure.test.mjs
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mutm1-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
total=0; bad=0

command -v "$TF" >/dev/null || { echo "terraform not found (set TERRAFORM): the .tf guard cannot run"; exit 2; }
PYTHONPATH="${PYLIB:-}" python3 -c 'import yaml' 2>/dev/null || { echo "PyYAML not found (set PYLIB): the YAML guard cannot run"; exit 2; }

parses() {   # file -> exit 0 when the file still parses as its extension says
  case "$1" in
    *.sh)         bash -n "$1" 2>/dev/null ;;
    *.yml|*.yaml) PYTHONPATH="${PYLIB:-}" python3 -c 'import sys, yaml; yaml.safe_load(open(sys.argv[1]))' "$1" 2>/dev/null ;;
    *.tf)         "$TF" fmt -list=false -write=false "$1" >/dev/null 2>&1 ;;   # exit 2 on a syntax error, 0 otherwise
    *)            return 0 ;;
  esac
}

# The unmutated tree must pass, or every "caught" below would be meaningless.
base="$(cd "$SRC" && node --test "$TEST" 2>&1)"
if ! grep -q '^# fail 0' <<<"$base"; then echo "baseline: the test fails on the unmutated tree"; grep -E '^not ok' <<<"$base" | head; exit 2; fi
echo "baseline: $(grep -E '^# tests ' <<<"$base" | cut -c3-) and $(grep -E '^# pass ' <<<"$base" | cut -c3-) on the unmutated tree"

run_mut() {   # name, file (relative to infra/gitlab-engineering), perl expression
  local name="$1" file="$2" expr="$3"
  if [ -n "${ONLY:-}" ] && ! [[ "$name" =~ $ONLY ]]; then return; fi
  rm -rf "$WORK/t"; mkdir -p "$WORK/t/scripts/eng" "$WORK/t/infra"
  cp -r "$SRC/infra/gitlab-engineering" "$WORK/t/infra/"; cp "$SRC/$TEST" "$WORK/t/scripts/eng/"
  local f="$WORK/t/infra/gitlab-engineering/$file" before after
  before="$(sha256sum "$f" | cut -c1-16)"
  perl -0pi -e "$expr" "$f"
  after="$(sha256sum "$f" | cut -c1-16)"
  total=$((total + 1))
  if [ "$before" = "$after" ]; then echo "NOOP        $name (the mutation changed nothing: fix the mutation)"; bad=$((bad + 1)); return; fi
  if [ "${EXPECT_INVALID:-0}" = 1 ]; then
    if parses "$f"; then echo "NOT-INVALID $name (meant to break the syntax, but the file still parses)"; bad=$((bad + 1)); return; fi
  elif ! parses "$f"; then
    echo "INVALID     $name (the mutated file does not parse: it proves nothing)"; bad=$((bad + 1)); return
  fi
  local out rc ntests failed
  out="$(cd "$WORK/t" && timeout 120 node --test "$TEST" 2>&1)"; rc=$?
  ntests="$(grep -E '^# tests ' <<<"$out" | awk '{print $3}')"
  failed="$(grep -E '^not ok' <<<"$out" | sed -E 's/^not ok [0-9]+ - //' | cut -c1-60 | head -3 | paste -sd'|' -)"
  if [ "$rc" = 124 ]; then echo "HUNG        $name"; bad=$((bad + 1))
  elif [ "$rc" = 0 ] && grep -q '^# fail 0' <<<"$out"; then echo "SURVIVED    $name"; bad=$((bad + 1))
  elif [ "${ntests:-0}" = 1 ]; then echo "CRASH       $name (the test file crashed before running a case: $failed)"; bad=$((bad + 1))
  else echo "caught      $name  <- $failed"; fi
}
# exact-string mutation, no regex escaping: name, file, old text, new text (the first occurrence is replaced)
run_str() { OLD="$3" NEW="$4" run_mut "$1" "$2" 's/\Q$ENV{OLD}\E/$ENV{NEW}/'; }

M=terraform/main.tf; S=setup.sh; CFG=host/gitlab-configure.sh; INS=host/gitlab-install.sh; MIR=host/mirror.sh; BAK=host/backup.sh
CP=host/ci-platform.yml; CV=host/ci-v1.yml

# ---- test 1: both machines
run_mut "gitlab gets a public IP"            $M 's/(resource "aws_instance" "gitlab".*?associate_public_ip_address\s*=\s*)false/${1}true/s'
run_mut "runner gets a public IP"            $M 's/(resource "aws_instance" "runner".*?associate_public_ip_address\s*=\s*)false/${1}true/s'
run_mut "IMDSv2 optional on runner"          $M 's/(resource "aws_instance" "runner".*?http_tokens\s*=\s*)"required"/${1}"optional"/s'
run_mut "IMDSv2 optional on gitlab"          $M 's/(resource "aws_instance" "gitlab".*?http_tokens\s*=\s*)"required"/${1}"optional"/s'
run_mut "hop limit 2 on gitlab"              $M 's/(resource "aws_instance" "gitlab".*?http_put_response_hop_limit\s*=\s*)1/${1}2/s'
run_mut "hop limit 2 on runner"              $M 's/(resource "aws_instance" "runner".*?http_put_response_hop_limit\s*=\s*)1/${1}2/s'
run_mut "gitlab volume unencrypted"          $M 's/(resource "aws_instance" "gitlab".*?encrypted\s*=\s*)true/${1}false/s'
run_mut "runner volume unencrypted"          $M 's/(resource "aws_instance" "runner".*?encrypted\s*=\s*)true/${1}false/s'
run_mut "runner volume loses its key"        $M 's/(resource "aws_instance" "runner".*?)kms_key_id\s*=\s*aws_kms_key\.main\.arn\n/${1}/s'
run_mut "gitlab volume loses its key"        $M 's/(resource "aws_instance" "gitlab".*?)kms_key_id\s*=\s*aws_kms_key\.main\.arn\n/${1}/s'
run_str "gitlab in a public subnet"          $M '  subnet_id                   = aws_subnet.private[0].id' '  subnet_id                   = aws_subnet.public[0].id'
run_str "runner in a public subnet"          $M '  subnet_id                   = aws_subnet.private[1].id' '  subnet_id                   = aws_subnet.public[1].id'
run_str "metadata endpoint switched off"     $M '    http_endpoint               = "enabled"' '    http_endpoint               = "disabled"'
# ---- test 2: sizes are variables
run_mut "gitlab size hard-coded"             $M 's/instance_type\s*=\s*var\.gitlab_instance_type/instance_type = "m6i.xlarge"/'
run_str "runner size hard-coded"             $M 'instance_type               = var.runner_instance_type' 'instance_type               = "m6i.xlarge"'
run_str "gitlab size default changed"        $M $'variable "gitlab_instance_type" {\n  type    = string\n  default = "m6i.xlarge"' $'variable "gitlab_instance_type" {\n  type    = string\n  default = "m6i.large"'
run_str "runner size default changed"        $M $'variable "runner_instance_type" {\n  type    = string\n  default = "m6i.xlarge"' $'variable "runner_instance_type" {\n  type    = string\n  default = "m6i.2xlarge"'
# ---- test 3: volumes
run_str "gitlab volume 100 GB"               $M '    volume_size           = 200' '    volume_size           = 100'
run_str "runner volume 50 GB"                $M '    volume_size           = 100' '    volume_size           = 50'
run_str "gitlab volume gp2"                  $M '    volume_type           = "gp3"' '    volume_type           = "gp2"'
run_mut "runner volume gp2"                  $M 's/(resource "aws_instance" "runner".*?volume_type\s*=\s*)"gp3"/${1}"gp2"/s'
# ---- test 4: Terraform state and versions
run_mut "backend loses lockfile (setup.sh)"  $S 's/-backend-config="use_lockfile=true"//'
run_str "backend encryption dropped"         $S ' -backend-config="encrypt=true"' ''
run_str "Terraform minimum lowered"          $M 'required_version = ">= 1.10.0"' 'required_version = ">= 1.5.0"'
run_str "AWS provider 6 allowed"             $M 'version = ">= 5.60.0, < 6.0.0"' 'version = ">= 5.60.0"'
# ---- test 5: backup bucket
run_mut "backup bucket SSE becomes AES256"   $M 's/sse_algorithm\s*=\s*"aws:kms"/sse_algorithm = "AES256"/'
run_str "backup bucket SSE key dropped"      $M $'      kms_master_key_id = aws_kms_key.main.arn\n' ''
run_mut "backup versioning suspended"        $M 's/(resource "aws_s3_bucket_versioning" "backups".*?status\s*=\s*)"Enabled"/${1}"Suspended"/s'
run_mut "backup bucket allows public ACLs"   $M 's/block_public_acls\s*=\s*true/block_public_acls = false/'
run_str "backup bucket allows public policy" $M 'block_public_policy     = true' 'block_public_policy     = false'
run_str "backup bucket ignores no public ACL" $M 'ignore_public_acls      = true' 'ignore_public_acls      = false'
run_str "backup bucket not restricted"       $M 'restrict_public_buckets = true' 'restrict_public_buckets = false'
run_mut "backup expiry 365 days"             $M 's/(expiration \{\n\s*days\s*=\s*)30\n/${1}365\n/'
run_mut "TLS-only deny removed"              $M 's/test\s*=\s*"Bool"\n\s*variable\s*=\s*"aws:SecureTransport"/test = "Bool"\n      variable = "aws:UserAgent"/'
run_str "TLS-only deny becomes allow"        $M '    effect    = "Deny"' '    effect    = "Allow"'
run_str "bucket name without the account id" $M 'backup_bucket = "vitana-engineering-gitlab-backups-${data.aws_caller_identity.me.account_id}"' 'backup_bucket = "vitana-engineering-gitlab-backups"'
# ---- test 6: secrets and key
run_mut "secret without the key"             $M 's/(resource "aws_secretsmanager_secret" "github_token".*?)kms_key_id\s*=\s*aws_kms_key\.main\.arn\n/${1}/s'
run_mut "extra secret"                       $M 's/(# -+ IAM)/resource "aws_secretsmanager_secret" "extra" {\n  name = "x"\n  kms_key_id = aws_kms_key.main.arn\n}\n\n${1}/'
run_str "root password secret renamed"       $M 'name                    = "vitana/engineering/gitlab/root-password"' 'name                    = "vitana/engineering/gitlab/rootpw"'
run_str "key rotation off"                   $M 'enable_key_rotation     = true' 'enable_key_rotation     = false'
run_str "key alias renamed"                  $M 'name          = "alias/vitana-engineering"' 'name          = "alias/vitana-eng"'
# ---- test 7: security groups
run_mut "gitlab ingress open to the world"   $M 's/(resource "aws_vpc_security_group_ingress_rule" "gitlab_from_alb" \{\n\s*security_group_id\s*=\s*aws_security_group\.gitlab\.id\n)/${1}  cidr_ipv4 = "0.0.0.0\/0"\n/'
run_mut "runner gets an inbound rule"        $M 's/(# -+ storage)/resource "aws_vpc_security_group_ingress_rule" "runner_ssh" {\n  security_group_id = aws_security_group.runner.id\n  cidr_ipv4 = "10.0.0.0\/8"\n  from_port = 22\n  to_port = 22\n  ip_protocol = "tcp"\n}\n\n${1}/'
run_mut "load balancer rule on port 80"      $M 's/(resource "aws_vpc_security_group_ingress_rule" "alb_https".*?from_port\s*=\s*)443/${1}80/s'
run_mut "gitlab ingress to port 8080"        $M 's/(resource "aws_vpc_security_group_ingress_rule" "gitlab_from_alb".*?to_port\s*=\s*)80\b/${1}8080/s'
run_str "inline ingress on the runner group" $M $'  description = "CI runner: no inbound access"\n  vpc_id      = aws_vpc.main.id\n' $'  description = "CI runner: no inbound access"\n  vpc_id      = aws_vpc.main.id\n  ingress {\n    from_port   = 22\n    to_port     = 22\n    protocol    = "tcp"\n    cidr_blocks = ["10.0.0.0/8"]\n  }\n'
run_mut "legacy security group rule"         $M 's/(# -+ outputs)/resource "aws_security_group_rule" "x" {\n  type = "ingress"\n  security_group_id = aws_security_group.runner.id\n  cidr_blocks = ["10.0.0.0\/8"]\n  from_port = 22\n  to_port = 22\n  protocol = "tcp"\n}\n\n${1}/'
# ---- tests 8-10: IAM
run_mut "admin policy attached"              $M 's/(arn:aws:iam::aws:policy\/AmazonSSMManagedInstanceCore"\n\}\n\ndata "aws_iam_policy_document" "gitlab")/arn:aws:iam::aws:policy\/AdministratorAccess"\n}\n\ndata "aws_iam_policy_document" "gitlab"/'
run_mut "extra managed policy attached"      $M 's/(data "aws_iam_policy_document" "gitlab" \{)/resource "aws_iam_role_policy_attachment" "gitlab_s3" {\n  role       = aws_iam_role.gitlab.name\n  policy_arn = "arn:aws:iam::aws:policy\/AmazonS3FullAccess"\n}\n\n${1}/'
run_mut "wildcard resource in gitlab policy" $M 's/(actions\s*=\s*\["kms:GenerateDataKey", "kms:Decrypt"\]\n\s*resources\s*=\s*)\[aws_kms_key\.main\.arn\]/${1}["*"]/'
run_str "wildcard action in gitlab policy"   $M '"s3:PutObject", "s3:GetObject"' '"s3:*", "s3:GetObject"'
run_mut "runner may read every secret"       $M 's/(sid\s*=\s*"ReadOwnRunnerToken"\n\s*actions\s*=\s*\["secretsmanager:GetSecretValue"\]\n\s*resources\s*=\s*)\[aws_secretsmanager_secret\.runner_token\.arn\]/${1}["*"]/'
run_mut "runner may read the mirror token"   $M 's/(sid\s*=\s*"ReadOwnRunnerToken"\n\s*actions\s*=\s*\["secretsmanager:GetSecretValue"\]\n\s*resources\s*=\s*)\[aws_secretsmanager_secret\.runner_token\.arn\]/${1}[aws_secretsmanager_secret.github_token.arn]/'
run_mut "gitlab may read the root password"  $M 's/(sid\s*=\s*"ReadMirrorToken"\n\s*actions\s*=\s*\["secretsmanager:GetSecretValue"\]\n\s*resources\s*=\s*)\[aws_secretsmanager_secret\.github_token\.arn\]/${1}[aws_secretsmanager_secret.github_token.arn, aws_secretsmanager_secret.root_password.arn]/'
run_mut "gitlab may read the runner token"   $M 's/(sid\s*=\s*"ReadMirrorToken"\n\s*actions\s*=\s*\["secretsmanager:GetSecretValue"\]\n\s*resources\s*=\s*)\[aws_secretsmanager_secret\.github_token\.arn\]/${1}[aws_secretsmanager_secret.github_token.arn, aws_secretsmanager_secret.runner_token.arn]/'
run_str "gitlab may write the mirror token"  $M 'resources = [aws_secretsmanager_secret.root_password.arn, aws_secretsmanager_secret.runner_token.arn]' 'resources = [aws_secretsmanager_secret.root_password.arn, aws_secretsmanager_secret.runner_token.arn, aws_secretsmanager_secret.github_token.arn]'
# ---- test 11: load balancer
run_mut "load balancer opens port 80"        $M 's/(# -+ outputs)/resource "aws_lb_listener" "http" {\n  load_balancer_arn = aws_lb.gitlab.arn\n  port = 80\n  protocol = "HTTP"\n  default_action {\n    type = "forward"\n    target_group_arn = aws_lb_target_group.gitlab.arn\n  }\n}\n\n${1}/'
run_mut "old TLS policy"                     $M 's/ELBSecurityPolicy-TLS13-1-2-2021-06/ELBSecurityPolicy-2016-08/'
run_str "listener protocol HTTP"             $M 'protocol          = "HTTPS"' 'protocol          = "HTTP"'
run_str "listener port 8443"                 $M '  port              = 443' '  port              = 8443'
run_str "health check path changed"          $M 'path                = "/users/sign_in"' 'path                = "/"'
run_str "load balancer internal"             $M 'internal                   = false' 'internal                   = true'
run_str "invalid headers kept"               $M 'drop_invalid_header_fields = true' 'drop_invalid_header_fields = false'
# ---- test 12: network
run_mut "peering to production"              $M 's/(# -+ outputs)/resource "aws_vpc_peering_connection" "prod" {\n  vpc_id = aws_vpc.main.id\n  peer_vpc_id = "vpc-0"\n}\n\n${1}/'
run_mut "transit gateway"                    $M 's/(# -+ outputs)/resource "aws_ec2_transit_gateway" "x" {}\n\n${1}/'
run_mut "VPC overlaps production"            $M 's/10\.20\.0\.0\/16/10.0.0.0\/16/'
run_mut "second NAT gateway"                 $M 's/(# -+ load balancer)/resource "aws_nat_gateway" "nat2" {\n  allocation_id = aws_eip.nat.id\n  subnet_id = aws_subnet.public[1].id\n}\n\n${1}/'
run_str "S3 endpoint replaced"               $M 'service_name      = "com.amazonaws.${var.region}.s3"' 'service_name      = "com.amazonaws.${var.region}.ec2"'
run_str "one availability zone"              $M 'slice(data.aws_availability_zones.az.names, 0, 2)' 'slice(data.aws_availability_zones.az.names, 0, 1)'
run_str "older Ubuntu image"                 $M 'ubuntu/server/24.04/stable' 'ubuntu/server/22.04/stable'
# ---- test 13: host files
run_str "a host file renamed in the list"    $M '"gitlab-install.sh", "gitlab-configure.sh"' '"gitlab-install2.sh", "gitlab-configure.sh"'
run_str "host file list shortened"           $M ', "ci-platform.yml", "ci-v1.yml"]' ', "ci-platform.yml"]'
# ---- test 14: bash -n (the mutants are meant not to parse)
EXPECT_INVALID=1 run_mut "backup.sh with a syntax error" $BAK 's/\z/\nif then fi\n/'
EXPECT_INVALID=1 run_mut "setup.sh with a syntax error"  $S   's/\z/\nif then fi\n/'
EXPECT_INVALID=1 run_mut "runner-install.sh with a syntax error" host/runner-install.sh 's/\z/\nif then fi\n/'
# ---- test 15: xtrace
run_mut "xtrace in mirror.sh"                $MIR 's/\n(set -uo pipefail|set -u)/\nset -x\n${1}/'
run_mut "xtrace in setup.sh"                 $S 's/\nset -uo pipefail/\nset -x\nset -uo pipefail/'
run_str "xtrace in backup.sh by option"      $BAK 'set -euo pipefail' 'set -euxo pipefail'
run_str "xtrace in gitlab-install.sh by name" $INS $'\n. /etc/vitana/env' $'\nset -o xtrace\n. /etc/vitana/env'
# ---- test 16: Cloudflare token
run_mut "Cloudflare token echoed to a file"  $S 's/(CF_TOKEN="\$\{CLOUDFLARE_API_TOKEN:-\}"\n)/${1}echo "\$CF_TOKEN" > \/tmp\/cf\n/'
run_mut "Cloudflare token on the curl line"  $S 's/printf .header = "Authorization: Bearer %s"\\n. "\$CF_TOKEN" \| curl -sS -m 30 --config -/curl -sS -m 30 -H "Authorization: Bearer \$CF_TOKEN"/'
run_mut "Cloudflare token typed visibly"     $S 's/read -rsp "Cloudflare API token: "/read -rp "Cloudflare API token: "/'
# ---- test 17: GitHub token
run_mut "GitHub token typed visibly"         $S 's/read -rsp "Paste the token/read -rp "Paste the token/'
run_str "GitHub token also written to a file" $S '--secret-string "$t" >/dev/null && echo' '--secret-string "$t" >/dev/null; echo "$t" > /tmp/t; echo'
run_str "GitHub token logged"                $S $'  if [ -n "$t" ]; then\n' $'  if [ -n "$t" ]; then\n    echo "token: $t"\n'
run_str "GitHub token stored under another secret" $S 'put-secret-value --secret-id vitana/engineering/gitlab/github-mirror-token' 'put-secret-value --secret-id vitana/engineering/gitlab/root-password'
# ---- test 18: region
run_mut "AWS_REGION export dropped"          $S 's/AWS_PAGER="" AWS_REGION=eu-central-1 AWS_DEFAULT_REGION/AWS_PAGER="" AWS_DEFAULT_REGION/'
# ---- test 19: secrets on the machine
run_mut "bootstrap token never expires"      $CFG 's/, expires_at: 7\.days\.from_now//'
run_mut "PAT file world readable"            $CFG 's/\(umask 077; echo "\$PAT" > "\$PAT_FILE"\)/echo "\$PAT" > "\$PAT_FILE"/'
run_str "mirror token file world readable"   $CFG '(umask 077; echo "$MT" > /etc/vitana/mirror-token)' 'echo "$MT" > /etc/vitana/mirror-token'
run_mut "mirror push without scrub"          $MIR 's/(git -C "\$d" push -q "\$url" refs\/heads\/main:refs\/heads\/main) 2>&1 \| scrub/${1} 2>\&1/'
run_str "mirror fetch without scrub"         $MIR $'\'+refs/tags/*:refs/tags/*\' 2>&1 | scrub; then' $'\'+refs/tags/*:refs/tags/*\' 2>&1; then'
run_str "mirror push --prune without scrub"  $MIR $'\'+refs/tags/*:refs/tags/*\' 2>&1 | scrub || { echo "push all failed' $'\'+refs/tags/*:refs/tags/*\' 2>&1 || { echo "push all failed'
run_str "scrub forgets the GitLab token"     $MIR ' -e "s/$GL/***/g"' ''
run_str "scrub forgets the GitHub token"     $MIR 'sed -e "s/$GH/***/g" ' 'sed '
# ---- test 20: instance settings
run_mut "sign-up enabled"                    $CFG 's/signup_enabled=false/signup_enabled=true/'
run_mut "two-factor optional"                $CFG 's/require_two_factor_authentication=true/require_two_factor_authentication=false/'
run_str "two-factor grace period 0"          $CFG 'two_factor_grace_period=48' 'two_factor_grace_period=0'
run_str "usage ping on"                      $CFG 'usage_ping_enabled=false' 'usage_ping_enabled=true'
run_str "projects public by default"         $CFG 'default_project_visibility=private' 'default_project_visibility=public'
run_str "groups internal by default"         $CFG 'default_group_visibility=private' 'default_group_visibility=internal'
run_str "external_url over http"             $INS "external_url 'https://\$DOMAIN'" "external_url 'http://\$DOMAIN'"
run_str "nginx terminates TLS itself"        $INS "['listen_https'] = false" "['listen_https'] = true"
run_str "swap smaller"                       $INS 'fallocate -l 4G /swapfile' 'fallocate -l 1G /swapfile'
# ---- test 21: nightly backup
run_mut "backup moved to noon"               $CFG "s/'15 2 \\* \\* \\*/'15 12 * * */"
run_str "backup strategy streaming"          $BAK ' STRATEGY=copy' ''
run_str "backup archive not uploaded"        $BAK 'aws s3 cp "$latest" "s3://$BACKUP_BUCKET/backups/$(basename "$latest")"' 'true'
run_str "config archive not uploaded"        $BAK 'aws s3 cp "/tmp/gitlab-config-$d.tgz" "s3://$BACKUP_BUCKET/config/gitlab-config-$d.tgz"' 'true'
run_str "config archive without the secrets" $BAK 'tar -czf "/tmp/gitlab-config-$d.tgz" -C / etc/gitlab' 'tar -czf "/tmp/gitlab-config-$d.tgz" -C / etc/hostname'
run_str "backup goes on after an error"      $BAK 'set -euo pipefail' 'set -uo pipefail'
# ---- test 22: which pipelines run
run_mut "CI runs on merge requests"          $CP 's/(- if: \$CI_PIPELINE_SOURCE =~ \/\^\(web\|api\|schedule\)\$\/)/${1}\n    - if: \$CI_PIPELINE_SOURCE == "merge_request_event"/'
run_mut "CI runs on every branch"            $CV 's/- if: \$CI_COMMIT_BRANCH == "main"/- if: \$CI_COMMIT_BRANCH/'
run_str "API and schedule pipelines dropped" $CP $'    - if: $CI_PIPELINE_SOURCE =~ /^(web|api|schedule)$/\n' ''
run_str "a second stage appears"             $CV 'stages: [check]' 'stages: [check, deploy]'
# ---- test 23: runner tag, credentials, deploys
run_mut "default tag changed"                $CP 's/default:\n  tags: \[vitana-eng\]/default:\n  tags: [shared]/'
run_mut "a job overrides the tag"            $CV 's/(unit-tests:\n  extends: \.install\n)/${1}  tags: [docker]\n/'
run_mut "AWS credential in CI"               $CP 's/(variables:\n  NODE_ENV: test)/${1}\n  AWS_ACCESS_KEY_ID: x/'
run_mut "a deploy job appears"               $CV 's/\z/\ndeploy-prod:\n  stage: check\n  script:\n    - echo deploy\n/'
run_mut "environment keyword appears"        $CV 's/(build:\n  extends: \.install\n)/${1}  environment: production\n/'
run_str "OIDC id_tokens appear"              $CP $'default:\n  tags: [vitana-eng]' $'default:\n  tags: [vitana-eng]\n  id_tokens:\n    T:\n      aud: x'
run_str "kubectl appears"                    $CV $'    - npm test\n' $'    - npm test\n    - kubectl apply -f x\n'
run_str "other container image"              $CV 'image: public.ecr.aws/docker/library/node:20-bookworm' 'image: node:latest'
# ---- test 24: the platform file
run_mut "pnpm version drifts"                $CP 's/pnpm\@9\.0\.0/pnpm\@latest/'
run_mut "Jest shards reduced to 2"           $CP 's/parallel: 4/parallel: 2/'
run_mut "typecheck installs with pnpm (the bug)" $CP 's/    - npm ci --no-audit --no-fund\n    - pnpm run typecheck/    - pnpm install --frozen-lockfile\n    - pnpm run typecheck/'
run_mut "typecheck install dropped"          $CP 's/    - npm ci --no-audit --no-fund\n//'
run_mut "jest install dropped"               $CP 's/    - pnpm install --frozen-lockfile\n    - npx jest/    - npx jest/'
run_mut "jest installs with npm"             $CP 's/    - pnpm install --frozen-lockfile\n    - npx jest/    - npm ci --no-audit --no-fund\n    - npx jest/'
run_mut "shared install back in before_script" $CP 's/(    - cd services\/gateway\n)/${1}    - pnpm install --frozen-lockfile\n/'
run_mut "prisma step added"                  $CP 's/(    - pnpm run typecheck)/    - pnpm exec prisma generate\n${1}/'
run_mut "typecheck dropped"                  $CP 's/^    - pnpm run typecheck$/    - echo skip/m'
run_str "typecheck memory limit lowered"     $CP 'NODE_OPTIONS: "--max-old-space-size=6144"' 'NODE_OPTIONS: "--max-old-space-size=1024"'
# ---- test 25: vitana-v1 file
run_mut "v1 lint blocks the pipeline"        $CV 's/  allow_failure: true\n//'
run_mut "v1 build allowed to fail"           $CV 's/(build:\n  extends: \.install\n)/${1}  allow_failure: true\n/'
run_mut "v1 tests dropped"                   $CV 's/- npm test\n/- echo skip\n/'
run_str "v1 install without prefer-offline"  $CV ' --prefer-offline' ''
# ---- test 26: RUNBOOK
run_mut "RUNBOOK copy of the CI file drifts" RUNBOOK.md 's/(Step 0[\s\S]*?)- npm ci --no-audit --no-fund/${1}- npm install/'
run_mut "CI file changes, RUNBOOK copy stays" $CP 's/(    - npm ci --no-audit --no-fund\n)/${1}    - echo extra\n/'

echo; echo "mutations: $total   caught: $((total - bad))   not caught: $bad"
[ "$bad" -eq 0 ]
