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
#   fleet-manager-install.sh --render-config   print config.toml on stdout from the environment (FLEET_RUNNER_TOKEN, FLEET_MAX_INSTANCES,
#                                              FLEET_IDLE_COUNT, FLEET_ASG_NAME, FLEET_CACHE_BUCKET, FLEET_CACHE_KMS_KEY_ARN, DOMAIN, REGION).
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

# config.toml of the fleet runner. concurrent = max_instances = fleet_max_instances; one job per machine (capacity_per_instance 1,
# max_use_count 1: a machine is deleted after its job); machines idle for 10 minutes are removed; job containers are not privileged and
# get no Docker socket; images are pulled only when missing (the machine image carries the Node 20 and helper images); the S3 cache URLs
# are signed here with this machine's instance profile, so the job machines need no AWS permission.
render_config() {
  check_inputs || return 2
  cat <<EOF
concurrent = $FLEET_MAX_INSTANCES

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

# Only the copy of config.toml is created private (mode 0600). A global umask would also make the package repository's key file unreadable
# for apt, which verifies packages as an unprivileged user.
TMPCONF="$(umask 077; mktemp /root/config.toml.XXXXXX)"
FLEET_RUNNER_TOKEN="$TOKEN" render_config > "$TMPCONF" || { echo "config.toml could not be rendered"; exit 1; }
install -m 0600 -o root -g root "$TMPCONF" /etc/gitlab-runner/config.toml
rm -f "$TMPCONF"

export FLEETING_PLUGIN_PATH="$PLUGIN_DIR"
CONFIG_FILE=/etc/gitlab-runner/config.toml gitlab-runner fleeting install || { echo "gitlab-runner fleeting install failed"; exit 1; }
gitlab-runner fleeting list || true   # the plugin version that was installed
systemctl enable gitlab-runner
systemctl restart gitlab-runner
sleep 5
gitlab-runner verify 2>&1 | sed -E 's/runner=[^ ]+/runner=***/' || true
echo "== fleet manager install done $(date -u +%FT%TZ)"
