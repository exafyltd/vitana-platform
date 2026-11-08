#!/bin/bash
# Installs Docker and GitLab Runner (pinned), waits for the registration token that the GitLab host stores in
# Secrets Manager, registers the runner (tag vitana-eng) and starts it. Log: /var/log/vitana-bootstrap.log
set -u
. /etc/vitana/env
export DEBIAN_FRONTEND=noninteractive AWS_DEFAULT_REGION="$REGION" HOME=/root
echo "== runner install start $(date -u +%FT%TZ)"

apt() { apt-get -o DPkg::Lock::Timeout=900 "$@"; }
apt update -y
apt install -y curl ca-certificates unzip jq docker.io || exit 1

if ! command -v aws >/dev/null 2>&1; then
  curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscliv2.zip
  unzip -q -o /tmp/awscliv2.zip -d /tmp
  /tmp/aws/install
fi

# 4 GB of swap as a cushion for memory-heavy test jobs.
if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

curl -fsSL https://packages.gitlab.com/install/repositories/runner/gitlab-runner/script.deb.sh | bash
# The helper images package is pinned with the runner: unpinned, apt takes the newest helper and refuses the pinned runner
# ("held broken packages"; the fleet manager never installed the runner, 2026-11-06).
apt install -y "gitlab-runner-helper-images=$RUNNER_VERSION" "gitlab-runner=$RUNNER_VERSION" || exit 1
apt-mark hold gitlab-runner gitlab-runner-helper-images
systemctl enable --now docker
usermod -aG docker gitlab-runner

# Wait for the token created by the GitLab host (up to 2 hours).
TOKEN=""
for i in $(seq 1 240); do
  T="$(aws secretsmanager get-secret-value --secret-id vitana/engineering/gitlab/runner-token --query SecretString --output text 2>/dev/null || true)"
  case "$T" in glrt-*) TOKEN="$T"; break ;; esac
  sleep 30
done
[ -n "$TOKEN" ] || { echo "no runner token after 2 hours"; exit 1; }

# Register. It needs the public DNS name of GitLab to resolve and its certificate to be valid, so retry
# until the DNS record exists (up to 1 hour).
for i in $(seq 1 120); do
  if gitlab-runner register --non-interactive --url "https://$DOMAIN" --token "$TOKEN" --executor docker \
       --docker-image public.ecr.aws/docker/library/node:20-bookworm --description vitana-eng-1 --docker-pull-policy if-not-present; then
    break
  fi
  echo "register attempt $i failed, retrying in 30 s"
  sleep 30
done
# 3 jobs at once on a 16 GB machine, 1 on a smaller one (the Jest and typecheck jobs need several GB each).
MEM_GB="$(awk '/MemTotal/ {print int($2 / 1048576)}' /proc/meminfo)"
CONC=3; [ "${MEM_GB:-0}" -ge 12 ] || CONC=1
sed -i "s/^concurrent = .*/concurrent = $CONC/" /etc/gitlab-runner/config.toml
systemctl restart gitlab-runner
gitlab-runner verify || true
echo "== runner install done $(date -u +%FT%TZ)"
