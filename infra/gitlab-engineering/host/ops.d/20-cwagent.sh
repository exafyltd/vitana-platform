#!/bin/bash
# Installs the Amazon CloudWatch agent on the GitLab machine and sets it to publish one metric, disk_used_percent of the root volume,
# to the namespace Vitana/Engineering (plan eng-gitlab-m2 section 3.6: the alarm "disk over 80 percent", terraform/monitoring.tf).
# Run as root by ops-install.sh (lane settings), which picks every script in host/ops.d/ by glob. Safe to repeat: the package is installed
# once, the configuration is rewritten only when it changed, and the agent is started only when it is not running or the configuration changed.
# The agent needs no credential of its own: it uses the role of this machine, whose policy "monitoring" allows PutMetricData for
# this one namespace. The package is taken from AWS over https and installed only when its signature verifies against the key whose
# fingerprint AWS publishes (verify-CloudWatch-Agent-Package-Signature in the CloudWatch user guide) and is written below.
# VITANA_ENV, CWAGENT_CTL, CWAGENT_CONFIG, CWAGENT_START_TRIES and CWAGENT_START_SLEEP exist so that scripts/eng/monitoring-structure.test.mjs
# can run this file against stand-ins; ops-install.sh sets none of them.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive HOME=/root

ENV_FILE="${VITANA_ENV:-/etc/vitana/env}"
CTL="${CWAGENT_CTL:-/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl}"
CONFIG="${CWAGENT_CONFIG:-/etc/vitana/cwagent.json}"
KEY_FPR="937616F3450B7D806CBD9725D58167303B789C72"

. "$ENV_FILE"
: "${REGION:?REGION is not set in $ENV_FILE}"
log() { echo "$(date -u +%FT%TZ) cwagent: $*"; }

# ---- 1. the package
if dpkg -s amazon-cloudwatch-agent >/dev/null 2>&1; then
  log "the CloudWatch agent package is already installed"
else
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/cwagent-dl.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  PKG_URL="https://amazoncloudwatch-agent-${REGION}.s3.${REGION}.amazonaws.com/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb"
  KEY_URL="https://amazoncloudwatch-agent.s3.amazonaws.com/assets/amazon-cloudwatch-agent.gpg"
  curl -fsSL --retry 3 -o "$tmp/agent.deb" "$PKG_URL"
  curl -fsSL --retry 3 -o "$tmp/agent.deb.sig" "$PKG_URL.sig"
  curl -fsSL --retry 3 -o "$tmp/agent.gpg" "$KEY_URL"
  export GNUPGHOME="$tmp/gnupg"
  mkdir -m 700 "$GNUPGHOME"
  gpg --batch --quiet --import "$tmp/agent.gpg"
  got="$(gpg --batch --with-colons --fingerprint | awk -F: '$1 == "fpr" { print $10; exit }')"
  if [ "$got" != "$KEY_FPR" ]; then
    echo "cwagent: the key downloaded for the CloudWatch agent has the fingerprint '$got', not the one AWS publishes: not installing" >&2
    exit 1
  fi
  gpg --batch --verify "$tmp/agent.deb.sig" "$tmp/agent.deb"
  dpkg -i "$tmp/agent.deb"
  log "installed the CloudWatch agent package"
fi

# ---- 2. the configuration: one disk metric, rolled up to the InstanceId dimension the alarm reads
mkdir -p "$(dirname "$CONFIG")"
cat > "$CONFIG.new" <<'CWAGENT_JSON'
{
  "agent": {
    "metrics_collection_interval": 60
  },
  "metrics": {
    "namespace": "Vitana/Engineering",
    "append_dimensions": {
      "InstanceId": "${aws:InstanceId}"
    },
    "aggregation_dimensions": [["InstanceId"]],
    "metrics_collected": {
      "disk": {
        "measurement": ["used_percent"],
        "resources": ["/"],
        "drop_device": true,
        "metrics_collection_interval": 60
      }
    }
  }
}
CWAGENT_JSON
changed=0
if [ -f "$CONFIG" ] && cmp -s "$CONFIG.new" "$CONFIG"; then
  rm -f "$CONFIG.new"
else
  mv "$CONFIG.new" "$CONFIG"
  chmod 0644 "$CONFIG"
  changed=1
fi

# ---- 3. the agent
if [ "$changed" = 1 ] || ! systemctl is-active --quiet amazon-cloudwatch-agent; then
  "$CTL" -a fetch-config -m ec2 -c file:"$CONFIG" -s
  systemctl enable amazon-cloudwatch-agent
  running=0
  for _ in $(seq 1 "${CWAGENT_START_TRIES:-10}"); do
    if systemctl is-active --quiet amazon-cloudwatch-agent; then running=1; break; fi
    sleep "${CWAGENT_START_SLEEP:-2}"
  done
  if [ "$running" != 1 ]; then
    echo "cwagent: the CloudWatch agent is not running after it was started; see /opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log" >&2
    exit 1
  fi
  log "the CloudWatch agent is configured and running"
else
  log "the CloudWatch agent is installed, configured and running: nothing to do"
fi
