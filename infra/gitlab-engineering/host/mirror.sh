#!/bin/bash
# Mirrors exafyltd/vitana-platform and exafyltd/vitana-v1 from GitHub into GitLab (runs every 5 minutes from a
# systemd timer). GitHub stays the source of truth. Idle until the GitHub read-only token is stored in
# Secrets Manager (vitana/engineering/gitlab/github-mirror-token).
set -uo pipefail
. /etc/vitana/env
export AWS_DEFAULT_REGION="$REGION" HOME=/root
exec 9>/run/vitana-mirror.lock
flock -n 9 || { echo "mirror already running"; exit 0; }

GH="$(aws secretsmanager get-secret-value --secret-id vitana/engineering/gitlab/github-mirror-token --query SecretString --output text 2>/dev/null || true)"
case "$GH" in ""|None) echo "$(date -u +%FT%TZ) GitHub token not stored yet: nothing to mirror"; exit 0 ;; esac
GL="$(cat /etc/vitana/mirror-token 2>/dev/null || true)"
[ -n "$GL" ] || { echo "mirror token missing: run gitlab-configure.sh"; exit 1; }

mkdir -p /var/lib/vitana-mirror
rc=0
scrub() { sed -e "s/$GH/***/g" -e "s/$GL/***/g"; }   # git can echo URLs with credentials in error messages
for repo in vitana-platform vitana-v1; do
  d="/var/lib/vitana-mirror/$repo.git"
  [ -d "$d" ] || git init --bare -q "$d"
  echo "== $(date -u +%FT%TZ) $repo: fetch from GitHub"
  if ! git -C "$d" fetch -q --prune --update-head-ok "https://x-access-token:$GH@github.com/exafyltd/$repo.git" '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*' 2>&1 | scrub; then
    echo "fetch failed: $repo"; rc=1; continue
  fi
  url="http://oauth2:$GL@127.0.0.1/vitana/$repo.git"
  echo "== $repo: push to GitLab"
  # main first, so it becomes the default branch of the empty GitLab project
  git -C "$d" push -q "$url" refs/heads/main:refs/heads/main 2>&1 | scrub || { echo "push main failed: $repo"; rc=1; continue; }
  git -C "$d" push -q --prune "$url" '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*' 2>&1 | scrub || { echo "push all failed: $repo"; rc=1; continue; }
  # The first full push creates hundreds of branches at once, and GitLab skips pipelines for such pushes.
  # Start the first pipeline on main explicitly.
  mark="/var/lib/vitana-mirror/$repo.first-pipeline"
  if [ ! -f "$mark" ]; then
    pid="$(cat "/etc/vitana/proj-${repo#vitana-}" 2>/dev/null || true)"
    if [ -n "$pid" ]; then
      code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "PRIVATE-TOKEN: $GL" "http://127.0.0.1/api/v4/projects/$pid/pipeline?ref=main")"
      echo "first pipeline on main for $repo: HTTP $code"
      [ "$code" = 201 ] && touch "$mark"
    fi
  fi
done
exit $rc
