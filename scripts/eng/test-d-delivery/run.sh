#!/bin/bash
# Isolated tests for the delivery safety checks (PR #5130, VTID-05545): the cut (delivery-cutover.sh), the rollback (delivery-rollback.sh) and the
# copy on the GitLab machine (infra/gitlab-engineering/host/mirror.sh).   bash scripts/eng/test-d-delivery/run.sh
# Nothing here reaches AWS, GitHub or GitLab. Every repository is a local bare repository under a temporary folder. Each network-facing command
# (aws, gh, curl, ssh, wget, ssm) is a stub first on PATH: it writes its call to a log and fails, and a case during which the log grows fails. The cut and the
# rollback read GitHub through in-process fakes that answer from those repositories; the GitHub fake refuses and logs any write. The GitLab machine
# is faked as well: each page of the branch listing and the final copy run the real script text under sh, with a curl and a systemctl that answer
# from the local repositories. The listing page carries an X-Total header, as GitLab's branches API does. Systems Manager output is cut to 24,000
# characters as it is for real, and the byte count of every listing page is recorded. The runner fails a case whose log shows a state-changing script
# the case did not expect. Exit: 0 when every case passes and no stub was called, 1 otherwise.
# This file never runs scripts/eng/delivery-cutover.test.mjs.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
CUT="$REPO/scripts/eng/delivery-cutover.sh"
RB="$REPO/scripts/eng/delivery-rollback.sh"
MIRROR="$REPO/infra/gitlab-engineering/host/mirror.sh"

T="$(mktemp -d "${TMPDIR:-/tmp}/test-d-delivery.XXXXXX")" || { echo "cannot make a temporary folder" >&2; exit 1; }
STUBS="$T/stubs"; STUB_LOG="$T/stub-calls.log"; MACHINE_BIN="$T/machine/bin"
mkdir -p "$STUBS" "$T/home" "$MACHINE_BIN"; : > "$STUB_LOG"
for c in aws gh curl ssh wget ssm; do
  cat > "$STUBS/$c" <<STUB
#!/bin/bash
echo "$c \$*" >> "$STUB_LOG"
echo "test-d-delivery: $c was called, but these tests must not reach AWS or the network" >&2
exit 99
STUB
  chmod +x "$STUBS/$c"
done
# The GitLab machine's own curl. It is first on the PATH of the fake machine's sh only (fake_ssm), never on the PATH of the cut.
cat > "$MACHINE_BIN/curl" <<'MACHINE'
#!/bin/bash
# FAKE_GITLAB_DIR: the GitLab repositories. Every branches answer carries an X-Total header, as the API does. FAKE_NO_XTOTAL=1: no X-Total.
# FAKE_XTOTAL_EXTRA=N: X-Total is N higher than the branches, from page FAKE_XTOTAL_FROM on (default 1). FAKE_PAGE_FAIL=N: page N answers with an
# error body. FAKE_REPEAT_PAGE=N: page N repeats page N-1.
cat >/dev/null   # the token header comes on stdin; this fake does not use it
url="${*: -1}"
repo="$(sed -n 's#.*/projects/vitana%2F\([^/]*\)/.*#\1#p' <<<"$url")"
listing() { git -C "$FAKE_GITLAB_DIR/$repo.git" for-each-ref --format='%(refname:strip=2) %(objectname)' "refs/$1/"; }   # heads|tags
page_answer() {   # heads|tags: one page of the fake GitLab listing, with X-Total
  local kind="$1" page src extra total
  page="${url##*page=}"; src="$page"
  [ "$page" != "${FAKE_REPEAT_PAGE:-0}" ] || src=$((page - 1))
  extra=${FAKE_XTOTAL_EXTRA:-0}; [ "$page" -ge "${FAKE_XTOTAL_FROM:-1}" ] || extra=0
  total=$(( $(listing "$kind" | wc -l) + extra ))
  printf 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n'
  [ "${FAKE_NO_XTOTAL:-0}" = 1 ] || printf 'X-Total: %s\r\n' "$total"
  printf '\r\n'
  if [ "$page" = "${FAKE_PAGE_FAIL:-0}" ]; then printf '%s' '{"message":"500 Internal Server Error"}'; exit 0; fi
  listing "$kind" | sed -n "$(( (src - 1) * 100 + 1 )),$(( src * 100 ))p" \
    | jq -R -s 'split("\n") | map(select(length > 0) | split(" ") | {name: .[0], commit: {id: .[1]}})'
}
case "$url" in
  *"/repository/branches/main")
    printf 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n'
    sha="$(git -C "$FAKE_GITLAB_DIR/$repo.git" rev-parse -q --verify refs/heads/main 2>/dev/null)" \
      && printf '{"name":"main","commit":{"id":"%s"}}' "$sha" || printf '{"message":"404 Branch Not Found"}' ;;
  *"/repository/branches?per_page=100&page="*) page_answer heads ;;
  *"/repository/tags?per_page=100&page="*) page_answer tags ;;
  *) echo "test-d-delivery: the fake GitLab API has no answer for $url" >&2; exit 99 ;;
esac
MACHINE
chmod +x "$MACHINE_BIN/curl"
# The copy's unit on the fake machine. FAKE_MIRROR_FINAL=fail: the unit fails, as git refusing a push does. FAKE_MIRROR_NOCOPY=1: the unit exits 0 and pushes
# nothing. Otherwise the copy is mirror.sh's own push_repo (FAKE_MIRROR_SH), from a fresh mirror of each GitHub repository; only the fetch from GitHub is left out.
cat > "$MACHINE_BIN/systemctl" <<'MACHINE'
#!/bin/bash
[ "$1 $2" = "start vitana-mirror.service" ] || exit 0
[ "${FAKE_MIRROR_FINAL:-}" != fail ] || { echo "vitana-mirror.service: push all failed: vitana-platform" >&2; exit 1; }
[ "${FAKE_MIRROR_NOCOPY:-0}" != 1 ] || exit 0
GH=test-github-token GL=test-gitlab-token
. "$FAKE_MIRROR_SH" || exit 1
for r in vitana-platform vitana-v1; do
  rm -rf "$FX/cache/$r.git"; mkdir -p "$FX/cache"
  git clone -q --mirror "$FX_GH/$r.git" "$FX/cache/$r.git" || exit 1
  push_repo "$FX/cache/$r.git" "$FX_GL/$r.git" "$r" || exit 1
done
MACHINE
chmod +x "$MACHINE_BIN/systemctl"
export FAKE_MIRROR_SH="$MIRROR"
export PATH="$STUBS:$PATH" HOME="$T/home"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
unset AWS_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN GH_TOKEN GITHUB_TOKEN
unset CUTOVER_ROOT CUTOVER_STATE CUTOVER_MIRROR_WAIT_SECONDS

# ---- fixtures: a GitHub and a GitLab bare repository for each repo, main at the same commit on both; src holds the commits -----------------------
src_sha() { git -C "$FX/src/$1" rev-parse "$2"; }
cm() { git -C "$FX/src/$1" commit-tree "$(git -C "$FX/src/$1" rev-parse "$2^{tree}")" -p "$2" -m "$3"; }   # repo parent-sha message -> new commit
put() {   # gh|gl repo ref sha: sets a branch (or a refs/ name) of the local GitHub or GitLab repository. Fixture setup, not the code under test
  local side="$1" r="$2" ref="$3" sha="$4" dir
  if [ "$side" = gh ]; then dir="$FX_GH"; else dir="$FX_GL"; fi
  case "$ref" in refs/*) ;; *) ref="refs/heads/$ref" ;; esac
  git -C "$FX/src/$r" push -q -f "$dir/$r.git" "$sha:$ref"
}
bulk() {   # gh|gl repo prefix first last sha: creates the branches prefix001 .. prefix<last> at sha (fixture setup; many branches in one call)
  local side="$1" r="$2" prefix="$3" first="$4" last="$5" sha="$6" dir i
  if [ "$side" = gh ]; then dir="$FX_GH"; else dir="$FX_GL"; fi
  for ((i = first; i <= last; i++)); do printf 'create refs/heads/%s%03d %s\n' "$prefix" "$i" "$sha"; done | git -C "$dir/$r.git" update-ref --stdin
}
pad() { local s; printf -v s '%*s' "$1" ''; printf '%s' "${s// /$2}"; }   # pad N char -> N copies of char (fixture names)
fx_new() {   # a folder for the current case: GitHub and GitLab bare repositories with main at the same commit
  local r
  FX="$T/cases/$CASE"; rm -rf "$FX"; mkdir -p "$FX/github" "$FX/gitlab" "$FX/src" "$FX/tmp"
  export FX FX_GH="$FX/github" FX_GL="$FX/gitlab" FX_SSM_LOG="$FX/ssm.log" FX_GH_LOG="$FX/gh.log"
  : > "$FX_SSM_LOG"; : > "$FX_GH_LOG"; : > "$FX/ssm-bytes.txt"
  for r in vitana-platform vitana-v1; do
    git init -q --bare -b main "$FX_GH/$r.git"
    git init -q --bare -b main "$FX_GL/$r.git"
    git init -q -b main "$FX/src/$r"
    git -C "$FX/src/$r" commit -q --allow-empty -m "base of $r"
    git -C "$FX/src/$r" commit -q --allow-empty -m "main of $r"
    put gh "$r" main "$(src_sha "$r" main)"
    put gl "$r" main "$(src_sha "$r" main)"
  done
}
branch_fixture() {   # 100 branches equal on both sides (GitLab page 1), then three GitLab-only branches that sort after them (GitLab page 2)
  local sha; sha="$(src_sha vitana-platform main)"
  bulk gh vitana-platform feature/b 1 100 "$sha"
  bulk gl vitana-platform feature/b 1 103 "$sha"
}
mk_cache() { rm -rf "$FX/cache"; mkdir -p "$FX/cache"; git clone -q --mirror "$FX_GH/$1.git" "$FX/cache/$1.git"; }   # repo: the copy's cache, from GitHub
gl_ref() { git -C "$FX_GL/$1.git" rev-parse -q --verify "refs/heads/$2" 2>/dev/null || echo none; }   # repo branch -> GitLab head or none
gl_tag() { git -C "$FX_GL/$1.git" rev-parse -q --verify "refs/tags/$2" 2>/dev/null || echo none; }    # repo tag -> GitLab target or none

# ---- in-process fakes, installed over the transport functions after the script is sourced -----------------------------------------------------
fake_gh() {   # the GitHub API calls of the cut and the rollback: reads only, from the local GitHub repositories. Writes and unknown calls are logged
  local path="" r spec base head tab=$'\t'
  if [ "${1:-}" != api ]; then echo "UNEXPECTED gh $*" >> "$FX_GH_LOG"; return 1; fi
  shift; path="$1"; shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --paginate) shift ;;
      --jq) shift 2 ;;
      *) echo "UNEXPECTED gh api $path $*" >> "$FX_GH_LOG"; return 1 ;;
    esac
  done
  echo "read $path" >> "$FX_GH_LOG"
  r="$(cut -d/ -f3 <<<"$path")"
  case "$path" in
    repos/$GH_OWNER/*/branches/main/protection) echo "gh: Branch not protected (HTTP 404)" >&2; return 1 ;;
    repos/$GH_OWNER/*/branches/main) git -C "$FX_GH/$r.git" rev-parse -q --verify refs/heads/main 2>/dev/null || return 1 ;;
    repos/$GH_OWNER/*/branches)
      [ "${FAKE_GH_FAIL:-}" != list ] || return 1
      git -C "$FX_GH/$r.git" for-each-ref --format="%(refname:strip=2)${tab}%(objectname)" refs/heads/ ;;
    repos/$GH_OWNER/*/tags) [ "${FAKE_GH_FAIL:-}" != tags ] || return 1
      git -C "$FX_GH/$r.git" for-each-ref --format="%(refname:strip=2)${tab}%(objectname)" refs/tags/ ;;
    repos/$GH_OWNER/*/compare/*)
      spec="${path##*/compare/}"; base="${spec%...*}"; head="${spec##*...}"
      git -C "$FX_GH/$r.git" cat-file -e "$base^{commit}" 2>/dev/null && git -C "$FX_GH/$r.git" cat-file -e "$head^{commit}" 2>/dev/null || return 1
      if [ "$base" = "$head" ]; then echo identical
      elif git -C "$FX_GH/$r.git" merge-base --is-ancestor "$base" "$head"; then echo ahead
      elif git -C "$FX_GH/$r.git" merge-base --is-ancestor "$head" "$base"; then echo behind
      else echo diverged; fi ;;
    *) echo "UNEXPECTED gh api $path" >> "$FX_GH_LOG"; return 1 ;;
  esac
}
fake_ssm() {   # the Systems Manager call of the cut: nothing runs on a machine except the branch listing pages and the final copy, which run their real
  # script text under sh on the fake machine (its curl and systemctl answer from the local repositories). Every other read and write is answered here.
  # The first line of each script is logged, so a state-changing script shows up in the log ("vitana-cutover: write ...").
  local hdr full rc=0
  hdr="$(head -n 1 <<<"$1")"
  printf '%s\n' "$hdr" >> "$FX_SSM_LOG"
  SSM_CID=fake-command; SSM_ERR=""; SSM_STATUS=Success; SSM_OUT=""
  case "$hdr" in
    *"read gitlab-main"*|*"read gitlab-tags"*)
      local want=gitlab-main; case "$hdr" in *gitlab-tags*) want=gitlab-tags ;; esac
      if [ "${FAKE_SSM_FAIL:-}" = "$want" ]; then SSM_STATUS=Failed; SSM_ERR="fake failure"; return 1; fi
      full="$(PATH="$MACHINE_BIN:$PATH" FAKE_GITLAB_DIR="$FX_GL" FAKE_NO_XTOTAL="${FAKE_NO_XTOTAL:-0}" FAKE_XTOTAL_EXTRA="${FAKE_XTOTAL_EXTRA:-0}" \
        FAKE_PAGE_FAIL="${FAKE_PAGE_FAIL:-0}" FAKE_REPEAT_PAGE="${FAKE_REPEAT_PAGE:-0}" FAKE_XTOTAL_FROM="${FAKE_XTOTAL_FROM:-1}" sh -c "$1" 2>"$FX/tmp/machine.err")"; rc=$?
      printf '%s\n' "$(printf '%s' "$full" | wc -c)" >> "$FX/ssm-bytes.txt"   # the script's whole output, before Systems Manager's cut
      if [ "${FAKE_NO_COMPLETE:-0}" = 1 ]; then full="$(sed '/^listing=complete$/d' <<<"$full")"; fi
      SSM_OUT="$(head -c 24000 <<<"$full")"   # Systems Manager keeps only the first 24,000 characters of the output
      if [ "$rc" != 0 ]; then SSM_STATUS=Failed; SSM_ERR="$(tail -n 8 "$FX/tmp/machine.err")"; fi ;;
    *"read probe"*) SSM_OUT="$(printf 'marker=%s\nmirror_timer=%s' "${FAKE_MARKER:-none}" "${FAKE_MIRROR_TIMER:-enabled}")" ;;
    *"write mirror-final"*)   # the script's own exit status decides, as it does in Systems Manager
      full="$(PATH="$MACHINE_BIN:$PATH" FAKE_MIRROR_FINAL="${FAKE_MIRROR_FINAL:-}" FAKE_MIRROR_NOCOPY="${FAKE_MIRROR_NOCOPY:-0}" sh -c "$1" 2>"$FX/tmp/machine.err")"; rc=$?
      SSM_OUT="$full"; [ "$rc" = 0 ] || { SSM_STATUS=Failed; SSM_ERR="the script exited $rc"; } ;;
  esac
  [ "$SSM_STATUS" = Success ]
}
install_fakes() { ssm_run() { fake_ssm "$@"; }; x_gh() { fake_gh "$@"; }; }

invoke() {   # script dry-run snippet: in a subshell, sources the script, installs the fakes, sets DRY and runs the snippet there. Sets OUT and RC.
  local script="$1" dry="$2" snippet="$3"
  mkdir -p "$FX/tmp"
  OUT="$( (
    . "$script" || exit 99
    install_fakes
    DRY="$dry"; TMP="$FX/tmp"
    eval "$snippet"
  ) 2>&1 )"
  RC=$?
}
mirror_push() {   # the copy of the GitHub cache into the GitLab repository, through mirror.sh push_repo; GH and GL are stand-in tokens for scrub
  local GH=test-github-token GL=test-gitlab-token
  invoke "$MIRROR" 0 "push_repo '$FX/cache/$1.git' '$FX_GL/$1.git' $1"
}
rb_run() { CUTOVER_MIRROR_WAIT_SECONDS=0 invoke "$RB" 0 "$1"; }

# ---- assertions and the report -----------------------------------------------------------------------------------------------------------------
BAD=""; ID=""; CASE=""; WHAT=""; WANT=""; PASS=0; FAIL=0; WRITES_OK=0
begin() { ID="$1"; CASE="$2"; WHAT="$3"; WANT="$4"; BAD=""; WRITES_OK=0; STUB_BEFORE="$(wc -l < "$STUB_LOG" | tr -d ' ')"; }
need_rc() { [ "$RC" = "$WANT" ] || BAD="$BAD exit $RC, want $WANT;"; }
need_text() { grep -qF -- "$1" <<<"$OUT" || BAD="$BAD output lacks '$1';"; }
no_text() { grep -qF -- "$1" <<<"$OUT" && BAD="$BAD output has '$1';"; return 0; }
no_copy() { grep -q 'mirror-final' "$FX_SSM_LOG" && BAD="$BAD the copy was started;"; return 0; }
no_protection_read() { grep -q 'protection' "$FX_GH_LOG" && BAD="$BAD GitHub protection was read;"; return 0; }
end() {
  grep -q UNEXPECTED "${FX_GH_LOG:-/dev/null}" && BAD="$BAD an unexpected GitHub call;"
  [ "$(wc -l < "$STUB_LOG" | tr -d ' ')" = "${STUB_BEFORE:-0}" ] || BAD="$BAD a network-facing stub was called;"
  [ "${WRITES_OK:-0}" = 1 ] || { grep -q 'vitana-cutover: write' "${FX_SSM_LOG:-/dev/null}" && BAD="$BAD a state-changing script reached the fake;"; }
  local status
  if [ -z "$BAD" ]; then PASS=$((PASS + 1)); status=ok; else FAIL=$((FAIL + 1)); status="FAIL:$BAD"; fi
  printf '%-4s %-4s %-44s %s | %s\n' "$ID" "$RC" "$CASE" "$WHAT" "$status"
}

# ---- cases -------------------------------------------------------------------------------------------------------------------------------------
t_syntax() {
  begin s0 t_syntax "bash -n parses the cut, the rollback and mirror.sh" 0
  RC=0; local f; for f in "$CUT" "$RB" "$MIRROR"; do bash -n "$f" || RC=1; done
  need_rc; end
}
t_a_equal_mains_dry_run() {
  begin a t_a_equal_mains_dry_run "equal mains, no extra branch: step 1 and step 2 pass (dry run)" 0
  fx_new
  invoke "$CUT" 1 'MIRROR=mirror-test; step1 && step2'
  need_rc; no_text "CHANGE:"; end
}
t_b_gitlab_main_ahead_refused() {
  begin b t_b_gitlab_main_ahead_refused "GitLab main has a commit GitHub lacks: step 1 refuses, GitHub main is not restricted" 1
  fx_new
  put gl vitana-platform main "$(cm vitana-platform "$(src_sha vitana-platform main)" "gitlab main ahead")"
  invoke "$CUT" 1 'MIRROR=mirror-test; step1'
  need_rc; need_text "GitHub main is not restricted"; no_protection_read; end
}
t_b2_github_main_ahead_refused() {
  begin b2 t_b2_github_main_ahead_refused "GitHub main is ahead of GitLab main: step 1 refuses (both directions)" 1
  fx_new
  put gh vitana-platform main "$(cm vitana-platform "$(src_sha vitana-platform main)" "github main ahead")"
  invoke "$CUT" 1 'MIRROR=mirror-test; step1'
  need_rc; need_text "not the same commit"; no_protection_read; end
}
t_b3_github_main_missing_refused() {
  begin b3 t_b3_github_main_missing_refused "GitHub has no main: step 1 refuses" 1
  fx_new
  git -C "$FX_GH/vitana-platform.git" update-ref -d refs/heads/main
  invoke "$CUT" 1 'MIRROR=mirror-test; step1'
  need_rc; need_text "GitHub main of vitana-platform is unknown"; end
}
t_b4_gitlab_main_unreadable_refused() {
  begin b4 t_b4_gitlab_main_unreadable_refused "GitLab main cannot be read: step 1 refuses before it reads any GitHub protection" 1
  fx_new
  FAKE_SSM_FAIL=gitlab-main invoke "$CUT" 1 'MIRROR=mirror-test; step1'
  need_rc; need_text "GitLab main is unknown"; no_protection_read; end
}
t_b5_gitlab_main_none_refused() {
  begin b5 t_b5_gitlab_main_none_refused "GitLab has no main (none): step 1 refuses before it reads any GitHub protection" 1
  fx_new
  git -C "$FX_GL/vitana-platform.git" update-ref -d refs/heads/main
  invoke "$CUT" 1 'MIRROR=mirror-test; step1'
  need_rc; need_text "GitLab main is none"; no_protection_read; end
}
t_c_gitlab_only_branch_refused() {
  begin c t_c_gitlab_only_branch_refused "a branch exists only on GitLab: step 2 refuses before the copy" 1
  fx_new
  put gl vitana-platform feature/gl-only "$(cm vitana-platform "$(src_sha vitana-platform main)" "gitlab only")"
  invoke "$CUT" 0 'step2'
  need_rc; need_text "exists only on GitLab"; need_text "nothing is copied"; no_copy; end
}
t_c2_diverged_branch_refused() {
  begin c2 t_c2_diverged_branch_refused "a branch diverged on both sides: step 2 refuses before the copy" 1
  fx_new
  local base; base="$(src_sha vitana-platform main)"
  put gh vitana-platform feature/y "$(cm vitana-platform "$base" "github side")"
  put gl vitana-platform feature/y "$(cm vitana-platform "$base" "gitlab side")"
  invoke "$CUT" 0 'step2'
  need_rc; need_text "differs from GitHub's"; no_copy; end
}
t_c3_github_ahead_branch_refused() {
  begin c3 t_c3_github_ahead_branch_refused "GitHub is ahead of a GitLab branch (fast-forward): step 2 refuses (open point)" 1
  fx_new
  local base x y; base="$(src_sha vitana-platform main)"
  x="$(cm vitana-platform "$base" "shared")"; y="$(cm vitana-platform "$x" "github ahead")"
  put gl vitana-platform feature/ff "$x"; put gh vitana-platform feature/ff "$y"
  invoke "$CUT" 0 'step2'
  need_rc; need_text "differs from GitHub's"; no_copy; end
}
t_c4_gitlab_ahead_branch_refused() {
  begin c4 t_c4_gitlab_ahead_branch_refused "GitLab is ahead of a GitHub branch: step 2 refuses (the copy would rewind it)" 1
  fx_new
  local base x y; base="$(src_sha vitana-platform main)"
  x="$(cm vitana-platform "$base" "shared")"; y="$(cm vitana-platform "$x" "gitlab ahead")"
  put gh vitana-platform feature/rw "$x"; put gl vitana-platform feature/rw "$y"
  invoke "$CUT" 0 'step2'
  need_rc; need_text "differs from GitHub's"; no_copy; end
}
t_c5_gitlab_only_on_page5_refused() {
  begin c5 t_c5_gitlab_only_on_page5_refused "GitLab-only branch after the first 24,000 characters (page 5 of 5): step 2 reads every page and refuses it" 1
  fx_new
  local sha; sha="$(src_sha vitana-platform main)"
  bulk gh vitana-platform feature/a 1 420 "$sha"; bulk gl vitana-platform feature/a 1 420 "$sha"
  put gl vitana-platform zz/gitlab-only "$(cm vitana-platform "$sha" "gitlab only")"
  invoke "$CUT" 0 'step2'
  need_rc; need_text "zz/gitlab-only exists only on GitLab"; no_text "not read in full"; no_copy; end
}
t_c6_gitlab_unreadable_refused() {
  begin c6 t_c6_gitlab_unreadable_refused "the GitLab branch list cannot be read: step 2 refuses" 1
  fx_new
  FAKE_SSM_FAIL=gitlab-main invoke "$CUT" 0 'step2'
  need_rc; need_text "not read in full"; no_copy; end
}
t_c7_github_listing_failed_refused() {
  begin c7 t_c7_github_listing_failed_refused "GitHub does not list its branches: step 2 refuses" 1
  fx_new
  FAKE_GH_FAIL=list invoke "$CUT" 0 'step2'
  need_rc; need_text "GitHub did not list the branches"; no_copy; end
}
t_c8_gitlab_page1_failed_refused() {
  begin c8 t_c8_gitlab_page1_failed_refused "GitLab page 1 of the branches fails: step 2 refuses, nothing is copied" 1
  fx_new
  branch_fixture
  FAKE_PAGE_FAIL=1 invoke "$CUT" 0 'step2'
  need_rc; need_text "not read in full"; no_copy; end
}
t_c9_gitlab_page2_failed_refused() {
  begin c9 t_c9_gitlab_page2_failed_refused "GitLab page 2 fails (its branches are GitLab-only): step 2 refuses, the copy is not started" 1
  fx_new
  branch_fixture
  FAKE_PAGE_FAIL=2 invoke "$CUT" 0 'step2'
  need_rc; need_text "not read in full"; no_text "exists only on GitLab"; no_copy; end
}
t_c10_gitlab_page2_read_when_complete() {
  begin c10 t_c10_gitlab_page2_read_when_complete "control: with no failure page 2 is read, and its GitLab-only branch is refused" 1
  fx_new
  branch_fixture
  invoke "$CUT" 0 'step2'
  need_rc; need_text "vitana-platform feature/b103 exists only on GitLab"; no_copy; end
}
t_c11_gitlab_main_missing_refused() {
  begin c11 t_c11_gitlab_main_missing_refused "GitLab has no main: step 2 refuses before the copy" 1
  fx_new
  git -C "$FX_GL/vitana-platform.git" update-ref -d refs/heads/main
  invoke "$CUT" 0 'step2'
  need_rc; need_text "GitLab has no main"; no_copy; end
}
t_e_bot_refs_not_checked() {
  begin e t_e_bot_refs_not_checked "GitLab-only train/* and assist/* branches are left out of the check (dry run)" 0
  fx_new
  put gl vitana-platform train/1 "$(src_sha vitana-platform main)"
  put gl vitana-platform assist/42-rule "$(src_sha vitana-platform main)"
  invoke "$CUT" 1 'step2'
  need_rc; no_text "exists only on GitLab"; end
}
t_f_live_marker_refused() {
  begin f t_f_live_marker_refused "the cutover marker is live: step 2 refuses before the copy" 1
  fx_new
  FAKE_MARKER='{"mode":"live"}' invoke "$CUT" 0 'step2'
  need_rc; need_text "the cutover marker is set"; no_copy; end
}
t_g_github_only_branch_passes() {
  begin g t_g_github_only_branch_passes "a branch that exists only on GitHub is added by the copy, nothing is lost (dry run)" 0
  fx_new
  put gh vitana-platform feature/gh-only "$(src_sha vitana-platform main)"
  invoke "$CUT" 1 'step2'
  need_rc; end
}
t_h1_timer_disabled_not_done() {
  begin h1 t_h1_timer_disabled_not_done "copy timer stopped by hand, a GitLab-only branch: step 2 is not skipped and refuses" 1
  fx_new
  put gl vitana-platform feature/gl-only "$(cm vitana-platform "$(src_sha vitana-platform main)" "gitlab only")"
  FAKE_MIRROR_TIMER=disabled invoke "$CUT" 0 'step_done 2 || step2'
  need_rc; need_text "exists only on GitLab"; no_copy; end
}
t_h2_timer_disabled_equal_done() {
  begin h2 t_h2_timer_disabled_equal_done "copy timer stopped and every branch equal: step 2 counts as done" 0
  fx_new
  FAKE_MIRROR_TIMER=disabled invoke "$CUT" 0 'step_done 2'
  need_rc; end
}
t_h3_timer_enabled_not_done() {
  begin h3 t_h3_timer_enabled_not_done "copy timer still enabled: step 2 is not done (it must stop the timer)" 1
  fx_new
  invoke "$CUT" 0 'step_done 2'
  need_rc; end
}
t_h4_marker_live_done() {
  begin h4 t_h4_marker_live_done "cutover marker live and the copy timer stopped: step 2 counts as done, the GitLab-only branch is not checked again" 0
  fx_new
  put gl vitana-platform feature/gl-only "$(cm vitana-platform "$(src_sha vitana-platform main)" "gitlab only")"
  FAKE_MARKER='{"mode":"live"}' FAKE_MIRROR_TIMER=disabled invoke "$CUT" 0 'step_done 2'
  need_rc; end
}
t_h5_marker_live_timer_running_refused() {
  begin h5 t_h5_marker_live_timer_running_refused "cutover marker live but the copy timer still runs: step 2 is not done and refuses, the copy does not start" 1
  fx_new
  FAKE_MARKER='{"mode":"live"}' invoke "$CUT" 0 'step_done 2 || step2'
  need_rc; need_text "the cutover marker is set"; no_copy; end
}
t_h6_timer_stopped_github_only_branch_copied() {
  begin h6 t_h6_timer_stopped_github_only_branch_copied "copy timer stopped, a branch only on GitHub: step 2 is not done and the copy runs" 0
  fx_new
  WRITES_OK=1
  put gh vitana-platform feature/gh-only "$(src_sha vitana-platform main)"
  FAKE_MIRROR_TIMER=disabled invoke "$CUT" 0 'step_done 2; echo "step_done_exit=$?"; step2'
  need_rc; need_text "step_done_exit=1"; grep -q 'write mirror-final' "$FX_SSM_LOG" || BAD="$BAD the copy was not started;"; end
}
t_h7_timer_stopped_github_tag_copied() {
  begin h7 t_h7_timer_stopped_github_tag_copied "copy timer stopped, a tag on GitHub: step 2 is not done and the copy runs" 0
  fx_new
  WRITES_OK=1
  put gh vitana-platform refs/tags/v1 "$(src_sha vitana-platform main)"
  FAKE_MIRROR_TIMER=disabled invoke "$CUT" 0 'step_done 2; echo "step_done_exit=$?"; step2'
  need_rc; need_text "step_done_exit=1"; grep -q 'write mirror-final' "$FX_SSM_LOG" || BAD="$BAD the copy was not started;"; end
}
t_h8_timer_stopped_github_ahead_refused() {
  begin h8 t_h8_timer_stopped_github_ahead_refused "copy timer stopped, GitHub ahead of a GitLab branch: step 2 is not done and refuses (open point)" 1
  fx_new
  local base x y; base="$(src_sha vitana-platform main)"
  x="$(cm vitana-platform "$base" "shared")"; y="$(cm vitana-platform "$x" "github ahead")"
  put gl vitana-platform feature/ff "$x"; put gh vitana-platform feature/ff "$y"
  FAKE_MIRROR_TIMER=disabled invoke "$CUT" 0 'step_done 2 || step2'
  need_rc; need_text "differs from GitHub's"; no_copy; end
}
t_k1_three_pages_read_in_full() {
  begin k1 t_k1_three_pages_read_in_full "251 branches on GitLab: all three pages are read (one call each), GitLab-only branch on page 3 refused" 1
  fx_new
  local sha; sha="$(src_sha vitana-platform main)"
  bulk gh vitana-platform feature/b 1 249 "$sha"; bulk gl vitana-platform feature/b 1 250 "$sha"
  invoke "$CUT" 0 'step2'
  need_rc; need_text "vitana-platform feature/b250 exists only on GitLab"
  [ "$(grep -c 'read gitlab-main' "$FX_SSM_LOG")" = 3 ] || BAD="$BAD the listing was not read in three calls;"
  no_copy; end
}
t_k2_largest_page_under_24000_bytes() {
  begin k2 t_k2_largest_page_under_24000_bytes "100 branches with 181-character names: the largest listing page is under 24,000 bytes and the check passes (dry run)" 0
  fx_new
  local sha long max; sha="$(src_sha vitana-platform main)"; long="$(pad 120 x)/$(pad 56 y)/"
  bulk gh vitana-platform "$long" 1 100 "$sha"; bulk gl vitana-platform "$long" 1 100 "$sha"
  invoke "$CUT" 1 'step2'
  need_rc
  max="$(sort -n "$FX/ssm-bytes.txt" | tail -n 1)"
  [ "$max" -lt 24000 ] && [ "$max" -gt 20000 ] || BAD="$BAD the largest page is $max bytes, want 20000 to 24000;"
  end
}
t_k3_page_of_24000_bytes_refused() {
  begin k3 t_k3_page_of_24000_bytes_refused "100 branches with 245-character names: a page of 24,000 bytes or more is refused, nothing is copied" 1
  fx_new
  local sha long; sha="$(src_sha vitana-platform main)"; long="$(pad 150 x)/$(pad 90 y)/"
  bulk gh vitana-platform "$long" 1 100 "$sha"; bulk gl vitana-platform "$long" 1 100 "$sha"
  invoke "$CUT" 0 'step2'
  need_rc; need_text "not read in full"; need_text "24,000 bytes or more"; no_copy; end
}
t_k4_x_total_missing_refused() {
  begin k4 t_k4_x_total_missing_refused "GitLab's answer has no X-Total header: step 2 refuses, nothing is copied" 1
  fx_new
  branch_fixture
  FAKE_NO_XTOTAL=1 invoke "$CUT" 0 'step2'
  need_rc; need_text "not read in full"; need_text "has no X-Total header"; no_copy; end
}
t_k5_count_differs_from_x_total_refused() {
  begin k5 t_k5_count_differs_from_x_total_refused "X-Total is one more than the branches read: step 2 refuses, nothing is copied" 1
  fx_new
  branch_fixture
  FAKE_XTOTAL_EXTRA=1 invoke "$CUT" 0 'step2'
  need_rc; need_text "104 branches were read, GitLab counts 105"; no_copy; end
}
t_k6_repeated_page_refused() {
  begin k6 t_k6_repeated_page_refused "page 2 repeats page 1 and the count still matches X-Total: step 2 refuses the repeated branch" 1
  fx_new
  local sha; sha="$(src_sha vitana-platform main)"
  bulk gh vitana-platform feature/b 1 200 "$sha"; bulk gl vitana-platform feature/b 1 200 "$sha"
  FAKE_REPEAT_PAGE=2 invoke "$CUT" 0 'step2'
  need_rc; need_text "branch feature/b001 is listed twice"; no_copy; end
}
t_k7_completion_line_missing_refused() {
  begin k7 t_k7_completion_line_missing_refused "no listing=complete line on any page: step 2 refuses, nothing is copied" 1
  fx_new
  branch_fixture
  FAKE_NO_COMPLETE=1 invoke "$CUT" 0 'step2'
  need_rc; need_text "goes on past the 104 branches"; no_copy; end
}
t_k8_count_changes_between_pages_refused() {
  begin k8 t_k8_count_changes_between_pages_refused "X-Total rises by one from page 2 on: the count changed while it was read, step 2 refuses, nothing is copied" 1
  fx_new
  branch_fixture
  FAKE_XTOTAL_EXTRA=1 FAKE_XTOTAL_FROM=2 invoke "$CUT" 0 'step2'
  need_rc; need_text "the branch count changed while it was read (104, then 105)"; no_copy; end
}
t_m1_gitlab_only_branch_kept() {
  begin m1 t_m1_gitlab_only_branch_kept "mirror: a branch that exists only on GitLab is kept, and a GitHub branch is added" 0
  fx_new
  local base a z; base="$(src_sha vitana-platform main)"
  a="$(cm vitana-platform "$base" "github feature a")"; z="$(cm vitana-platform "$base" "gitlab only")"
  put gh vitana-platform feature/a "$a"; put gl vitana-platform feature/gl-only "$z"
  mk_cache vitana-platform
  mirror_push vitana-platform
  need_rc
  [ "$(gl_ref vitana-platform feature/gl-only)" = "$z" ] || BAD="$BAD the GitLab-only branch was moved or deleted;"
  [ "$(gl_ref vitana-platform feature/a)" = "$a" ] || BAD="$BAD the GitHub branch was not added;"
  end
}
t_m2_diverged_head_refused() {
  begin m2 t_m2_diverged_head_refused "mirror: a GitLab head that diverged from GitHub's is refused by git and kept" 1
  fx_new
  local base q p; base="$(src_sha vitana-platform main)"
  q="$(cm vitana-platform "$base" "github side")"; p="$(cm vitana-platform "$base" "gitlab side")"
  put gh vitana-platform feature/d "$q"; put gl vitana-platform feature/d "$p"
  mk_cache vitana-platform
  mirror_push vitana-platform
  need_rc; need_text "push all failed: vitana-platform"
  [ "$(gl_ref vitana-platform feature/d)" = "$p" ] || BAD="$BAD the diverged GitLab head was moved;"
  end
}
t_m3_differing_tag_refused() {
  begin m3 t_m3_differing_tag_refused "mirror: a GitLab tag that differs from GitHub's is kept and refused" 1
  fx_new
  local base c; base="$(src_sha vitana-platform main)"; c="$(cm vitana-platform "$base" "gitlab tag target")"
  put gh vitana-platform refs/tags/v1 "$base"; put gl vitana-platform refs/tags/v1 "$c"
  mk_cache vitana-platform
  mirror_push vitana-platform
  need_rc; need_text "push all failed: vitana-platform"; [ "$(gl_tag vitana-platform v1)" = "$c" ] || BAD="$BAD the GitLab tag was moved;"
  end
}
t_m4_github_ahead_head_moves() {
  begin m4 t_m4_github_ahead_head_moves "mirror: a GitLab head that GitHub is ahead of is moved forward" 0
  fx_new
  local base x y; base="$(src_sha vitana-platform main)"
  x="$(cm vitana-platform "$base" "shared")"; y="$(cm vitana-platform "$x" "github ahead")"
  put gl vitana-platform feature/ff "$x"; put gh vitana-platform feature/ff "$y"
  mk_cache vitana-platform
  mirror_push vitana-platform
  need_rc; [ "$(gl_ref vitana-platform feature/ff)" = "$y" ] || BAD="$BAD the fast-forward did not reach GitLab;"
  end
}
t_m5_gitlab_main_ahead_stops_push() {
  begin m5 t_m5_gitlab_main_ahead_stops_push "mirror: GitLab main is ahead, the main push is refused and nothing else is pushed" 1
  fx_new
  local base c; base="$(src_sha vitana-platform main)"; c="$(cm vitana-platform "$base" "gitlab main ahead")"
  put gl vitana-platform main "$c"; put gh vitana-platform feature/new "$base"
  mk_cache vitana-platform
  mirror_push vitana-platform
  need_rc; need_text "push main failed: vitana-platform"
  [ "$(gl_ref vitana-platform main)" = "$c" ] || BAD="$BAD GitLab main was moved;"
  [ "$(gl_ref vitana-platform feature/new)" = none ] || BAD="$BAD a branch was pushed after the main push failed;"
  end
}
t_m6_control_forced_prune_destroys_refs() {
  begin m6 t_m6_control_forced_prune_destroys_refs "control: the replaced command (+ and --prune) deletes a GitLab-only branch and rewinds a diverged head" 0
  fx_new
  local base q p z; base="$(src_sha vitana-platform main)"
  q="$(cm vitana-platform "$base" "github side")"; p="$(cm vitana-platform "$base" "gitlab side")"; z="$(cm vitana-platform "$base" "gitlab only")"
  put gh vitana-platform feature/d "$q"; put gl vitana-platform feature/d "$p"; put gl vitana-platform feature/gl-only "$z"
  mk_cache vitana-platform
  invoke /dev/null 0 "git -C '$FX/cache/vitana-platform.git' push -q --prune '$FX_GL/vitana-platform.git' '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*'"
  need_rc
  [ "$(gl_ref vitana-platform feature/gl-only)" = none ] || BAD="$BAD the old command did not prune the GitLab-only branch;"
  [ "$(gl_ref vitana-platform feature/d)" = "$q" ] || BAD="$BAD the old command did not rewind the diverged head;"
  end
}
t_m7_gitlab_head_ahead_refused() {
  begin m7 t_m7_gitlab_head_ahead_refused "mirror: a GitLab head ahead of GitHub's (not main) is refused by git and kept" 1
  fx_new
  local base p; base="$(src_sha vitana-platform main)"; p="$(cm vitana-platform "$base" "gitlab child")"
  put gh vitana-platform feature/ahead "$base"; put gl vitana-platform feature/ahead "$p"
  mk_cache vitana-platform
  mirror_push vitana-platform
  need_rc; need_text "push all failed: vitana-platform"
  [ "$(gl_ref vitana-platform feature/ahead)" = "$p" ] || BAD="$BAD the GitLab head was moved;"
  end
}
t_n1_failed_copy_stops_cut() {
  begin n1 t_n1_failed_copy_stops_cut "the final copy fails (mirror_exit=1): step 2 stops and does not stop the copy timer" 1
  fx_new
  WRITES_OK=1
  FAKE_MIRROR_FINAL=fail invoke "$CUT" 0 'step2'
  need_rc; need_text "Systems Manager status Failed"
  grep -q 'write mirror-final' "$FX_SSM_LOG" || BAD="$BAD the copy was not started;"
  grep -q 'write unit' "$FX_SSM_LOG" && BAD="$BAD a later step ran (the copy timer was stopped);"
  end
}

t_c12_gitlab_only_tag_refused() {
  begin c12 t_c12_gitlab_only_tag_refused "a tag exists only on GitLab: step 2 refuses before the copy" 1
  fx_new
  put gl vitana-platform refs/tags/v-gl-only "$(src_sha vitana-platform main)"
  invoke "$CUT" 0 'step2'
  need_rc; need_text "vitana-platform tag v-gl-only exists only on GitLab"; need_text "nothing is copied"; no_copy; end
}
t_c13_differing_tag_refused() {
  begin c13 t_c13_differing_tag_refused "a tag with another commit on GitLab than on GitHub: step 2 refuses before the copy" 1
  fx_new
  local base c; base="$(src_sha vitana-platform main)"; c="$(cm vitana-platform "$base" "gitlab tag target")"
  put gh vitana-platform refs/tags/v1 "$base"; put gl vitana-platform refs/tags/v1 "$c"
  invoke "$CUT" 0 'step2'
  need_rc; need_text "vitana-platform tag v1 differs from GitHub's"; no_copy; end
}
t_c14_gitlab_tags_unreadable_refused() {
  begin c14 t_c14_gitlab_tags_unreadable_refused "the GitLab tag list cannot be read: step 2 refuses before the copy" 1
  fx_new
  FAKE_SSM_FAIL=gitlab-tags invoke "$CUT" 0 'step2'
  need_rc; need_text "the tags of GitLab vitana-platform are not read in full"; no_copy; end
}
t_c15_github_tags_unlisted_refused() {
  begin c15 t_c15_github_tags_unlisted_refused "GitHub does not list its tags: step 2 refuses before the copy" 1
  fx_new
  FAKE_GH_FAIL=tags invoke "$CUT" 0 'step2'
  need_rc; need_text "GitHub did not list the tags of vitana-platform"; no_copy; end
}
t_n2_copy_leaves_branch_refused() {
  begin n2 t_n2_copy_leaves_branch_refused "the copy exits 0 but leaves a branch only GitHub has off GitLab: step 2 refuses after it, the copy timer keeps running" 1
  fx_new
  WRITES_OK=1
  put gh vitana-platform feature/left-behind "$(src_sha vitana-platform main)"
  FAKE_MIRROR_NOCOPY=1 invoke "$CUT" 0 'step2'
  need_rc; need_text "after the copy, vitana-platform still differs"; need_text "vitana-platform feature/left-behind exists only on GitHub"
  grep -q 'write mirror-final' "$FX_SSM_LOG" || BAD="$BAD the copy was not started;"
  grep -q 'write unit' "$FX_SSM_LOG" && BAD="$BAD the copy timer was stopped;"
  end
}
t_n3_copy_leaves_tag_refused() {
  begin n3 t_n3_copy_leaves_tag_refused "the copy exits 0 but leaves a GitHub tag off GitLab: step 2 refuses after it, the copy timer keeps running" 1
  fx_new
  WRITES_OK=1
  put gh vitana-platform refs/tags/v2 "$(src_sha vitana-platform main)"
  FAKE_MIRROR_NOCOPY=1 invoke "$CUT" 0 'step2'
  need_rc; need_text "after the copy, vitana-platform still differs"; need_text "vitana-platform tag v2 exists only on GitHub"
  grep -q 'write unit' "$FX_SSM_LOG" && BAD="$BAD the copy timer was stopped;"
  end
}

t_r1_gitlab_only_branch_refused_without_confirm() {
  begin r1 t_r1_gitlab_only_branch_refused_without_confirm "rollback: a GitLab-only branch without --confirm-prune-gitlab-only-branches: refused, nothing restarted" 1
  fx_new
  put gl vitana-platform feature/gl-only "$(cm vitana-platform "$(src_sha vitana-platform main)" "gitlab only")"
  rb_run 'CONFIRM_PRUNE=0; rb2'
  need_rc; need_text "exist only on GitLab"; end
}
t_r2_gitlab_commits_not_on_github_refused() {
  begin r2 t_r2_gitlab_commits_not_on_github_refused "rollback: a GitLab head with commits GitHub lacks: refused (they would stay on GitLab only)" 1
  fx_new
  local base x y; base="$(src_sha vitana-platform main)"
  x="$(cm vitana-platform "$base" "shared")"; y="$(cm vitana-platform "$x" "gitlab ahead")"
  put gh vitana-platform feature/rw "$x"; put gl vitana-platform feature/rw "$y"
  rb_run 'CONFIRM_PRUNE=0; rb2'
  need_rc; need_text "whose head differs from GitHub's"; end
}
t_r3_github_ahead_refused() {
  begin r3 t_r3_github_ahead_refused "rollback: a head that GitHub is ahead of is refused, as in the cut: the copy has to bring GitLab up to GitHub first" 1
  fx_new
  local base x y; base="$(src_sha vitana-platform main)"
  x="$(cm vitana-platform "$base" "shared")"; y="$(cm vitana-platform "$x" "github ahead")"
  put gl vitana-platform feature/ff "$x"; put gh vitana-platform feature/ff "$y"
  rb_run 'CONFIRM_PRUNE=0; rb2'
  need_rc; need_text "branches of vitana-platform whose head differs from GitHub's"; need_text "feature/ff(GitLab:"; need_text "Nothing is restored"; end
}
t_r4_main_not_equal_refused() {
  begin r4 t_r4_main_not_equal_refused "rollback: GitLab main is not GitHub main after the wait: refused, nothing restored" 1
  fx_new
  put gl vitana-platform main "$(cm vitana-platform "$(src_sha vitana-platform main)" "gitlab main ahead")"
  rb_run 'CONFIRM_PRUNE=0; rb2'
  need_rc; need_text "is not GitLab main"; end
}
t_r5_gitlab_page2_failed_refused() {
  begin r5 t_r5_gitlab_page2_failed_refused "rollback: GitLab page 2 of the branches fails: refused, nothing restored" 1
  fx_new
  branch_fixture
  FAKE_PAGE_FAIL=2 rb_run 'CONFIRM_PRUNE=0; rb2'
  need_rc; need_text "not read in full"; end
}
t_r6_rollback_count_differs_refused() {
  begin r6 t_r6_rollback_count_differs_refused "rollback: X-Total is one more than the branches read: refused, nothing restored" 1
  fx_new
  FAKE_XTOTAL_EXTRA=1 rb_run 'CONFIRM_PRUNE=0; rb2'
  need_rc; need_text "1 branches were read, GitLab counts 2"; end
}

t_r7_gitlab_only_tag_refused() {
  begin r7 t_r7_gitlab_only_tag_refused "rollback: a tag that exists only on GitLab: refused, nothing restored" 1
  fx_new
  put gl vitana-platform refs/tags/v9 "$(src_sha vitana-platform main)"
  rb_run 'CONFIRM_PRUNE=0; rb2'
  need_rc; need_text "tags that exist only on GitLab (vitana-platform): v9"; end
}
t_r8_differing_tag_refused() {
  begin r8 t_r8_differing_tag_refused "rollback: a tag with another commit on GitLab than on GitHub: refused, the output names it" 1
  fx_new
  local base c; base="$(src_sha vitana-platform main)"; c="$(cm vitana-platform "$base" "gitlab tag target")"
  put gh vitana-platform refs/tags/v1 "$base"; put gl vitana-platform refs/tags/v1 "$c"
  rb_run 'CONFIRM_PRUNE=0; rb2'
  need_rc; need_text "tags of vitana-platform whose commit differs from GitHub's"; need_text "v1(GitLab:"; end
}
t_r9_confirm_does_not_pass_gitlab_only_branch() {
  begin r9 t_r9_confirm_does_not_pass_gitlab_only_branch "rollback: --confirm-prune-gitlab-only-branches does not pass a GitLab-only branch: refused, nothing restored" 1
  fx_new
  put gl vitana-platform feature/gl-only "$(cm vitana-platform "$(src_sha vitana-platform main)" "gitlab only")"
  rb_run 'CONFIRM_PRUNE=1; rb2'
  need_rc; need_text "branches that exist only on GitLab (vitana-platform): feature/gl-only"; need_text "does not let them pass"; end
}
t_r10_confirm_does_not_pass_github_ahead() {
  begin r10 t_r10_confirm_does_not_pass_github_ahead "rollback: the flag does not pass a head GitHub is ahead of: refused" 1
  fx_new
  local base x y; base="$(src_sha vitana-platform main)"
  x="$(cm vitana-platform "$base" "shared")"; y="$(cm vitana-platform "$x" "github ahead")"
  put gl vitana-platform feature/ff "$x"; put gh vitana-platform feature/ff "$y"
  rb_run 'CONFIRM_PRUNE=1; rb2'
  need_rc; need_text "feature/ff(GitLab:"; end
}
t_r11_github_only_tag_passes() {
  begin r11 t_r11_github_only_tag_passes "rollback: a tag that exists only on GitHub is copied at step 6, so it is not refused" 0
  fx_new
  put gh vitana-platform refs/tags/v3 "$(src_sha vitana-platform main)"
  rb_run 'CONFIRM_PRUNE=0; rb2'
  need_rc; need_text "no branch or tag differs"; end
}

TESTS=(
  t_syntax t_a_equal_mains_dry_run t_b_gitlab_main_ahead_refused t_b2_github_main_ahead_refused t_b3_github_main_missing_refused
  t_b4_gitlab_main_unreadable_refused t_b5_gitlab_main_none_refused t_c_gitlab_only_branch_refused t_c2_diverged_branch_refused t_c3_github_ahead_branch_refused
  t_c4_gitlab_ahead_branch_refused t_c5_gitlab_only_on_page5_refused t_c6_gitlab_unreadable_refused t_c7_github_listing_failed_refused
  t_c8_gitlab_page1_failed_refused t_c9_gitlab_page2_failed_refused t_c10_gitlab_page2_read_when_complete t_c11_gitlab_main_missing_refused
  t_e_bot_refs_not_checked t_f_live_marker_refused t_g_github_only_branch_passes
  t_h1_timer_disabled_not_done t_h2_timer_disabled_equal_done t_h3_timer_enabled_not_done t_h4_marker_live_done
  t_h5_marker_live_timer_running_refused t_h6_timer_stopped_github_only_branch_copied t_h7_timer_stopped_github_tag_copied
  t_h8_timer_stopped_github_ahead_refused
  t_k1_three_pages_read_in_full t_k2_largest_page_under_24000_bytes t_k3_page_of_24000_bytes_refused t_k4_x_total_missing_refused
  t_k5_count_differs_from_x_total_refused t_k6_repeated_page_refused t_k7_completion_line_missing_refused t_k8_count_changes_between_pages_refused
  t_m1_gitlab_only_branch_kept t_m2_diverged_head_refused t_m3_differing_tag_refused t_m4_github_ahead_head_moves
  t_m5_gitlab_main_ahead_stops_push t_m6_control_forced_prune_destroys_refs t_m7_gitlab_head_ahead_refused
  t_c12_gitlab_only_tag_refused t_c13_differing_tag_refused t_c14_gitlab_tags_unreadable_refused t_c15_github_tags_unlisted_refused
  t_n1_failed_copy_stops_cut t_n2_copy_leaves_branch_refused t_n3_copy_leaves_tag_refused
  t_r1_gitlab_only_branch_refused_without_confirm t_r2_gitlab_commits_not_on_github_refused t_r3_github_ahead_refused
  t_r4_main_not_equal_refused t_r5_gitlab_page2_failed_refused t_r6_rollback_count_differs_refused
  t_r7_gitlab_only_tag_refused t_r8_differing_tag_refused t_r9_confirm_does_not_pass_gitlab_only_branch
  t_r10_confirm_does_not_pass_github_ahead t_r11_github_only_tag_passes
)
printf '%-4s %-4s %-44s %s\n' "id" "exit" "test" "what | result"
for t in "${TESTS[@]}"; do "$t"; done
STUB_CALLS="$(wc -l < "$STUB_LOG" | tr -d ' ')"
echo "stub calls recorded: $STUB_CALLS (must be 0)"
echo "passed: $PASS, failed: $FAIL"
if [ "$FAIL" = 0 ] && [ "$STUB_CALLS" = 0 ]; then rm -rf "$T"; exit 0; fi
echo "fixtures kept in $T" >&2
exit 1
