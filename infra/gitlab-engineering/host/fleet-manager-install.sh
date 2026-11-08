#!/bin/bash
# Installs the GitLab Runner (pinned) on the CI fleet manager machine, waits for the runner's authentication token in Secrets Manager,
# writes config.toml for the docker-autoscaler executor with the aws fleeting plugin (plan eng-gitlab-m2, section 3.2), and starts it.
# Runs once from the machine's user data. Safe to run again (for example after the settings sync wrote a new token):
#   bash /opt/vitana/fleet-manager-install.sh
# Log: /var/log/vitana-bootstrap.log
#
# No Docker runs on this machine: the job machines have it, and the runner reaches it through an SSH tunnel that the fleeting plugin
# opens with a one-time key sent through EC2 Instance Connect. No key is stored. The token is never printed.
#
# Runner classes main and deploy (plan agentic-delivery section 3.2, VTID-05546; groups in terraform/fleet-classes.tf). When
# /etc/vitana/env.classes exists (written by the owner's step A2, RUNBOOK-delivery-aws.md), each class whose runner token is in its
# secret gets one more runner block on its own group, after the untrusted one. A class without a token stays off: its jobs wait.
#
#   fleet-manager-install.sh --render-config   print config.toml on stdout from the environment (FLEET_RUNNER_TOKEN, FLEET_MAX_INSTANCES,
#                                              FLEET_IDLE_COUNT, FLEET_ASG_NAME, FLEET_CACHE_BUCKET, FLEET_CACHE_KMS_KEY_ARN, DOMAIN, REGION;
#                                              per class to render: CLASS_<MAIN|DEPLOY|BUILD>_RUNNER_TOKEN, _ASG_NAME, _MAX_INSTANCES).
#                                              Needs no root, no network and no file. A bad value prints nothing and exits 2.
set -u

# Every value that ends up inside config.toml is checked first. A refusal names the input and never shows its value.
check_inputs() {
  local bad=0
  want() {   # input name, pattern
    local v="${!1:-}"
    if ! [[ "$v" =~ $2 ]]; then echo "$1 is missing or has an unexpected form" >&2; bad=1; fi
  }
  want DOMAIN '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$'
  want REGION '^[a-z]{2}(-[a-z]+)+-[0-9]$'
  want FLEET_ASG_NAME '^[A-Za-z0-9_-]+$'
  want FLEET_MAX_INSTANCES '^[1-9][0-9]{0,2}$'
  want FLEET_IDLE_COUNT '^(0|[1-9][0-9]{0,2})$'
  want FLEET_CACHE_BUCKET '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'
  want FLEET_CACHE_KMS_KEY_ARN '^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[0-9a-f-]{36}$'
  want FLEET_RUNNER_TOKEN '^glrt-[A-Za-z0-9_.-]+$'
  if [[ "${FLEET_MAX_INSTANCES:-}" =~ ^[0-9]+$ && "${FLEET_IDLE_COUNT:-}" =~ ^[0-9]+$ ]] && [ "$FLEET_IDLE_COUNT" -gt "$FLEET_MAX_INSTANCES" ]; then
    echo "FLEET_IDLE_COUNT must not be larger than FLEET_MAX_INSTANCES" >&2
    bad=1
  fi
  return "$bad"
}

# The runner classes. A class is rendered only when its runner token is set; its other inputs are then checked like the untrusted ones,
# and its group must be its own (two runner blocks on one group would fight over its size).
CLASSES="MAIN DEPLOY BUILD"
class_on() { local v="CLASS_${1}_RUNNER_TOKEN"; [ -n "${!v:-}" ]; }
check_class_inputs() {
  local bad=0 c g seen=" ${FLEET_ASG_NAME:-} "
  wantc() {   # input name, pattern
    local v="${!1:-}"
    if ! [[ "$v" =~ $2 ]]; then echo "$1 is missing or has an unexpected form" >&2; bad=1; fi
  }
  for c in $CLASSES; do
    class_on "$c" || continue
    wantc "CLASS_${c}_RUNNER_TOKEN" '^glrt-[A-Za-z0-9_.-]+$'
    wantc "CLASS_${c}_ASG_NAME" '^[A-Za-z0-9_-]+$'
    wantc "CLASS_${c}_MAX_INSTANCES" '^[1-9][0-9]{0,2}$'
    g="CLASS_${c}_ASG_NAME"
    g="${!g:-}"
    if [ -n "$g" ] && [[ "$seen" == *" $g "* ]]; then echo "CLASS_${c}_ASG_NAME names a group that another runner block already scales" >&2; bad=1; fi
    seen="$seen$g "
  done
  return "$bad"
}

# One more runner block per class: the machine rules of the untrusted block (one job per machine, deleted after it, not privileged, no
# Docker socket), the class's own token, group and size, a job limit of that size, and its own cache path, so no class reads another
# class's cache. Only the build class's service containers run without the seccomp and AppArmor profiles: there .build-image starts its
# rootless BuildKit daemon (plan agentic-delivery R5). Job containers keep both profiles in every class.
render_class() {   # MAIN, DEPLOY or BUILD
  local c="$1" lc tag note v gv mv
  lc="${c,,}"
  case "$c" in
    MAIN) tag="vitana-eng-main"; note=", a protected runner (refs main and assist/*)" ;;
    BUILD) tag="vitana-eng-build"; note=", a protected runner (refs main and assist/*), image builds only" ;;
    *) tag="vitana-eng-deploy"; note="" ;;
  esac
  v="CLASS_${c}_RUNNER_TOKEN"
  gv="CLASS_${c}_ASG_NAME"
  mv="CLASS_${c}_MAX_INSTANCES"
  cat <<EOF

# vitana-eng-fleet-$lc: runner tag $tag$note
[[runners]]
  name = "vitana-eng-fleet-$lc"
  url = "https://$DOMAIN"
  token = "${!v}"
  executor = "docker-autoscaler"
  limit = ${!mv}

  [runners.cache]
    Type = "s3"
    Path = "$tag"

    [runners.cache.s3]
      ServerAddress = "s3.$REGION.amazonaws.com"
      BucketName = "$FLEET_CACHE_BUCKET"
      BucketLocation = "$REGION"
      AuthenticationType = "iam"
      ServerSideEncryption = "KMS"
      ServerSideEncryptionKeyID = "$FLEET_CACHE_KMS_KEY_ARN"

  [runners.docker]
    image = "public.ecr.aws/docker/library/node:20-bookworm"
    privileged = false
    pull_policy = ["if-not-present"]
    volumes = ["/cache"]
EOF
  if [ "$c" = BUILD ]; then echo '    services_security_opt = ["seccomp=unconfined", "apparmor=unconfined"]'; fi
  cat <<EOF

  [runners.autoscaler]
    plugin = "aws"
    capacity_per_instance = 1
    max_use_count = 1
    max_instances = ${!mv}

    [runners.autoscaler.plugin_config]
      name = "${!gv}"
      region = "$REGION"

    [runners.autoscaler.connector_config]
      username = "ubuntu"
      use_external_addr = false

    [[runners.autoscaler.policy]]
      idle_count = 0
      idle_time = "10m0s"
EOF
}

# config.toml of the fleet runner. concurrent = max_instances = fleet_max_instances (plus the maximum of each class block rendered after
# it); one job per machine (capacity_per_instance 1,
# max_use_count 1: a machine is deleted after its job); machines idle for 10 minutes are removed; job containers are not privileged and
# get no Docker socket; images are pulled only when missing (the machine image carries the Node 20 and helper images); the S3 cache URLs
# are signed here with this machine's instance profile, so the job machines need no AWS permission.
render_config() {
  check_inputs || return 2
  check_class_inputs || return 2
  local total="$FLEET_MAX_INSTANCES" c mv
  for c in $CLASSES; do
    if class_on "$c"; then mv="CLASS_${c}_MAX_INSTANCES"; total=$((total + ${!mv})); fi
  done
  cat <<EOF
concurrent = $total

[[runners]]
  name = "vitana-eng-fleet"
  url = "https://$DOMAIN"
  token = "$FLEET_RUNNER_TOKEN"
  executor = "docker-autoscaler"

  [runners.cache]
    Type = "s3"

    [runners.cache.s3]
      ServerAddress = "s3.$REGION.amazonaws.com"
      BucketName = "$FLEET_CACHE_BUCKET"
      BucketLocation = "$REGION"
      AuthenticationType = "iam"
      ServerSideEncryption = "KMS"
      ServerSideEncryptionKeyID = "$FLEET_CACHE_KMS_KEY_ARN"

  [runners.docker]
    image = "public.ecr.aws/docker/library/node:20-bookworm"
    privileged = false
    pull_policy = ["if-not-present"]
    volumes = ["/cache"]

  [runners.autoscaler]
    plugin = "aws"
    capacity_per_instance = 1
    max_use_count = 1
    max_instances = $FLEET_MAX_INSTANCES

    [runners.autoscaler.plugin_config]
      name = "$FLEET_ASG_NAME"
      region = "$REGION"

    [runners.autoscaler.connector_config]
      username = "ubuntu"
      use_external_addr = false

    [[runners.autoscaler.policy]]
      idle_count = $FLEET_IDLE_COUNT
      idle_time = "10m0s"
EOF
  for c in $CLASSES; do
    if class_on "$c"; then render_class "$c"; fi
  done
  return 0
}

if [ "${1:-}" = "--render-config" ]; then
  render_config || exit 2
  exit 0
fi

# ------------------------------------------------------------------ install
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
. /etc/vitana/env
export DEBIAN_FRONTEND=noninteractive AWS_DEFAULT_REGION="$REGION" HOME=/root
echo "== fleet manager install start $(date -u +%FT%TZ)"

apt() { apt-get -o DPkg::Lock::Timeout=900 "$@"; }
apt update -y
apt install -y curl ca-certificates unzip || exit 1

if ! command -v aws >/dev/null 2>&1; then
  curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscliv2.zip
  unzip -q -o /tmp/awscliv2.zip -d /tmp
  /tmp/aws/install
fi

curl -fsSL https://packages.gitlab.com/install/repositories/runner/gitlab-runner/script.deb.sh | bash
# The helper images package is pinned with the runner: unpinned, apt takes the newest helper and refuses the pinned runner
# ("held broken packages"; the fleet manager never installed the runner, 2026-11-06).
apt install -y "gitlab-runner-helper-images=$RUNNER_VERSION" "gitlab-runner=$RUNNER_VERSION" || exit 1
apt-mark hold gitlab-runner gitlab-runner-helper-images

# The service and this script use one plugin folder, set explicitly: a system service has no home directory to default to.
PLUGIN_DIR=/opt/vitana/fleeting-plugins
mkdir -p "$PLUGIN_DIR" /etc/systemd/system/gitlab-runner.service.d
cat > /etc/systemd/system/gitlab-runner.service.d/fleeting.conf <<EOF
[Service]
Environment=HOME=/root
Environment=FLEETING_PLUGIN_PATH=$PLUGIN_DIR
EOF
systemctl daemon-reload

# Wait for the token that the settings sync stores after it created the runner in GitLab (up to 24 hours).
TOKEN=""
for i in $(seq 1 2880); do
  T="$(aws secretsmanager get-secret-value --secret-id "$FLEET_TOKEN_SECRET" --query SecretString --output text 2>/dev/null || true)"
  case "$T" in glrt-*) TOKEN="$T"; break ;; esac
  [ $((i % 20)) = 1 ] && echo "waiting for the runner token in $FLEET_TOKEN_SECRET ($i/2880)"
  sleep 30
done
[ -n "$TOKEN" ] || { echo "no runner token after 24 hours"; exit 1; }

# Runner classes (plan agentic-delivery section 3.2): /etc/vitana/env.classes names each class's group, size and token secret. Each class
# token is read once, from Secrets Manager only (a token written into the env file is ignored); a class without one stays off, and the
# untrusted runner starts anyway. Run the installer again once a class token exists.
if [ -f /etc/vitana/env.classes ]; then
  . /etc/vitana/env.classes
  unset CLASS_MAIN_RUNNER_TOKEN CLASS_DEPLOY_RUNNER_TOKEN CLASS_BUILD_RUNNER_TOKEN
  for c in $CLASSES; do
    sv="CLASS_${c}_TOKEN_SECRET"
    sid="${!sv:-}"
    if ! [[ "$sid" =~ ^vitana/engineering/gitlab/[A-Za-z0-9/_-]+$ ]]; then echo "$sv has an unexpected form; class ${c,,} stays off"; continue; fi
    CV="$(aws secretsmanager get-secret-value --secret-id "$sid" --query SecretString --output text 2>/dev/null || true)"
    case "$CV" in
      glrt-*) printf -v "CLASS_${c}_RUNNER_TOKEN" '%s' "$CV"; echo "class ${c,,}: runner token found in $sid" ;;
      *) echo "class ${c,,}: no runner token in $sid yet; the class stays off (its jobs wait)" ;;
    esac
  done
  CV=""
fi

# Only the copy of config.toml is created private (mode 0600). A global umask would also make the package repository's key file unreadable
# for apt, which verifies packages as an unprivileged user.
TMPCONF="$(umask 077; mktemp /root/config.toml.XXXXXX)"
FLEET_RUNNER_TOKEN="$TOKEN" render_config > "$TMPCONF" || { echo "config.toml could not be rendered"; exit 1; }
install -m 0600 -o root -g root "$TMPCONF" /etc/gitlab-runner/config.toml
rm -f "$TMPCONF"
unset CLASS_MAIN_RUNNER_TOKEN CLASS_DEPLOY_RUNNER_TOKEN CLASS_BUILD_RUNNER_TOKEN

export FLEETING_PLUGIN_PATH="$PLUGIN_DIR"
CONFIG_FILE=/etc/gitlab-runner/config.toml gitlab-runner fleeting install || { echo "gitlab-runner fleeting install failed"; exit 1; }
gitlab-runner fleeting list || true   # the plugin version that was installed
systemctl enable gitlab-runner
systemctl restart gitlab-runner
sleep 5
gitlab-runner verify 2>&1 | sed -E 's/runner=[^ ]+/runner=***/' || true
echo "== fleet manager install done $(date -u +%FT%TZ)"
