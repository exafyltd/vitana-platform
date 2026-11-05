#!/bin/bash
# Configures a freshly installed GitLab: instance settings, CI runner, group and projects, central CI config,
# mirror user and timer, nightly backup. Idempotent: re-run with  sudo bash /opt/vitana/gitlab-configure.sh
# Log: /var/log/vitana-bootstrap.log (also /var/log/vitana-bootstrap.done when finished)
set -uo pipefail
. /etc/vitana/env
export AWS_DEFAULT_REGION="$REGION" HOME=/root
echo "== configure start $(date -u +%FT%TZ)"
BASE=http://127.0.0.1
FAILS=0
warn() { echo "!! $*"; FAILS=$((FAILS + 1)); }
api() { local m="$1" p="$2"; shift 2; curl -sS -X "$m" -H "PRIVATE-TOKEN: $PAT" "$BASE/api/v4$p" "$@"; }

echo "-- wait for GitLab"
code=000
for i in $(seq 1 90); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/users/sign_in" || true)"
  [ "$code" = 200 ] && break
  sleep 10
done
[ "$code" = 200 ] || { echo "GitLab not ready (HTTP $code)"; exit 1; }

echo "-- bootstrap admin token"
PAT_FILE=/etc/vitana/bootstrap-pat
PAT="$(cat "$PAT_FILE" 2>/dev/null || true)"
if [ -z "$PAT" ] || [ "$(curl -s -o /dev/null -w '%{http_code}' -H "PRIVATE-TOKEN: $PAT" "$BASE/api/v4/user")" != 200 ]; then
  PAT="$(openssl rand -hex 10)"   # GitLab requires exactly 20 characters for a pre-set token
  gitlab-rails runner "t = User.find_by_username('root').personal_access_tokens.create(scopes: ['api', 'create_runner'], name: 'vitana-bootstrap', expires_at: 7.days.from_now); t.set_token('$PAT'); t.save!; puts 'PAT_OK'" 2>&1 | tail -3
  (umask 077; echo "$PAT" > "$PAT_FILE")
fi
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "PRIVATE-TOKEN: $PAT" "$BASE/api/v4/user")" = 200 ] || { echo "bootstrap token not accepted"; exit 1; }

echo "-- instance settings"
api PUT /application/settings \
  --data-urlencode signup_enabled=false \
  --data-urlencode require_two_factor_authentication=true \
  --data-urlencode two_factor_grace_period=48 \
  --data-urlencode usage_ping_enabled=false \
  --data-urlencode default_project_visibility=private \
  --data-urlencode default_group_visibility=private \
  -o /dev/null -w 'settings: HTTP %{http_code}\n'
api PUT /application/settings -H 'Content-Type: application/json' \
  -d '{"default_branch_protection_defaults":{"allow_force_push":true,"allowed_to_push":[{"access_level":40}],"allowed_to_merge":[{"access_level":40}]}}' \
  -o /dev/null -w 'branch protection defaults: HTTP %{http_code}\n'

echo "-- CI runner"
if [ ! -f /etc/vitana/runner-created ]; then
  R="$(api POST /user/runners --data-urlencode runner_type=instance_type --data-urlencode description=vitana-eng-1 \
        --data-urlencode tag_list=vitana-eng --data-urlencode run_untagged=false --data-urlencode locked=false)"
  RT="$(jq -r '.token // empty' <<<"$R")"
  if [ -n "$RT" ] && aws secretsmanager put-secret-value --secret-id vitana/engineering/gitlab/runner-token --secret-string "$RT" >/dev/null; then
    touch /etc/vitana/runner-created
    echo "runner created, token stored in Secrets Manager"
  else
    warn "runner creation failed: $R"
  fi
fi

echo "-- group and projects"
GID="$(api GET "/groups?search=vitana" | jq -r '[.[] | select(.path == "vitana")][0].id // empty')"
[ -n "$GID" ] || GID="$(api POST /groups --data-urlencode name=vitana --data-urlencode path=vitana --data-urlencode visibility=private | jq -r '.id // empty')"
[ -n "$GID" ] || { echo "cannot create group vitana"; exit 1; }
mkproj() {   # name ci_config_path initialize_with_readme
  local id
  id="$(api GET "/projects/vitana%2F$1" | jq -r '.id // empty')"
  if [ -z "$id" ]; then
    id="$(api POST /projects --data-urlencode "name=$1" --data-urlencode "path=$1" --data-urlencode "namespace_id=$GID" \
          --data-urlencode visibility=private --data-urlencode "initialize_with_readme=$3" \
          ${2:+--data-urlencode "ci_config_path=$2"} | jq -r '.id // empty')"
  fi
  echo "$id"
}
CFG="$(mkproj ci-config "" true)"
PLAT="$(mkproj vitana-platform "platform.gitlab-ci.yml@vitana/ci-config:main" false)"
V1="$(mkproj vitana-v1 "v1.gitlab-ci.yml@vitana/ci-config:main" false)"
echo "projects: ci-config=$CFG vitana-platform=$PLAT vitana-v1=$V1"
[ -n "$CFG" ] && [ -n "$PLAT" ] && [ -n "$V1" ] || { echo "project creation failed"; exit 1; }
echo "$PLAT" > /etc/vitana/proj-platform
echo "$V1" > /etc/vitana/proj-v1

echo "-- central CI config"
putfile() {   # local file, name in the ci-config project
  local b64 verb
  b64="$(base64 -w0 < "$1")"
  if [ "$(api GET "/projects/$CFG/repository/files/$2?ref=main" -o /dev/null -w '%{http_code}')" = 200 ]; then verb=PUT; else verb=POST; fi
  api "$verb" "/projects/$CFG/repository/files/$2" --data-urlencode branch=main --data-urlencode "content=$b64" \
    --data-urlencode encoding=base64 --data-urlencode "commit_message=vitana-eng: update $2" -o /dev/null -w "$2: HTTP %{http_code}\n"
}
putfile /opt/vitana/ci-platform.yml platform.gitlab-ci.yml
putfile /opt/vitana/ci-v1.yml v1.gitlab-ci.yml

echo "-- mirror user"
MU="$(api GET "/users?username=vitana-mirror" | jq -r '.[0].id // empty')"
[ -n "$MU" ] || MU="$(api POST /users --data-urlencode "email=vitana-mirror@$DOMAIN" --data-urlencode username=vitana-mirror \
      --data-urlencode "name=Vitana mirror" --data-urlencode force_random_password=true --data-urlencode skip_confirmation=true \
      --data-urlencode projects_limit=0 --data-urlencode can_create_group=false | jq -r '.id // empty')"
if [ -n "$MU" ]; then
  for pair in "$PLAT:40" "$V1:40" "$CFG:20"; do
    api POST "/projects/${pair%%:*}/members" --data-urlencode "user_id=$MU" --data-urlencode "access_level=${pair##*:}" -o /dev/null -w 'member: HTTP %{http_code}\n'
  done
  if [ ! -s /etc/vitana/mirror-token ]; then
    MT="$(api POST "/users/$MU/personal_access_tokens" --data-urlencode name=mirror --data-urlencode "scopes[]=api" \
          --data-urlencode "scopes[]=write_repository" --data-urlencode "expires_at=$(date -u -d '+360 days' +%F)" | jq -r '.token // empty')"
    if [ -n "$MT" ]; then (umask 077; echo "$MT" > /etc/vitana/mirror-token); else warn "mirror token not created"; fi
  fi
else
  warn "mirror user not created"
fi

echo "-- mirror timer and nightly backup"
cat > /etc/systemd/system/vitana-mirror.service <<'EOF'
[Unit]
Description=Mirror GitHub repositories into GitLab
After=network-online.target

[Service]
Type=oneshot
ExecStart=/opt/vitana/mirror.sh
TimeoutStartSec=infinity
EOF
cat > /etc/systemd/system/vitana-mirror.timer <<'EOF'
[Unit]
Description=Run the GitHub to GitLab mirror every 5 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
Unit=vitana-mirror.service

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now vitana-mirror.timer
echo '15 2 * * * root /opt/vitana/backup.sh >> /var/log/vitana-backup.log 2>&1' > /etc/cron.d/vitana-backup
systemd-run --unit=vitana-first-backup --no-block bash -c '/opt/vitana/backup.sh >> /var/log/vitana-backup.log 2>&1'

echo "== configure done $(date -u +%FT%TZ) failures=$FAILS"
echo "done failures=$FAILS $(date -u +%FT%TZ)" > /var/log/vitana-bootstrap.done
