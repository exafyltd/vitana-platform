#!/usr/bin/env bash
# Codebase-intelligence session setup (VTID-04758).
#
# Makes RepoWise + Graphify actually usable in a Claude Code session, for one
# or more repos. Replaces the VTID-04116/04121 hook body, which never produced
# an index in practice:
#   - it rebuilt RepoWise from scratch inside the 300 s hook timeout, but a
#     full vitana-platform index takes ~10 min (CI step "Build the RepoWise
#     index", run #268: 9 m 48 s) — so it was always killed half-way;
#   - session clones are shallow (~100 commits), so even a finished in-session
#     build had near-empty git history (hotspots, ownership, bug-fix counts);
#   - `.repowise/decisions.yaml` is committed, so on a fresh clone the
#     "[ -d .repowise ]" test chose `repowise update` against an index that did
#     not exist;
#   - it ran only from a repo's .claude/settings.json, which a multi-repo
#     session (working directory /home/user) never loads.
#
# What it does now:
#   1. Foreground, ~1 min on a fresh container, seconds when cached: install
#      repowise + graphify if missing and link them onto the default PATH, so
#      the committed .mcp.json ("command": "repowise") and the git hooks can
#      start them.
#   2. Detached, one worker per repo (flock-guarded, safe to re-run after a
#      container restart kills it):
#        RepoWise — seed from the full-history index CODEINTEL-INDEX.yml
#          publishes to s3://vitana-code-index/<owner>/<repo>/<sha>/ (the
#          manifest's `session_seed`), re-point it at this checkout, then
#          `repowise update` the few commits between that sha and HEAD.
#          Falls back to a local full build when no seed is reachable.
#        Graphify — a local `graphify update --no-cluster` (AST only, ~2-3 min,
#          no git history needed). Not seeded: its AST cache does not survive a
#          move between checkouts, so a seeded update measured the same 176 s
#          as a full build (VTID-04758 evidence pack).
#      then installs both tools' post-commit hooks so later commits in the
#      session keep the indexes current.
#   3. --register-mcp: registers one user-scope `repowise-<repo>` MCP server
#      per repo (for multi-repo sessions, where no project .mcp.json is read).
#
# Never fails the caller: every step degrades to "index missing/stale" with a
# logged reason. Progress: `session-setup.sh --status`.
#
# Usage:
#   session-setup.sh [--register-mcp] [--foreground] REPO_DIR [REPO_DIR...]
#   session-setup.sh --status [REPO_DIR...]
#
# Env knobs: CODEINTEL_STATE_DIR (default ~/.cache/vitana-codeintel),
#   CODE_INDEX_BUCKET (vitana-code-index), CODE_INDEX_REGION (eu-central-1),
#   CODEINTEL_GRAPHIFY_LABEL=0 to skip the Bedrock community-labelling pass
#   (VTID-04121), CODEINTEL_SKIP_SEED=1 to force a local RepoWise build,
#   CODE_INDEX_LOCAL_DIR to read the bucket layout from a local directory
#   (same override as services/gateway/src/services/codeintel-index.ts).
#
# Canonical copy: exafyltd/vitana-platform scripts/codeintel/session-setup.sh.
# exafyltd/vitana-v1 carries a byte-identical copy — change both together.

set -uo pipefail

STATE_DIR="${CODEINTEL_STATE_DIR:-$HOME/.cache/vitana-codeintel}"
BUCKET="${CODE_INDEX_BUCKET:-vitana-code-index}"
REGION="${CODE_INDEX_REGION:-eu-central-1}"
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
export PATH="$HOME/.local/bin:$PATH"
export REPOWISE_TELEMETRY_DISABLED=1

log() { echo "codeintel: $*" >&2; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
install_tool() {  # $1 = command name, $2 = package spec
  command -v "$1" >/dev/null 2>&1 && return 0
  log "installing $2..."
  if command -v uv >/dev/null 2>&1; then
    uv tool install --quiet "$2" >/dev/null 2>&1 && return 0
  fi
  python3 -m pip install --user --quiet "$2" >/dev/null 2>&1 && return 0
  log "$1 install FAILED"
  return 1
}

link_onto_default_path() {  # MCP servers and git hooks may not see ~/.local/bin
  local t dir=/usr/local/bin
  [ -w "$dir" ] || return 0
  for t in repowise graphify; do
    [ -x "$HOME/.local/bin/$t" ] || continue
    if [ ! -e "$dir/$t" ] || [ -L "$dir/$t" ]; then
      ln -sf "$HOME/.local/bin/$t" "$dir/$t"
    fi
  done
}

ensure_tools() {
  install_tool repowise repowise
  install_tool graphify 'graphifyy[bedrock]'
  link_onto_default_path
  # Only the S3 seed fetch needs boto3, and only when credentials exist.
  if [ -n "${AWS_ACCESS_KEY_ID:-}" ] && ! python3 -c 'import boto3' 2>/dev/null; then
    python3 -m pip install --user --quiet boto3 >/dev/null 2>&1 || log "boto3 install failed — no S3 seed"
  fi
}

# ---------------------------------------------------------------------------
# Helpers (python, so they work without the aws CLI or sqlite3 binaries)
# ---------------------------------------------------------------------------
repo_slug() {  # owner/name from the origin URL (works for the session git proxy too)
  git -C "$1" remote get-url origin 2>/dev/null \
    | sed -E 's#\.git$##; s#^.*[:/]([^/]+)/([^/]+)$#\1/\2#'
}

# Prints the number of wiki pages RepoWise holds for THIS checkout (0 when the
# index is missing, half-built, or belongs to another path).
repowise_pages() {
  python3 - "$1" <<'PY' 2>/dev/null || echo 0
import os, sqlite3, sys
repo = os.path.realpath(sys.argv[1])
db, state = os.path.join(repo, ".repowise/wiki.db"), os.path.join(repo, ".repowise/state.json")
if not (os.path.isfile(db) and os.path.isfile(state)):
    print(0); raise SystemExit
c = sqlite3.connect(db)
row = c.execute("select count(*) from wiki_pages p join repositories r on r.id = p.repository_id "
                "where r.local_path = ?", (repo,)).fetchone()
print(row[0] if row else 0)
PY
}

# Downloads <slug>'s published RepoWise seed into REPO/.repowise. Exit codes:
# 0 seeded, 2 nothing published/reachable, 3 seed sha unknown to this clone.
seed_repowise() {
  local repo="$1" slug="$2" tmp rc
  tmp="$(mktemp -d)"
  # CODE_INDEX_LOCAL_DIR (same override the gateway loader honours) reads the
  # bucket layout from a local directory instead of S3.
  python3 - "$BUCKET" "$REGION" "$slug" "$tmp" "${CODE_INDEX_LOCAL_DIR:-}" > "$tmp/out" <<'PY'
import json, os, shutil, sys
bucket, region, slug, tmp, local = sys.argv[1:]
try:
    if local:
        read = lambda key: open(os.path.join(local, key), "rb").read()
        fetch = lambda key, dst: shutil.copyfile(os.path.join(local, key), dst)
    else:
        import boto3
        s3 = boto3.client("s3", region_name=region)
        read = lambda key: s3.get_object(Bucket=bucket, Key=key)["Body"].read()
        fetch = lambda key, dst: s3.download_file(bucket, key, dst)
    m = json.loads(read(f"{slug}/latest/manifest.json"))
    seed = (m.get("session_seed") or {})
    name = (seed.get("files") or {}).get("repowise")
    if not name:
        print("ERR manifest has no session_seed (CODEINTEL-INDEX.yml predates VTID-04758)"); raise SystemExit(2)
    fetch(f"{slug}/{m['sha']}/{name}", f"{tmp}/repowise.tgz")
except SystemExit:
    raise
except Exception as e:  # no creds, no boto3, no access, nothing published
    print(f"ERR {type(e).__name__}: {str(e)[:200]}"); raise SystemExit(2)
print(m["sha"], seed.get("repowise_version", "?"))
PY
  rc=$?
  if [ $rc -ne 0 ]; then log "$slug: no RepoWise seed — $(cat "$tmp/out")"; rm -rf "$tmp"; return 2; fi
  read -r sha seed_ver < "$tmp/out"
  # The incremental update diffs seed sha..HEAD, so the clone must know the sha.
  if ! git -C "$repo" cat-file -e "${sha}^{commit}" 2>/dev/null; then
    git -C "$repo" fetch --quiet --depth=1 origin "$sha" 2>/dev/null || true
  fi
  if ! git -C "$repo" cat-file -e "${sha}^{commit}" 2>/dev/null; then
    log "$slug: seed sha ${sha:0:8} not in this clone and not fetchable — local build instead"
    rm -rf "$tmp"; return 3
  fi
  # Replace everything under .repowise except the committed decisions manifest.
  find "$repo/.repowise" -mindepth 1 -maxdepth 1 ! -name decisions.yaml -exec rm -rf {} + 2>/dev/null
  mkdir -p "$repo/.repowise"
  tar -xzf "$tmp/repowise.tgz" -C "$repo" --exclude='.repowise/decisions.yaml'
  rm -rf "$tmp"
  # The index stores the checkout it was built in; until it names this one,
  # every query sees 0 pages (measured: doctor ok, "Database -> 0 pages").
  python3 - "$repo" <<'PY'
import os, sqlite3, sys
repo = os.path.realpath(sys.argv[1])
c = sqlite3.connect(os.path.join(repo, ".repowise/wiki.db"))
# CI builds in a directory named `src`, which RepoWise also took as the repo name.
c.execute("update repositories set local_path = ?, name = ?", (repo, os.path.basename(repo))); c.commit()
# Session indexes never write tracked editor files (.claude/CLAUDE.md, AGENTS.md).
# CI builds the seed with --no-claude-md --no-agents, so its config already says
# so. Only an older seed lacks it; editing config.yaml makes the next update
# re-render every page (any config change does), so do it only when needed.
cfg = os.path.join(repo, ".repowise/config.yaml")
try:
    import yaml
    d = (yaml.safe_load(open(cfg)) if os.path.exists(cfg) else None) or {}
    ef = d.get("editor_files") or {}
    if ef.get("claude_md") is not False or ef.get("agents_md") is not False:
        d.setdefault("editor_files", {}).update({"claude_md": False, "agents_md": False})
        yaml.safe_dump(d, open(cfg, "w"), sort_keys=False)
        print("seed config allowed editor files; disabled them (one-off full re-render)", file=sys.stderr)
except Exception as e:
    print(f"config.yaml not adjusted: {e}", file=sys.stderr)
PY
  for f in mcp.json parse_cache.pkl; do rm -f "$repo/.repowise/$f"; done  # path-bound caches
  log "$slug: seeded RepoWise from CI index @ ${sha:0:8} (repowise $seed_ver)"
  echo "$sha" > "$repo/.repowise/.seed_sha"
  return 0
}

# `repowise init` stamps its config fingerprint before writing the editor flags,
# so the first update after it re-renders every page. Re-stamp with RepoWise's
# own interpreter (works for pip --user and uv tool installs alike).
restamp_config() {
  local bin py
  bin="$(readlink -f "$(command -v repowise)")" || return 0
  py="$(head -1 "$bin" | sed -n 's/^#!//p' | awk '{print $1}')"
  [ -x "$py" ] || { log "restamp skipped (no interpreter for $bin)"; return 0; }
  "$py" "$(dirname "$SELF")/repowise_restamp_config.py" "$1" >&2 || log "restamp failed (non-fatal)"
}

write_status() {  # $1 name, $2 json fields (no braces)
  printf '{"updated_at":"%s",%s}\n' "$(now)" "$2" > "$STATE_DIR/$1.json.tmp" \
    && mv "$STATE_DIR/$1.json.tmp" "$STATE_DIR/$1.json"
}

tracked_changes() { git -C "$1" status --porcelain --untracked-files=no 2>/dev/null | sort; }

# `graphify hook install` also registers a merge driver by writing
# `graphify-out/graph.json merge=graphify` into .gitattributes — an untracked
# file in both repos, i.e. a stray change in every session. Keep the driver but
# move its line to the clone-local .git/info/attributes and leave .gitattributes
# exactly as it was.
install_graphify_hooks() {
  local repo="$1" ga="$1/.gitattributes" info backup="" rc=0
  info="$(git -C "$repo" rev-parse --git-path info/attributes)"
  case "$info" in /*) ;; *) info="$repo/$info" ;; esac
  if [ -f "$ga" ]; then backup="$(mktemp)"; cp -p "$ga" "$backup"; fi
  (cd "$repo" && graphify hook install >/dev/null 2>&1) || rc=1
  if [ -f "$ga" ] && grep -q 'merge=graphify' "$ga"; then
    mkdir -p "$(dirname "$info")"
    grep -h 'merge=graphify' "$ga" | while read -r l; do grep -qxF "$l" "$info" 2>/dev/null || echo "$l" >> "$info"; done
    if [ -n "$backup" ]; then cp -p "$backup" "$ga"; else rm -f "$ga"; fi
  fi
  [ -n "$backup" ] && rm -f "$backup"
  return $rc
}

# ---------------------------------------------------------------------------
# Per-repo worker (runs detached; one at a time per repo)
# ---------------------------------------------------------------------------
worker() {
  local repo name slug head pages rw_source="none" rw_ok=false gf_ok=false t0 before after
  repo="$(readlink -f "$1")"; name="$(basename "$repo")"; slug="$(repo_slug "$repo")"
  exec 9>"$STATE_DIR/$name.lock"
  if ! flock -n 9; then log "$name: another indexing run holds the lock — leaving it"; return 0; fi
  cd "$repo" || return 0
  head="$(git rev-parse HEAD 2>/dev/null)"; t0=$(date +%s)
  before="$(tracked_changes "$repo")"
  write_status "$name" "\"state\":\"indexing\",\"repo\":\"$repo\",\"head\":\"$head\""
  log "$name: indexing started at HEAD ${head:0:8}"

  # 1. Put a RepoWise index in place first: a seed is queryable within seconds
  #    (a running `repowise mcp` picks it up without a restart), so it should
  #    not wait behind the Graphify build.
  if command -v repowise >/dev/null 2>&1; then
    pages="$(repowise_pages "$repo")"
    if [ "$pages" -gt 0 ]; then
      rw_source="existing"
    elif [ "${CODEINTEL_SKIP_SEED:-0}" != "1" ] && seed_repowise "$repo" "$slug"; then
      rw_source="ci-seed"
      restamp_config "$repo"
    fi
  fi

  # 2. Graphify (~2-3 min, local AST build).
  if command -v graphify >/dev/null 2>&1; then
    if timeout 1200 graphify update "$repo" --no-cluster; then
      gf_ok=true
      if [ "${CODEINTEL_GRAPHIFY_LABEL:-1}" = "1" ] && [ -n "${AWS_ACCESS_KEY_ID:-}" ]; then
        # VTID-04121: name communities via Bedrock (never Google). Best effort.
        timeout 900 graphify label "$repo" --backend bedrock --model eu.anthropic.claude-sonnet-4-6 \
          || log "$name: graphify label failed — graph stays unlabelled"
      fi
    else
      log "$name: graphify update failed"
    fi
    install_graphify_hooks "$repo" || log "$name: graphify hook install failed"
  fi

  # 3. Bring RepoWise up to HEAD (incremental), or build it locally.
  if command -v repowise >/dev/null 2>&1; then
    if [ "$rw_source" != "none" ]; then
      timeout 2400 repowise update "$repo" --no-workspace --no-agents -y && rw_ok=true \
        || log "$name: repowise update failed — falling back to a local build"
    fi
    if [ "$rw_ok" != true ]; then
      # Local full build. Shallow clones give it thin git history; still far
      # better than no index. --resume picks up a build a restart interrupted.
      local resume=""; [ -f "$repo/.repowise/wiki.db" ] && [ ! -f "$repo/.repowise/state.json" ] && resume="--resume"
      rw_source="local-build"
      timeout 3600 repowise init "$repo" --no-prose -y $resume --no-editor-setup --no-claude-md \
        --no-agents --no-codex --no-distill-hook --no-workspace && rw_ok=true \
        || log "$name: repowise init failed"
      [ "$rw_ok" = true ] && restamp_config "$repo"
    fi
    [ "$rw_ok" = true ] && { repowise hook install >/dev/null 2>&1 || log "$name: repowise hook install failed"; }
  fi

  after="$(tracked_changes "$repo")"
  [ "$before" = "$after" ] || log "$name: WARNING tracked files changed during indexing: $(comm -13 <(echo "$before") <(echo "$after") | tr '\n' ' ')"
  pages="$(repowise_pages "$repo")"
  local state=ready; { [ "$rw_ok" = true ] && [ "$gf_ok" = true ]; } || state=degraded
  write_status "$name" "\"state\":\"$state\",\"repo\":\"$repo\",\"head\":\"$head\",\"repowise\":{\"ok\":$rw_ok,\"source\":\"$rw_source\",\"pages\":$pages},\"graphify\":{\"ok\":$gf_ok},\"seconds\":$(( $(date +%s) - t0 ))"
  log "$name: $state in $(( $(date +%s) - t0 ))s (repowise=$rw_ok via $rw_source, $pages pages; graphify=$gf_ok)"
}

# ---------------------------------------------------------------------------
# MCP registration for multi-repo sessions
# ---------------------------------------------------------------------------
register_mcp() {  # user scope: read by every session regardless of working directory
  local repo name bin
  command -v claude >/dev/null 2>&1 || { log "claude CLI not found — MCP not registered"; return 0; }
  bin="$(command -v repowise)" || { log "repowise missing — MCP not registered"; return 0; }
  for repo in "$@"; do
    name="repowise-$(basename "$repo")"
    claude mcp remove --scope user "$name" >/dev/null 2>&1 || true
    # Name before -e: -e is variadic and would swallow it.
    claude mcp add --scope user "$name" -e REPOWISE_TELEMETRY_DISABLED=1 -- \
      "$bin" mcp "$repo" --transport stdio >/dev/null 2>&1 \
      && log "registered MCP server $name" || log "MCP registration failed for $name"
  done
}

print_status() {
  local repo f
  for repo in "$@"; do
    f="$STATE_DIR/$(basename "$repo").json"
    if [ -f "$f" ]; then cat "$f"; else echo "{\"repo\":\"$repo\",\"state\":\"never-run\"}"; fi
  done
}

# ---------------------------------------------------------------------------
main() {
  local register=0 foreground=0 repos=() r
  mkdir -p "$STATE_DIR"
  while [ $# -gt 0 ]; do
    case "$1" in
      --worker) shift; worker "$1"; return 0 ;;
      --status) shift; [ $# -gt 0 ] || set -- /home/user/*/; print_status "$@"; return 0 ;;
      --register-mcp) register=1 ;;
      --foreground) foreground=1 ;;
      -*) log "unknown option $1" ;;
      *) repos+=("$1") ;;
    esac
    shift
  done
  for r in "${repos[@]}"; do
    git -C "$r" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { log "skipping $r (not a git checkout)"; continue; }
    valid+=("$(readlink -f "$r")")
  done
  [ "${#valid[@]}" -gt 0 ] || { log "no repositories to index"; return 0; }
  ensure_tools
  [ "$register" = 1 ] && register_mcp "${valid[@]}"
  for r in "${valid[@]}"; do
    local lf="$STATE_DIR/$(basename "$r").log"
    if [ "$foreground" = 1 ]; then
      bash "$SELF" --worker "$r" >>"$lf" 2>&1
    else
      # setsid: outlive the hook's process group; the hook returns at once.
      setsid nohup bash "$SELF" --worker "$r" >>"$lf" 2>&1 < /dev/null &
      log "$(basename "$r"): indexing in the background — log $lf, status: $SELF --status"
    fi
  done
}

valid=()
main "$@"
exit 0
