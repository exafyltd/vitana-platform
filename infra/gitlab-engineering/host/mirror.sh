#!/bin/bash
# Mirrors exafyltd/vitana-platform and exafyltd/vitana-v1 from GitHub into GitLab (runs every 5 minutes from a
# systemd timer). GitHub stays the source of truth. Idle until the GitHub read-only token is stored in
# Secrets Manager (vitana/engineering/gitlab/github-mirror-token).
set -uo pipefail
scrub() { sed -e "s/$GH/***/g" -e "s/$GL/***/g"; }   # git can echo URLs with credentials in error messages; GH and GL are set below, before any push

# push_repo cache-dir gitlab-url repo: main first (it becomes the default branch of an empty GitLab project), then every other head and tag.
# Neither push forces or prunes. A branch or tag that exists only on GitLab stays. git moves a GitLab ref only when GitHub's value descends from
# it; a diverged head, a tag that differs, or a GitLab head that GitHub does not contain is refused and kept, and the push reports it.
push_repo() {
  local d="$1"
  git -C "$d" push -q "$2" refs/heads/main:refs/heads/main 2>&1 | scrub || { echo "push main failed: $3"; return 1; }
  git -C "$d" push -q "$2" 'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*' 2>&1 | scrub || { echo "push all failed: $3"; return 1; }
}
# The tests in scripts/eng/test-d-delivery source this file to call push_repo. They stop here: nothing below runs on that path.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then return 0; fi
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
for repo in vitana-platform vitana-v1; do
  d="/var/lib/vitana-mirror/$repo.git"
  [ -d "$d" ] || git init --bare -q "$d"
  echo "== $(date -u +%FT%TZ) $repo: fetch from GitHub"
  if ! git -C "$d" fetch -q --prune --update-head-ok "https://x-access-token:$GH@github.com/exafyltd/$repo.git" '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*' 2>&1 | scrub; then
    echo "fetch failed: $repo"; rc=1; continue
  fi
  url="http://oauth2:$GL@127.0.0.1/vitana/$repo.git"
  echo "== $repo: push to GitLab"
  push_repo "$d" "$url" "$repo" 2>&1 | scrub || { rc=1; continue; }
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
