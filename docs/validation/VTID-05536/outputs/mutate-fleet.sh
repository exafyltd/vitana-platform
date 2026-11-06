#!/usr/bin/env bash
# Mutation check for scripts/eng/fleet-structure.test.mjs: break one property at a time in a scratch copy of the lane's files and require the
# test to go red on a named case. A mutation that leaves the test green means the test does not pin that property.
# usage: mutate-fleet.sh <source tree containing infra/gitlab-engineering and scripts/eng>      (scratch copies go under $TMPDIR)
# A mutation counts as caught only when the file really changed (NOOP otherwise) and the test then reports at least one failing case.
set -u
SRC="${1:?source tree}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mut-fleet-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
TEST=scripts/eng/fleet-structure.test.mjs
survivors=0; total=0

run_mut() {   # name, file (relative to infra/gitlab-engineering), perl expression
  local name="$1" file="$2" expr="$3"
  rm -rf "$WORK/t"; mkdir -p "$WORK/t/scripts/eng" "$WORK/t/infra"
  cp -r "$SRC/infra/gitlab-engineering" "$WORK/t/infra/"; cp "$SRC/$TEST" "$WORK/t/scripts/eng/"
  local before after
  before="$(sha256sum "$WORK/t/infra/gitlab-engineering/$file" | cut -c1-16)"
  perl -0pi -e "$expr" "$WORK/t/infra/gitlab-engineering/$file"
  after="$(sha256sum "$WORK/t/infra/gitlab-engineering/$file" | cut -c1-16)"
  total=$((total + 1))
  if [ "$before" = "$after" ]; then echo "NOOP     $name (mutation did not change the file)"; survivors=$((survivors + 1)); return; fi
  local out failed
  out="$(cd "$WORK/t" && TMPDIR="$WORK" timeout 300 node --test "$TEST" 2>&1)"
  failed="$(grep -E '^not ok' <<<"$out" | sed -E 's/^not ok [0-9]+ - //' | cut -c1-72 | paste -sd'|' -)"
  if grep -q '^# fail 0' <<<"$out"; then echo "SURVIVED $name"; survivors=$((survivors + 1)); else echo "caught   $name  <- $failed"; fi
}

# A fake token for one mutation, assembled here so that no token-looking literal sits in this file.
export FAKE_RUNNER_TOKEN="glr""t-""FAKEFAKEFAKEFAKEFAKE"

F=terraform/fleet.tf
A=terraform/fleet-ami.tf
S=host/fleet-manager-install.sh
C=host/fleet-image/component.yml
R=RUNBOOK-m2-fleet.md

# --- the group
run_mut "group minimum 1"                          $F 's/min_size(\s*)=\s*0\b/min_size$1= 1/'
run_mut "group starts with 3 machines"             $F 's/(resource "aws_autoscaling_group" "fleet".*?desired_capacity\s*=\s*)0/${1}3/s'
run_mut "group max hard-coded"                     $F 's/max_size(\s*)=\s*var\.fleet_max_instances/max_size$1= 24/'
run_mut "desired_capacity no longer ignored"       $F 's/ignore_changes = \[desired_capacity\]/ignore_changes = []/'
run_mut "scale-in protection off"                  $F 's/protect_from_scale_in(\s*)=\s*true/protect_from_scale_in$1= false/'
run_mut "AZRebalance not suspended"                $F 's/suspended_processes(\s*)=\s*\["AZRebalance"\]/suspended_processes$1= []/'
run_mut "capacity rebalance on"                    $F 's/capacity_rebalance(\s*)=\s*false/capacity_rebalance$1= true/'
run_mut "a scaling policy appears"                 $F 's/(# -+ manager|# -+ outputs)/resource "aws_autoscaling_policy" "x" {\n  name = "x"\n  autoscaling_group_name = aws_autoscaling_group.fleet.name\n  policy_type = "TargetTrackingScaling"\n}\n\n${1}/'
run_mut "instance type m5a replaced by m5.2xlarge" $F 's/"m5a\.xlarge"\]/"m5.2xlarge"]/'
run_mut "spot share ignores the variable"          $F 's/100 - var\.fleet_spot_percent/20/'
run_mut "group in a public subnet"                 $F 's/vpc_zone_identifier(\s*)=\s*aws_subnet\.private\[\*\]\.id/vpc_zone_identifier$1= aws_subnet.public[*].id/'
run_mut "group without the custom role"            $F 's/\n\s*service_linked_role_arn\s*=\s*aws_iam_service_linked_role\.fleet_autoscaling\.arn//'
run_mut "variable default changed"                 $F 's/(variable "fleet_max_instances" \{\s*type\s*=\s*number\s*default\s*=\s*)24/${1}12/'
run_mut "M1 variable declared again"               $F 's/(variable "fleet_idle_count")/variable "domain" {\n  type    = string\n  default = "x"\n}\n\n${1}/'
run_mut "a variable loses its default"             $F 's/(variable "fleet_spot_percent" \{\s*type\s*=\s*number\s*)default\s*=\s*80\n/${1}/'

# --- the launch template and the job machines
run_mut "job volume unencrypted"                   $F 's/(resource "aws_launch_template" "fleet".*?encrypted\s*=\s*)true/${1}false/s'
run_mut "job volume 50 GB"                         $F 's/volume_size(\s*)=\s*100\b/volume_size$1= 50/'
run_mut "job volume loses the M1 key"              $F 's/(resource "aws_launch_template" "fleet".*?)kms_key_id(\s*)=\s*aws_kms_key\.main\.arn\n/${1}/s'
run_mut "job machine gets a public IP"             $F 's/(network_interfaces \{\s*associate_public_ip_address\s*=\s*)false/${1}true/'
run_mut "job IMDSv2 optional"                      $F 's/(resource "aws_launch_template" "fleet".*?http_tokens\s*=\s*)"required"/${1}"optional"/s'
run_mut "job IMDS hop limit 2"                     $F 's/(resource "aws_launch_template" "fleet".*?http_put_response_hop_limit\s*=\s*)1/${1}2/s'
run_mut "job machine uses the manager group"       $F 's/(security_groups\s*=\s*\[)aws_security_group\.fleet_job\.id/${1}aws_security_group.fleet_manager.id/'
run_mut "a key pair on the job machines"           $F 's/(resource "aws_launch_template" "fleet" \{)/${1}\n  key_name = "ops"/'
run_mut "job role gets a policy"                   $F 's/(# -+ secrets)/resource "aws_iam_role_policy_attachment" "job_ssm" {\n  role = aws_iam_role.fleet_job.name\n  policy_arn = "arn:aws:iam::aws:policy\/AmazonSSMManagedInstanceCore"\n}\n\n${1}/'
run_mut "job role gets an inline policy"           $F 's/(# -+ secrets)/resource "aws_iam_role_policy" "job" {\n  role = aws_iam_role.fleet_job.id\n  policy = data.aws_iam_policy_document.fleet_manager.json\n}\n\n${1}/'
run_mut "job profile uses the manager role"        $F 's/(resource "aws_iam_instance_profile" "fleet_job" \{\s*name\s*=\s*"vitana-eng-fleet-job"\s*role\s*=\s*)aws_iam_role\.fleet_job\.name/${1}aws_iam_role.fleet_manager.name/'

# --- security groups
run_mut "job SSH open to the VPC"                  $F 's/(resource "aws_vpc_security_group_ingress_rule" "fleet_job_ssh_from_manager" \{\s*security_group_id\s*=\s*aws_security_group\.fleet_job\.id\n)\s*referenced_security_group_id\s*=\s*aws_security_group\.fleet_manager\.id/${1}  cidr_ipv4 = "10.20.0.0\/16"/'
run_mut "job SSH open to the world"                $F 's/(resource "aws_vpc_security_group_ingress_rule" "fleet_job_ssh_from_manager" \{\s*security_group_id\s*=\s*aws_security_group\.fleet_job\.id\n)\s*referenced_security_group_id\s*=\s*aws_security_group\.fleet_manager\.id/${1}  cidr_ipv4 = "0.0.0.0\/0"/'
run_mut "job SSH port 2222"                        $F 's/(resource "aws_vpc_security_group_ingress_rule" "fleet_job_ssh_from_manager".*?from_port\s*=\s*)22(\s*to_port\s*=\s*)22/${1}2222${2}2222/s'
run_mut "manager gets an inbound rule"             $F 's/(# -+ IAM)/resource "aws_vpc_security_group_ingress_rule" "mgr_in" {\n  security_group_id = aws_security_group.fleet_manager.id\n  referenced_security_group_id = aws_security_group.fleet_job.id\n  from_port = 22\n  to_port = 22\n  ip_protocol = "tcp"\n}\n\n${1}/'
run_mut "job egress opens all ports"               $F 's/(resource "aws_vpc_security_group_egress_rule" "fleet_job_http" \{\s*security_group_id\s*=\s*aws_security_group\.fleet_job\.id\s*cidr_ipv4\s*=\s*"0\.0\.0\.0\/0"\s*)from_port\s*=\s*80\s*to_port\s*=\s*80\s*ip_protocol\s*=\s*"tcp"/${1}ip_protocol = "-1"/'
run_mut "job egress adds SMTP"                     $F 's/(# -+ IAM)/resource "aws_vpc_security_group_egress_rule" "smtp" {\n  security_group_id = aws_security_group.fleet_job.id\n  cidr_ipv4 = "0.0.0.0\/0"\n  from_port = 25\n  to_port = 25\n  ip_protocol = "tcp"\n}\n\n${1}/'
run_mut "DNS egress to the world"                  $F 's/(resource "aws_vpc_security_group_egress_rule" "fleet_job_dns_udp" \{\s*security_group_id\s*=\s*aws_security_group\.fleet_job\.id\s*cidr_ipv4\s*=\s*)local\.vpc_cidr/${1}"0.0.0.0\/0"/'
run_mut "a third security group"                   $F 's/(# -+ IAM)/resource "aws_security_group" "extra" {\n  name = "x"\n  vpc_id = aws_vpc.main.id\n}\n\n${1}/'

# --- the manager and its role
run_mut "manager is a t3.large"                    $F 's/instance_type(\s*)=\s*"t3\.medium"/instance_type$1= "t3.large"/'
run_mut "manager gets a public IP"                 $F 's/(resource "aws_instance" "fleet_manager".*?associate_public_ip_address\s*=\s*)false/${1}true/s'
run_mut "manager IMDSv2 optional"                  $F 's/(resource "aws_instance" "fleet_manager".*?http_tokens\s*=\s*)"required"/${1}"optional"/s'
run_mut "manager root unencrypted"                 $F 's/(resource "aws_instance" "fleet_manager".*?encrypted\s*=\s*)true/${1}false/s'
run_mut "manager has a key pair"                   $F 's/(resource "aws_instance" "fleet_manager" \{)/${1}\n  key_name = "ops"/'
run_mut "manager starts before the group"          $F 's/(aws_secretsmanager_secret\.fleet_runner_token,\n\s*aws_s3_bucket_policy\.fleet_cache,\n)\s*aws_autoscaling_group\.fleet,\n/${1}/'
run_mut "group may start before the quota check"   $F 's/\n\s*terraform_data\.fleet_quota_check,//'
run_mut "role may also terminate everything"       $F 's/("autoscaling:TerminateInstanceInAutoScalingGroup")\]/${1}, "ec2:TerminateInstances"]/'
run_mut "role scales any group"                    $F 's/(sid\s*=\s*"ScaleThisGroup"\s*actions\s*=\s*\[[^\]]*\]\s*resources\s*=\s*)\[aws_autoscaling_group\.fleet\.arn\]/${1}["*"]/'
run_mut "role loses SetInstanceProtection"         $F 's/"autoscaling:SetInstanceProtection", //'
run_mut "role may send keys to any machine"        $F 's/\n    condition \{\n      test     = "StringEquals"\n      variable = "ec2:ResourceTag\/aws:autoscaling:groupName"\n      values   = \[local\.fleet_asg_name\]\n    \}//'
run_mut "role may read any secret"                 $F 's/(sid\s*=\s*"ReadRunnerToken"\s*actions\s*=\s*\["secretsmanager:GetSecretValue"\]\s*resources\s*=\s*)\[aws_secretsmanager_secret\.fleet_runner_token\.arn\]/${1}["*"]/'
run_mut "role reads the M1 runner token"           $F 's/(sid\s*=\s*"ReadRunnerToken"\s*actions\s*=\s*\["secretsmanager:GetSecretValue"\]\s*resources\s*=\s*)\[aws_secretsmanager_secret\.fleet_runner_token\.arn\]/${1}[aws_secretsmanager_secret.runner_token.arn]/'
run_mut "role may use every key"                   $F 's/(sid\s*=\s*"UseKey"\s*actions\s*=\s*\[[^\]]*\]\s*resources\s*=\s*)\[aws_kms_key\.main\.arn\]/${1}["*"]/'
run_mut "role may write every bucket"              $F 's/(sid\s*=\s*"CacheBucket"\s*actions\s*=\s*\[[^\]]*\]\s*resources\s*=\s*)\[aws_s3_bucket\.fleet_cache\.arn, "\$\{aws_s3_bucket\.fleet_cache\.arn\}\/\*"\]/${1}["arn:aws:s3:::*"]/'
run_mut "admin policy attached to the manager"     $F 's/arn:aws:iam::aws:policy\/AmazonSSMManagedInstanceCore/arn:aws:iam::aws:policy\/AdministratorAccess/'

# --- cache bucket and secret
run_mut "cache bucket not encrypted with the key"  $F 's/(resource "aws_s3_bucket_server_side_encryption_configuration" "fleet_cache".*?sse_algorithm\s*=\s*)"aws:kms"/${1}"AES256"/s'
run_mut "cache expiry 30 days"                     $F 's/(expiration \{\s*days\s*=\s*)7\b/${1}30/'
run_mut "cache bucket public ACLs allowed"         $F 's/(resource "aws_s3_bucket_public_access_block" "fleet_cache".*?block_public_acls\s*=\s*)true/${1}false/s'
run_mut "cache bucket gets versioning"             $F 's/(# -+ group|# -+ cache)/resource "aws_s3_bucket_versioning" "fleet_cache" {\n  bucket = aws_s3_bucket.fleet_cache.id\n  versioning_configuration {\n    status = "Enabled"\n  }\n}\n\n${1}/'
run_mut "TLS-only deny removed"                    $F 's/(variable\s*=\s*)"aws:SecureTransport"/${1}"aws:UserAgent"/'
run_mut "cache bucket name loses the account id"   $F 's/vitana-engineering-ci-cache-\$\{data\.aws_caller_identity\.me\.account_id\}/vitana-engineering-ci-cache/'
run_mut "token secret renamed"                     $F 's/vitana\/engineering\/gitlab\/fleet-runner-token/vitana\/engineering\/gitlab\/fleet-token/'
run_mut "token secret gets a value"                $F 's/(# -+ cache)/resource "aws_secretsmanager_secret_version" "t" {\n  secret_id = aws_secretsmanager_secret.fleet_runner_token.id\n  secret_string = "x"\n}\n\n${1}/'

# --- the quota check
run_mut "quota compares with 3 vCPUs per machine"  $F 's/var\.fleet_max_instances \* 4/var.fleet_max_instances * 3/'
run_mut "Spot quota not checked"                   $F 's/data\.aws_servicequotas_service_quota\.fleet_spot\.value >= local\.fleet_required_vcpus/true/'
run_mut "On-Demand quota not checked"              $F 's/data\.aws_servicequotas_service_quota\.fleet_ondemand\.value >= local\.fleet_required_vcpus/true/'
run_mut "quota code changed"                       $F 's/quota_code(\s*)=\s*"L-1216C47A"/quota_code$1= "L-0000000A"/'
run_mut "increase command loses the quota code"    $F 's/ --quota-code \$\{data\.aws_servicequotas_service_quota\.fleet_spot\.quota_code\}//'
run_mut "increase command is wrapped by Terraform" $F 's/\n          (aws service-quotas request-service-quota-increase --service-code ec2 --quota-code \$\{data\.aws_servicequotas_service_quota\.fleet_ondemand)/\n$1/'

# --- key access
run_mut "autoscaling grant loses CreateGrant"      $F 's/(resource "aws_kms_grant" "fleet_autoscaling".*?), "CreateGrant"\]/$1]/s'
run_mut "spot grant goes to another role"          $F 's/(resource "aws_kms_grant" "fleet_spot".*?grantee_principal\s*=\s*)local\.fleet_spot_role_arn/${1}aws_iam_service_linked_role.fleet_autoscaling.arn/s'
run_mut "spot role may not exist before the grant" $F 's/\n\s*depends_on\s*=\s*\[aws_iam_service_linked_role\.fleet_spot\]\n\}/\n}/'
run_mut "no custom suffix"                         $F 's/\n\s*custom_suffix\s*=\s*"vitana-eng-fleet"//'
run_mut "grant on another key"                     $F 's/(resource "aws_kms_grant" "fleet_spot" \{\s*name\s*=\s*"[^"]*"\s*key_id\s*=\s*)aws_kms_key\.main\.arn/${1}"alias\/aws\/ebs"/'

# --- the image
run_mut "image tests off"                          $A 's/image_tests_enabled(\s*)=\s*true/image_tests_enabled$1= false/'
run_mut "image build wait removed"                 $A 's/\n  timeouts \{\n    create = "90m"\n  \}\n//'
run_mut "failed build tolerated"                   $A 's/(resource "aws_imagebuilder_image" "fleet" \{)/${1}\n  lifecycle {\n    ignore_changes = all\n  }\n/'
run_mut "failed build machine left running"        $A 's/terminate_instance_on_failure(\s*)=\s*true/terminate_instance_on_failure$1= false/'
run_mut "build machine IMDSv2 optional"            $A 's/http_tokens(\s*)=\s*"required"/http_tokens$1= "optional"/'
run_mut "build machine in a public subnet"         $A 's/subnet_id(\s*)=\s*aws_subnet\.private\[0\]\.id/subnet_id$1= aws_subnet.public[0].id/'
run_mut "image volume unencrypted"                 $A 's/(block_device_mapping \{.*?encrypted\s*=\s*)true/${1}false/s'
run_mut "image role gets admin"                    $A 's/arn:aws:iam::aws:policy\/EC2InstanceProfileForImageBuilder/arn:aws:iam::aws:policy\/AdministratorAccess/'
run_mut "image role reuses the job role"           $A 's/(resource "aws_iam_instance_profile" "fleet_image" \{\s*name\s*=\s*"vitana-eng-fleet-image"\s*role\s*=\s*)aws_iam_role\.fleet_image\.name/${1}aws_iam_role.fleet_job.name/'
run_mut "new Canonical image rebuilds"             $A 's/\n    ignore_changes = \[parent_image\]//'
run_mut "helper image tag floats"                  $A 's/gitlab-runner-helper:x86_64-v\$\{local\.fleet_runner_semver\}/gitlab-runner-helper:latest/'
run_mut "job image tag floats"                     $A 's/node:20-bookworm"/node:latest"/'
run_mut "component ships the runner"               $C 's/(apt-get -o DPkg::Lock::Timeout=900 install -y docker\.io ec2-instance-connect ca-certificates curl)/$1 gitlab-runner/'
run_mut "component drops Docker"                   $C 's/docker\.io ec2-instance-connect/ec2-instance-connect/'
run_mut "component drops EC2 Instance Connect"     $C 's/ ec2-instance-connect ca-certificates/ ca-certificates/'
run_mut "ubuntu not in group docker"               $C 's/usermod -aG docker ubuntu/usermod -aG adm ubuntu/'
run_mut "helper image not pulled"                  $C 's/\n\s*- .docker pull "\{\{ RunnerHelperImage \}\}".//'
run_mut "test phase removed"                       $C 's/  - name: test\n.*\z//s'
run_mut "a key baked into the image"               $C 's/(    steps:\n      - name: InstallPackages)/    steps:\n      - name: Key\n        action: ExecuteBash\n        inputs:\n          commands:\n            - echo ssh-ed25519 AAAA > \/home\/ubuntu\/.ssh\/authorized_keys\n      - name: InstallPackages/'

# --- the installer
run_mut "max_use_count 2"                          $S 's/max_use_count = 1/max_use_count = 2/'
run_mut "capacity_per_instance 2"                  $S 's/capacity_per_instance = 1/capacity_per_instance = 2/'
run_mut "privileged jobs"                          $S 's/privileged = false/privileged = true/'
run_mut "Docker socket mounted"                    $S 's/volumes = \["\/cache"\]/volumes = ["\/var\/run\/docker.sock:\/var\/run\/docker.sock"]/'
run_mut "pull always"                              $S 's/pull_policy = \["if-not-present"\]/pull_policy = ["always"]/'
run_mut "wrong executor"                           $S 's/executor = "docker-autoscaler"/executor = "docker+machine"/'
run_mut "plugin pinned to a made-up name"          $S 's/plugin = "aws"/plugin = "fleeting-plugin-aws"/'
run_mut "external addresses used"                  $S 's/use_external_addr = false/use_external_addr = true/'
run_mut "connector user ec2-user"                  $S 's/username = "ubuntu"/username = "ec2-user"/'
run_mut "idle time 20 minutes"                     $S 's/idle_time = "10m0s"/idle_time = "20m0s"/'
run_mut "idle_count fixed at 5"                    $S 's/idle_count = \$FLEET_IDLE_COUNT/idle_count = 5/'
run_mut "concurrent fixed at 10"                   $S 's/concurrent = \$FLEET_MAX_INSTANCES/concurrent = 10/'
run_mut "max_instances fixed at 10"                $S 's/max_instances = \$FLEET_MAX_INSTANCES/max_instances = 10/'
run_mut "cache without encryption"                 $S 's/      ServerSideEncryption = "KMS"\n//'
run_mut "cache uses stored keys"                   $S 's/AuthenticationType = "iam"/AuthenticationType = "access-key"/'
run_mut "cache over plain HTTP"                    $S 's/(ServerAddress = "s3\.\$REGION\.amazonaws\.com"\n)/${1}      Insecure = true\n/'
run_mut "cache bucket location fixed"              $S 's/BucketLocation = "\$REGION"/BucketLocation = "eu-central-1"/'
run_mut "runner version unpinned"                  $S 's/"gitlab-runner=\$RUNNER_VERSION"/gitlab-runner/'
run_mut "runner not held back"                     $S 's/apt-mark hold gitlab-runner/apt-mark showhold/'
run_mut "Docker installed on the manager"          $S 's/apt install -y curl ca-certificates unzip \|\| exit 1/apt install -y curl ca-certificates unzip docker.io \|\| exit 1/'
run_mut "plugin install dropped"                   $S 's/CONFIG_FILE=\/etc\/gitlab-runner\/config\.toml gitlab-runner fleeting install/true/'
run_mut "plugin folder differs from the service"   $S 's/Environment=FLEETING_PLUGIN_PATH=\$PLUGIN_DIR/Environment=FLEETING_PLUGIN_PATH=\/tmp\/other/'
run_mut "config.toml world readable"               $S 's/install -m 0600 -o root -g root/install -m 0644 -o root -g root/'
run_mut "config.toml copy not private"             $S 's/TMPCONF="\$\(umask 077; mktemp/TMPCONF="$(mktemp/'
run_mut "global umask before the package repo"     $S 's/(\[ "\$\(id -u\)" = 0 \] \|\| \{ echo "run as root"; exit 1; \}\n)/${1}umask 077\n/'
run_mut "docker not started before the image test" $C 's/\n            - systemctl start docker\n            - docker --version/\n            - docker --version/'
run_mut "wait is 2 hours"                          $S 's/seq 1 2880/seq 1 240/'
run_mut "any secret value ends the wait"           $S 's/case "\$T" in glrt-\*\)/case "$T" in *)/'
run_mut "token echoed"                             $S 's/(\[ -n "\$TOKEN" \] \|\| \{ echo "no runner token after 24 hours"; exit 1; \})/echo "token is $TOKEN"; $1/'
run_mut "xtrace on"                                $S 's/^set -u$/set -ux/m'
run_mut "verify output not scrubbed"               $S 's/ \| sed -E .s\/runner=\[\^ \]\+\/runner=\*\*\*\/.//'
run_mut "token checked loosely"                    $S "s/want FLEET_RUNNER_TOKEN '\\^glrt-\\[A-Za-z0-9_.-\\]\\+\\\$'/want FLEET_RUNNER_TOKEN '.*'/"
run_mut "size check removed"                       $S "s/want FLEET_MAX_INSTANCES '\\^\\[1-9\\]\\[0-9\\]\\{0,2\\}\\\$'/want FLEET_MAX_INSTANCES '.*'/"
run_mut "idle larger than max accepted"            $S 's/-gt "\$FLEET_MAX_INSTANCES"/-gt 99999/'
run_mut "script with a syntax error"               $S 's/\z/\nif then fi\n/'
run_mut "start line removed"                       $S 's/echo "== fleet manager install start/echo "== start/'

# --- the user data and the document
run_mut "user data writes no log"                  $F 's/ >> \/var\/log\/vitana-bootstrap\.log 2>&1//'
run_mut "env file loses the idle count"            $F 's/\n\s*"FLEET_IDLE_COUNT=\$\{var\.fleet_idle_count\}",//'
run_mut "env file gets a secret"                   $F 's/("FLEET_ASG_NAME=\$\{local\.fleet_asg_name\}",)/$1\n    "FLEET_RUNNER_TOKEN=$ENV{FAKE_RUNNER_TOKEN}",/'
run_mut "an output leaks a secret value"           $F 's/(output "fleet_asg_name" \{)/output "fleet_x" {\n  value = aws_secretsmanager_secret_version.t.secret_string\n}\n\n$1/'
run_mut "an output name collides with M1"          $F 's/output "fleet_manager_instance_id"/output "alb_dns"/'
run_mut "RUNBOOK quota command changed"            $R 's/--desired-value 96 --region eu-central-1/--desired-value 32 --region eu-central-1/'
run_mut "RUNBOOK drain forgets the decrement"      $R 's/ --should-decrement-desired-capacity//'
run_mut "RUNBOOK no cost section"                  $R 's/## 7\. Monthly cost estimate/## 7. Prices/'
run_mut "RUNBOOK names no KMS symptom"             $R 's/`Client\.InternalError: Client error on launch` or `Client\.InvalidKMSKey\.InvalidState`/a launch error/'

echo; echo "mutations: $total   not caught: $survivors"
[ "$survivors" -eq 0 ]
