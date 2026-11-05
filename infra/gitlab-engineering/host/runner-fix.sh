#!/bin/bash
# Registers the CI runner when its first registration did not happen (for example GitLab's DNS record was not there
# yet, and a "no such host" answer stays cached for up to 30 minutes). Waits until GitLab is reachable from this
# machine, then registers. Safe to repeat. Run through:  bash setup.sh runner
. /etc/vitana/env
export AWS_DEFAULT_REGION="$REGION" HOME=/root
CONF=/etc/gitlab-runner/config.toml
if grep -qE '^[[:space:]]*token = "glrt-' "$CONF" 2>/dev/null; then
  echo "runner already registered"
else
  for i in $(seq 1 60); do
    resolvectl flush-caches >/dev/null 2>&1 || true
    if curl -fsS -m 10 -o /dev/null "https://$DOMAIN/users/sign_in" 2>/dev/null; then echo "GitLab is reachable from the runner machine"; break; fi
    if [ "$i" = 60 ]; then echo "https://$DOMAIN is still not reachable from the runner machine after 30 minutes"; exit 1; fi
    echo "waiting for https://$DOMAIN to become reachable from here ($i/60)"
    sleep 30
  done
  T="$(aws secretsmanager get-secret-value --secret-id vitana/engineering/gitlab/runner-token --query SecretString --output text 2>/dev/null || true)"
  case "$T" in
    glrt-*) gitlab-runner register --non-interactive --url "https://$DOMAIN" --token "$T" --executor docker \
              --docker-image public.ecr.aws/docker/library/node:20-bookworm --description vitana-eng-1 --docker-pull-policy if-not-present \
              && echo "runner registered" || echo "registration failed" ;;
    *) echo "no runner token yet: GitLab has not finished its setup" ;;
  esac
fi
MEM_GB="$(awk '/MemTotal/ {print int($2 / 1048576)}' /proc/meminfo)"
CONC=3; [ "${MEM_GB:-0}" -ge 12 ] || CONC=1
sed -i "s/^concurrent = .*/concurrent = $CONC/" "$CONF"
systemctl restart gitlab-runner
gitlab-runner verify 2>&1 | tail -3
