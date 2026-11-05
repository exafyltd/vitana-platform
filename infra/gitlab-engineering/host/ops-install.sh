#!/bin/bash
# Installs the milestone 2 pieces on the GitLab machine (plan eng-gitlab-m2 section 3.3, lane settings). The owner runs it once, as root,
# with  bash ~/vitana-eng/m2.sh install  (AWS Systems Manager sends this file to the machine). Safe to run again: a second run changes
# nothing and says so. Log: /var/log/vitana-bootstrap.log, like milestone 1.
#
#   1. Node 20: the official tarball of a pinned version from nodejs.org, its SHA256 checked, under /opt/node, linked as node, npm and npx
#   2. /opt/vitana/git-askpass.sh: gives git the token of the mirror user (in no URL and in no git config)
#   3. the checkout /opt/vitana/platform of main of the local GitLab project vitana/vitana-platform (read access with /etc/vitana/mirror-token)
#   4. every unit in the checkout's infra/gitlab-engineering/host/units/ (glob) into /etc/systemd/system, then daemon-reload
#   5. /etc/vitana/settings-admin-token: a personal access token of root (scope api, 30 days, mode 0600), made when it is absent or GitLab refuses it
#   6. every script in host/ops.d/ (glob), one after the other; a script that fails is logged and the others still run
#   7. every timer in host/units/ enabled and started (the settings sync, the checkout sync, the merge bot and the metrics job come from the glob)
# Exit code: 0 when every step went well, 1 when a step failed (the steps that do not depend on it still ran). No token is printed or logged.
# OPS_PREFIX (a directory put in front of every path) and OPS_GIT_URL (a local repository) exist so that scripts/eng/free-tier-guard.test.mjs can run
# this file against stand-ins without being root; the owner's run sets neither.
set -uo pipefail

P="${OPS_PREFIX:-}"
ETC="$P/etc/vitana"
OPT="$P/opt/vitana"
CHECKOUT="$OPT/platform"
LOG="$P/var/log/vitana-bootstrap.log"
UNIT_DIR="$P/etc/systemd/system"
UNITS_SRC="$CHECKOUT/infra/gitlab-engineering/host/units"
OPS_D="$CHECKOUT/infra/gitlab-engineering/host/ops.d"
GITLAB="http://127.0.0.1"
GIT_URL="${OPS_GIT_URL:-http://127.0.0.1/vitana/vitana-platform.git}"

NODE_VERSION=20.20.2
NODE_SHA256=19e56f0825510207dd904f087fe52faa0a4eb6b2aab5f0ea7a33830d04888b8b
NODE_TARBALL="node-v${NODE_VERSION}-linux-x64.tar.gz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"
SHASUMS_URL="https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
NODE_DIR_NAME="node-v${NODE_VERSION}-linux-x64"

if [ -z "$P" ] && [ "$(id -u)" != 0 ]; then echo "ops-install: run this as root (m2.sh install does)" >&2; exit 1; fi
mkdir -p "$(dirname "$LOG")" "$ETC" "$OPT" "$UNIT_DIR" "$P/usr/bin" "$P/usr/local/bin" "$P/opt/node"
export HOME="${HOME:-/root}" DEBIAN_FRONTEND=noninteractive

CHANGES=0
FAILED=""
say() { local l; l="$(date -u +%FT%TZ) ops-install: $*"; echo "$l"; echo "$l" >> "$LOG"; }   # screen and log
note() { echo "$(date -u +%FT%TZ) ops-install: $*" >> "$LOG"; }                                # log only
changed() { CHANGES=$((CHANGES + 1)); }
failed() { FAILED="$FAILED $1"; say "!! $2"; }

say "== start"
if [ ! -r "$ETC/env" ]; then echo "ops-install: $ETC/env is missing: milestone 1 did not finish on this machine (see $LOG)" >&2; exit 1; fi
set -a; . "$ETC/env"; set +a
export AWS_DEFAULT_REGION="${REGION:-}"

# ---------------------------------------------------------------- 1. node
install_node() {
  local dir="$P/opt/node/$NODE_DIR_NAME" arch tmp got b want
  if [ -x "$dir/bin/node" ] && [ "$("$dir/bin/node" --version 2>/dev/null)" = "v$NODE_VERSION" ]; then
    say "node v$NODE_VERSION: already installed"
  else
    arch="$(uname -m)"
    if [ "$arch" != x86_64 ]; then failed node "node: this script installs the x86_64 build and this machine is $arch"; return 1; fi
    tmp="$(mktemp -d "${TMPDIR:-/tmp}/ops-node.XXXXXX")" || { failed node "node: no temporary directory"; return 1; }
    if ! curl -fsSL --retry 3 -o "$tmp/$NODE_TARBALL" "$NODE_URL" >> "$LOG" 2>&1; then
      rm -rf "$tmp"; failed node "node: the download of $NODE_URL failed (see $LOG)"; return 1
    fi
    got="$(sha256sum "$tmp/$NODE_TARBALL" | awk '{print $1}')"
    if [ "$got" != "$NODE_SHA256" ]; then
      rm -rf "$tmp"; failed node "node: the SHA256 of the tarball is $got, not the pinned $NODE_SHA256; nothing was installed"; return 1
    fi
    # The checksum that nodejs.org publishes for this file must be the pinned one too (when the list cannot be fetched, the pin alone was checked).
    if curl -fsSL --retry 3 -o "$tmp/SHASUMS256.txt" "$SHASUMS_URL" >> "$LOG" 2>&1; then
      if ! grep -q "^$NODE_SHA256  $NODE_TARBALL\$" "$tmp/SHASUMS256.txt"; then
        rm -rf "$tmp"; failed node "node: nodejs.org publishes another checksum for $NODE_TARBALL than the pinned $NODE_SHA256; nothing was installed"; return 1
      fi
    else
      note "node: $SHASUMS_URL is not reachable; the pinned checksum was verified"
    fi
    if ! tar -xzf "$tmp/$NODE_TARBALL" -C "$tmp" >> "$LOG" 2>&1 || [ ! -x "$tmp/$NODE_DIR_NAME/bin/node" ]; then
      rm -rf "$tmp"; failed node "node: the tarball did not unpack to $NODE_DIR_NAME/bin/node"; return 1
    fi
    rm -rf "$dir.new"
    mv "$tmp/$NODE_DIR_NAME" "$dir.new" && mv "$dir.new" "$dir"
    rm -rf "$tmp"
    changed
    say "node v$NODE_VERSION: installed under /opt/node"
  fi
  # /usr/bin/node is where the units of the merge bot, the metrics job and the settings sync look for it
  for b in node npm npx; do
    want="/opt/node/$NODE_DIR_NAME/bin/$b"
    if [ "$(readlink "$P/usr/local/bin/$b" 2>/dev/null)" != "$want" ]; then ln -sfn "$want" "$P/usr/local/bin/$b" && changed; fi
  done
  want="/opt/node/$NODE_DIR_NAME/bin/node"
  if [ "$(readlink "$P/usr/bin/node" 2>/dev/null)" != "$want" ]; then ln -sfn "$want" "$P/usr/bin/node" && changed; fi
  return 0
}

# ---------------------------------------------------------------- 2. the git helper
install_askpass() {
  local f="$OPT/git-askpass.sh" want
  want='#!/bin/sh
case "$1" in Username*) echo oauth2 ;; *) cat /etc/vitana/mirror-token ;; esac'
  if [ -f "$f" ] && [ "$(cat "$f")" = "$want" ] && [ "$(stat -c %a "$f")" = 700 ]; then
    say "git helper: in place"
    return 0
  fi
  printf '%s\n' "$want" > "$f.new" && chmod 0700 "$f.new" && mv "$f.new" "$f" && changed && say "git helper: written to /opt/vitana/git-askpass.sh"
}

# ---------------------------------------------------------------- 3. the checkout
git_run() { GIT_ASKPASS="$OPT/git-askpass.sh" GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 git "$@"; }
ensure_checkout() {
  local before after url branch
  if [ ! -s "$ETC/mirror-token" ]; then
    failed checkout "checkout: $ETC/mirror-token is missing, so git cannot read the local GitLab project (gitlab-configure.sh makes it; see $LOG)"; return 1
  fi
  if [ ! -d "$CHECKOUT/.git" ]; then
    if ! git_run clone --quiet --branch main --single-branch "$GIT_URL" "$CHECKOUT" >> "$LOG" 2>&1; then
      failed checkout "checkout: cannot clone branch main of $GIT_URL. If the mirror has not copied vitana-platform into GitLab yet, store the GitHub token (setup.sh token), wait 5 minutes, and run this again (details: $LOG)"
      return 1
    fi
    changed
    say "checkout: cloned main to /opt/vitana/platform ($(git -C "$CHECKOUT" rev-parse --short HEAD))"
  else
    url="$(git -C "$CHECKOUT" remote get-url origin 2>/dev/null || true)"
    if [ "$url" != "$GIT_URL" ]; then git -C "$CHECKOUT" remote set-url origin "$GIT_URL" && changed && say "checkout: origin set to $GIT_URL"; fi
    branch="$(git -C "$CHECKOUT" symbolic-ref --short HEAD 2>/dev/null || true)"
    if [ "$branch" != main ]; then failed checkout "checkout: /opt/vitana/platform is on '${branch:-no branch}', not main; leaving it alone"; return 1; fi
    before="$(git -C "$CHECKOUT" rev-parse HEAD)"
    if ! git_run -C "$CHECKOUT" fetch --quiet origin main >> "$LOG" 2>&1 || ! git -C "$CHECKOUT" merge --quiet --ff-only FETCH_HEAD >> "$LOG" 2>&1; then
      failed checkout "checkout: cannot fast-forward /opt/vitana/platform to main (fetch or merge --ff-only failed; see $LOG). Nothing was changed there"; return 1
    fi
    after="$(git -C "$CHECKOUT" rev-parse HEAD)"
    if [ "$before" != "$after" ]; then changed; say "checkout: fast-forwarded to $(git -C "$CHECKOUT" rev-parse --short HEAD)"; else say "checkout: up to date ($(git -C "$CHECKOUT" rev-parse --short HEAD))"; fi
  fi
  # No credential may sit in the checkout: not in the remote URL, not in the git config.
  url="$(git -C "$CHECKOUT" remote get-url origin 2>/dev/null || true)"
  case "$url" in *@*) failed checkout "checkout: the origin URL of /opt/vitana/platform holds credentials; fix it with: git -C /opt/vitana/platform remote set-url origin $GIT_URL"; return 1 ;; esac
  if git -C "$CHECKOUT" config --local --get-regexp '^(credential\.|http\..*extraheader)' > /dev/null 2>&1; then
    failed checkout "checkout: the git config of /opt/vitana/platform holds a credential setting; remove it"; return 1
  fi
  return 0
}

# ---------------------------------------------------------------- 4. units
CHANGED_TIMERS=""
install_units() {
  local f name n=0 c=0
  if [ ! -d "$UNITS_SRC" ]; then
    failed units "units: the checkout has no infra/gitlab-engineering/host/units yet. The milestone 2 files are not in GitLab: merge them on GitHub, wait 5 minutes for the mirror, and run this again"
    return 1
  fi
  for f in "$UNITS_SRC"/*; do
    [ -f "$f" ] || continue
    case "$f" in *.service|*.timer) ;; *) continue ;; esac
    name="$(basename "$f")"
    n=$((n + 1))
    if [ -f "$UNIT_DIR/$name" ] && cmp -s "$f" "$UNIT_DIR/$name"; then continue; fi
    cp "$f" "$UNIT_DIR/$name.new" && chmod 0644 "$UNIT_DIR/$name.new" && mv "$UNIT_DIR/$name.new" "$UNIT_DIR/$name" || { failed units "units: cannot write $UNIT_DIR/$name"; return 1; }
    c=$((c + 1))
    changed
    case "$name" in *.timer) CHANGED_TIMERS="$CHANGED_TIMERS $name" ;; esac
  done
  if [ "$n" = 0 ]; then failed units "units: $UNITS_SRC holds no .service or .timer file"; return 1; fi
  if [ "$c" -gt 0 ]; then
    systemctl daemon-reload >> "$LOG" 2>&1 || { failed units "units: systemctl daemon-reload failed"; return 1; }
    say "units: $c installed or updated, of $n"
  else
    say "units: $n already installed"
  fi
  return 0
}

# ---------------------------------------------------------------- 5. the admin token of the settings sync
http_code() {   # token -> HTTP status of GET /personal_access_tokens/self; the token goes to curl on its standard input, never into the process list
  printf 'header = "PRIVATE-TOKEN: %s"\n' "$1" | curl -sS -m 20 -o /dev/null -w '%{http_code}' -K - "$GITLAB/api/v4/personal_access_tokens/self" 2>/dev/null || true
}
ensure_admin_token() {
  local f="$ETC/settings-admin-token" tok code
  if [ -s "$f" ]; then
    code="$(http_code "$(cat "$f")")"
    case "$code" in
      200) say "admin token: valid, kept"; return 0 ;;
      401) note "admin token: GitLab refused the token in $f (401); a new one is made" ;;
      *) failed token "admin token: GitLab answered HTTP ${code:-000} when the token was tried, so no new token is made now. Is GitLab up? Run this again"; return 1 ;;
    esac
  fi
  if ! command -v gitlab-rails > /dev/null 2>&1; then failed token "admin token: gitlab-rails is not on this machine"; return 1; fi
  tok="$(openssl rand -hex 10 2>/dev/null)"   # GitLab wants exactly 20 characters for a token that is set by hand (as gitlab-configure.sh does)
  if [[ ! "$tok" =~ ^[0-9a-f]{20}$ ]]; then failed token "admin token: openssl did not give 20 hex characters (is openssl installed?)"; return 1; fi
  if ! gitlab-rails runner "t = User.find_by_username('root').personal_access_tokens.create(scopes: ['api'], name: 'vitana-settings-admin', expires_at: 30.days.from_now); t.set_token('$tok'); t.save!; puts 'PAT_OK'" 2>&1 | sed "s/$tok/[redacted]/g" >> "$LOG"; then
    failed token "admin token: gitlab-rails could not create it (see $LOG)"; return 1
  fi
  if ! ( umask 077; printf '%s\n' "$tok" > "$f.new" ) || ! chmod 0600 "$f.new" || ! mv "$f.new" "$f"; then
    rm -f "$f.new"; failed token "admin token: cannot write $f"; return 1
  fi
  code="$(http_code "$tok")"
  if [ "$code" != 200 ]; then failed token "admin token: GitLab does not accept the new token (HTTP ${code:-000}); see $LOG"; return 1; fi
  changed
  say "admin token: made (scope api, 30 days) and written to /etc/vitana/settings-admin-token"
}

# ---------------------------------------------------------------- 6. host/ops.d
run_ops_d() {
  local f name rc
  [ -d "$OPS_D" ] || return 0
  for f in "$OPS_D"/*; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    bash "$f" >> "$LOG" 2>&1
    rc=$?
    if [ "$rc" = 0 ]; then
      say "ops.d/$name: ok"
    else
      failed "ops.d/$name" "ops.d/$name failed with exit $rc; the others still run. Its last log lines:"
      tail -n 5 "$LOG" | cut -c1-200 | sed 's/^/     /'
    fi
  done
  return 0
}

# ---------------------------------------------------------------- 7. timers
enable_timers() {
  local f t
  [ -d "$UNITS_SRC" ] || return 0
  for f in "$UNITS_SRC"/*.timer; do
    [ -f "$f" ] || continue
    t="$(basename "$f")"
    if systemctl is-enabled --quiet "$t" > /dev/null 2>&1 && systemctl is-active --quiet "$t" > /dev/null 2>&1; then
      case " $CHANGED_TIMERS " in
        *" $t "*) systemctl restart "$t" >> "$LOG" 2>&1 && say "timer $t: restarted with its new schedule" ;;
        *) say "timer $t: enabled and running" ;;
      esac
      continue
    fi
    if systemctl enable --now "$t" >> "$LOG" 2>&1; then changed; say "timer $t: enabled and started"; else failed "timer-$t" "timer $t: systemctl enable --now failed (see $LOG)"; fi
  done
  return 0
}

install_node
install_askpass
CHECKOUT_OK=0
if ensure_checkout; then
  CHECKOUT_OK=1
  install_units
fi
ensure_admin_token
if [ "$CHECKOUT_OK" = 1 ]; then
  run_ops_d
  enable_timers
else
  say "ops.d and the timers wait for a good checkout"
fi

if [ -n "$FAILED" ]; then
  say "== FAILED:$FAILED. The steps that do not depend on a failed one ran. Fix the cause named above and run  m2.sh install  again (details: /var/log/vitana-bootstrap.log)"
  exit 1
fi
if [ "$CHANGES" = 0 ]; then say "== done: nothing changed"; else say "== done: $CHANGES change(s)"; fi
exit 0
