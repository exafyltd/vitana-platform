#!/bin/bash
# Installs GitLab EE (pinned version, runs as the Free tier without a licence) behind the load balancer.
# Safe to re-run: it does nothing once GitLab is installed. Log: /var/log/vitana-bootstrap.log
set -euo pipefail   # no -x: xtrace would write the root password into the log
. /etc/vitana/env
export DEBIAN_FRONTEND=noninteractive AWS_DEFAULT_REGION="$REGION" HOME=/root
echo "== install start $(date -u +%FT%TZ)"

apt() { apt-get -o DPkg::Lock::Timeout=900 "$@"; }
apt update -y
apt install -y curl ca-certificates unzip jq git openssh-server perl tzdata gnupg

if ! command -v aws >/dev/null 2>&1; then
  curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscliv2.zip
  unzip -q -o /tmp/awscliv2.zip -d /tmp
  /tmp/aws/install
fi

if [ -d /opt/gitlab/embedded ]; then
  echo "GitLab is already installed"
  exit 0
fi

# 0. Swap as a cushion while GitLab installs and migrates its database (needs memory), and a lighter GitLab on a small machine.
if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
MEM_GB="$(awk '/MemTotal/ {print int($2 / 1048576)}' /proc/meminfo)"
SMALL=""; [ "${MEM_GB:-0}" -ge 12 ] || SMALL="prometheus_monitoring['enable'] = false"

# 1. Initial root password: generate it and store it in Secrets Manager BEFORE installing,
#    so it is never lost and never appears in Git or in Terraform state.
PW="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-30)"
stored=0
for i in $(seq 1 20); do
  if aws secretsmanager put-secret-value --secret-id vitana/engineering/gitlab/root-password --secret-string "$PW" >/dev/null; then stored=1; break; fi
  echo "waiting for the instance role to become usable ($i)"
  sleep 15
done
[ "$stored" = 1 ] || { echo "could not store the root password in Secrets Manager"; exit 1; }
echo "root password stored in Secrets Manager"

# 2. Configuration first. TLS ends at the load balancer, so GitLab's nginx listens on plain HTTP.
mkdir -p /etc/gitlab
cat > /etc/gitlab/gitlab.rb <<EOF
external_url 'https://$DOMAIN'
letsencrypt['enable'] = false
gitlab_rails['nginx']['listen_port'] = 80
gitlab_rails['nginx']['listen_https'] = false
gitlab_rails['nginx']['real_ip_trusted_addresses'] = ['10.20.0.0/16']
gitlab_rails['nginx']['real_ip_header'] = 'X-Forwarded-For'
gitlab_rails['nginx']['real_ip_recursive'] = 'on'
gitlab_rails['backup_keep_time'] = 86400
$SMALL
EOF

# 3. Install the pinned version and hold it.
curl -fsSL https://packages.gitlab.com/install/repositories/gitlab/gitlab-ee/script.deb.sh | bash
env GITLAB_ROOT_PASSWORD="$PW" GITLAB_ROOT_EMAIL="$ADMIN_EMAIL" apt-get -o DPkg::Lock::Timeout=900 install -y "gitlab-ee=$GITLAB_VERSION"
apt-mark hold gitlab-ee
echo "GitLab package installed, reconfiguring"
env GITLAB_ROOT_PASSWORD="$PW" GITLAB_ROOT_EMAIL="$ADMIN_EMAIL" gitlab-ctl reconfigure

# If GitLab generated its own initial password instead, keep Secrets Manager correct.
if [ -f /etc/gitlab/initial_root_password ]; then
  PW2="$(grep '^Password:' /etc/gitlab/initial_root_password | awk '{print $2}')"
  [ -z "$PW2" ] || aws secretsmanager put-secret-value --secret-id vitana/engineering/gitlab/root-password --secret-string "$PW2" >/dev/null
fi
echo "== install done $(date -u +%FT%TZ)"
