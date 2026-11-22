#!/bin/bash
# Isolated tests for the delivery safety checks (PR #5130, VTID-05545): the cut (delivery-cutover.sh), the rollback (delivery-rollback.sh) and the
# copy on the GitLab machine (infra/gitlab-engineering/host/mirror.sh).   bash scripts/eng/test-d-delivery/run.sh
# Nothing here reaches AWS, GitHub or GitLab. Every repository is a local bare repository under a temporary folder. Each network-facing command
# (aws, gh, curl, ssh, wget, ssm) is a stub first on PATH: it writes its call to a log and fails, and the log must stay empty. The cut and the
# rollback read GitHub and the GitLab machine through in-process fakes that answer from those local repositories. The GitHub fake refuses and logs
# any write. The machine fake logs every script, and the runner fails a case whose log shows a state-changing one. Exit: 0 when every case passes
# and no stub was called, 1 otherwise.
# This file never runs scripts/eng/delivery-cutover.test.mjs.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
CUT="$REPO/scripts/eng/delivery-cutover.sh"
RB="$REPO/scripts/eng/delivery-rollback.sh"
MIRROR="$REPO/infra/gitlab-engineering/host/mirror.sh"

T="$(mktemp -d "${TMPDIR:-/tmp}/test-d-delivery.XXXXXX")" || { echo "cannot make a temporary folder" >&2; exit 1; }
STUBS="$T/stubs"; STUB_LOG="$T/stub-calls.log"
mkdir -p "$STUBS" "$T/home"; : > "$STUB_LOG"
for c in aws gh curl ssh wget ssm; do
  cat > "$STUBS/$c" <<STUB
#!/bin/bash
echo "$c \$*" >> "$STUB_LOG"
echo "test-d-delivery: $c was called, but these tests must not reach AWS or the network" >&2
exit 99
STUB
  chmod +x "$STUBS/$c"
done
export PATH="$STUBS:$PATH" HOME="$T/home"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
unset AWS_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN GH_TOKEN GITHUB_TOKEN
unset CUTOVER_BRANCH_ALLOWLIST CUTOVER_ROOT CUTOVER_STATE CUTOVER_MIRROR_WAIT_SECONDS

# ---- fixtures: a GitHub and a GitLab bare repository for each repo, main at the same commit on both; src holds the commits -----------------------
src_sha() { git -C "$FX/src/$1" rev-parse "$2"; }
cm() { git -C "$FX/src/$1" commit-tree "$(git -C "$FX/src/$1" rev-parse "$2^{tree}")" -p "$2" -m "$3"; }   # repo parent-sha message -> new commit
put() {   # gh|gl repo ref sha: sets a branch (or a refs/ name) of the local GitHub or GitLab repository. Fixture setup, not the code under test
  local side="$1" r="$2" ref="$3" sha="$4" dir
  if [ "$side" = gh ]; then dir="$FX_GH"; else dir="$FX_GL"; fi
  case "$ref" in refs/*) ;; *) ref="refs/heads/$ref" ;; esac
  git -C "$FX/src/$r" push -q -f "$dir/$r.git" "$sha:$ref"
}
fx_new() {   # a folder for the current case: GitHub and GitLab bare repositories with main at the same commit
  local r
  FX="$T/cases/$CASE"; rm -rf "$FX"; mkdir -p "$FX/github" "$FX/gitlab" "$FX/src" "$FX/tmp"
  export FX FX_GH="$FX/github" FX_GL="$FX/gitlab" FX_SSM_LOG="$FX/ssm.log" FX_GH_LOG="$FX/gh.log"
  : > "$FX_SSM_LOG"; : > "$FX_GH_LOG"
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
fake_ssm() {   # the Systems Manager call of the cut: nothing runs on a machine. Reads come from the local GitLab repositories. The first line of
  # every script is logged, so a state-changing script shows up in the log ("vitana-cutover: write ...")
  local hdr repo main
  hdr="$(head -n 1 <<<"$1")"
  printf '%s\n' "$hdr" >> "$FX_SSM_LOG"
  repo="$(sed -n 's/^REPO=//p' <<<"$1" | head -n 1)"
  SSM_CID=fake-command; SSM_ERR=""; SSM_STATUS=Success; SSM_OUT=""
  case "$hdr" in
    *"read gitlab-main"*)
      if [ "${FAKE_SSM_FAIL:-}" = gitlab-main ]; then SSM_STATUS=Failed; SSM_ERR="fake failure"; return 1; fi
      main="$(git -C "$FX_GL/$repo.git" rev-parse -q --verify refs/heads/main 2>/dev/null)" || main=none
      SSM_OUT="$( printf 'main_sha=%s\ntruncated=%s\n' "${main:-none}" "${FAKE_TRUNCATED:-0}"
        git -C "$FX_GL/$repo.git" for-each-ref --format='branch=%(refname:strip=2) %(objectname)' refs/heads/ )" ;;
    *"read probe"*) SSM_OUT="marker=${FAKE_MARKER:-none}" ;;
    *"write mirror-final"*) SSM_OUT="mirror_exit=0" ;;
  esac
  return 0
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
mirror_push() { invoke "$MIRROR" 0 "push_repo '$FX/cache/$1.git' '$FX_GL/$1.git' $1"; }
rb_run() { CUTOVER_MIRROR_WAIT_SECONDS=0 invoke "$RB" 0 "$1"; }

# ---- assertions and the report -----------------------------------------------------------------------------------------------------------------
BAD=""; ID=""; CASE=""; WHAT=""; WANT=""; PASS=0; FAIL=0
begin() { ID="$1"; CASE="$2"; WHAT="$3"; WANT="$4"; BAD=""; }
need_rc() { [ "$RC" = "$WANT" ] || BAD="$BAD exit $RC, want $WANT;"; }
need_text() { grep -qF -- "$1" <<<"$OUT" || BAD="$BAD output lacks '$1';"; }
no_text() { grep -qF -- "$1" <<<"$OUT" && BAD="$BAD output has '$1';"; return 0; }
no_copy() { grep -q 'mirror-final' "$FX_SSM_LOG" && BAD="$BAD the copy was started;"; return 0; }
no_protection_read() { grep -q 'protection' "$FX_GH_LOG" && BAD="$BAD GitHub protection was read;"; return 0; }
end() {
  grep -q UNEXPECTED "${FX_GH_LOG:-/dev/null}" && BAD="$BAD an unexpected GitHub call;"
  grep -q 'vitana-cutover: write' "${FX_SSM_LOG:-/dev/null}" && BAD="$BAD a state-changing script reached the fake;"
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
t_c5_truncated_listing_refused() {
  begin c5 t_c5_truncated_listing_refused "GitLab lists more than 3000 branches: step 2 refuses" 1
  fx_new
  FAKE_TRUNCATED=1 invoke "$CUT" 0 'step2'
  need_rc; need_text "more than 3000"; no_copy; end
}
t_c6_gitlab_unreadable_refused() {
  begin c6 t_c6_gitlab_unreadable_refused "the GitLab branches cannot be read: step 2 refuses" 1
  fx_new
  FAKE_SSM_FAIL=gitlab-main invoke "$CUT" 0 'step2'
  need_rc; need_text "cannot be read"; no_copy; end
}
t_c7_github_listing_failed_refused() {
  begin c7 t_c7_github_listing_failed_refused "GitHub does not list its branches: step 2 refuses" 1
  fx_new
  FAKE_GH_FAIL=list invoke "$CUT" 0 'step2'
  need_rc; need_text "GitHub did not list the branches"; no_copy; end
}
t_d_allowlisted_gitlab_only_passes() {
  begin d t_d_allowlisted_gitlab_only_passes "a GitLab-only branch named in CUTOVER_BRANCH_ALLOWLIST is skipped (dry run)" 0
  fx_new
  put gl vitana-platform feature/gl-only "$(cm vitana-platform "$(src_sha vitana-platform main)" "gitlab only")"
  CUTOVER_BRANCH_ALLOWLIST="feature/gl-only" invoke "$CUT" 1 'step2'
  need_rc; need_text "skipped, it is on CUTOVER_BRANCH_ALLOWLIST"; end
}
t_d2_allowlisted_diverged_passes() {
  begin d2 t_d2_allowlisted_diverged_passes "a diverged branch named in CUTOVER_BRANCH_ALLOWLIST is skipped (dry run)" 0
  fx_new
  local base; base="$(src_sha vitana-platform main)"
  put gh vitana-platform feature/y "$(cm vitana-platform "$base" "github side")"
  put gl vitana-platform feature/y "$(cm vitana-platform "$base" "gitlab side")"
  CUTOVER_BRANCH_ALLOWLIST="feature/y" invoke "$CUT" 1 'step2'
  need_rc; need_text "skipped, it is on CUTOVER_BRANCH_ALLOWLIST"; end
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
  need_rc; need_text "whose GitLab commits GitHub does not have"; end
}
t_r3_github_ahead_allowed() {
  begin r3 t_r3_github_ahead_allowed "rollback: a head that GitHub is ahead of loses no commit, so the rollback goes on" 0
  fx_new
  local base x y; base="$(src_sha vitana-platform main)"
  x="$(cm vitana-platform "$base" "shared")"; y="$(cm vitana-platform "$x" "github ahead")"
  put gl vitana-platform feature/ff "$x"; put gh vitana-platform feature/ff "$y"
  rb_run 'CONFIRM_PRUNE=0; rb2'
  need_rc; need_text "no branch would lose a commit"; end
}
t_r4_main_not_equal_refused() {
  begin r4 t_r4_main_not_equal_refused "rollback: GitLab main is not GitHub main after the wait: refused, nothing restored" 1
  fx_new
  put gl vitana-platform main "$(cm vitana-platform "$(src_sha vitana-platform main)" "gitlab main ahead")"
  rb_run 'CONFIRM_PRUNE=0; rb2'
  need_rc; need_text "is not GitLab main"; end
}

TESTS=(
  t_syntax t_a_equal_mains_dry_run t_b_gitlab_main_ahead_refused t_b2_github_main_ahead_refused t_b3_github_main_missing_refused
  t_c_gitlab_only_branch_refused t_c2_diverged_branch_refused t_c3_github_ahead_branch_refused t_c4_gitlab_ahead_branch_refused
  t_c5_truncated_listing_refused t_c6_gitlab_unreadable_refused t_c7_github_listing_failed_refused t_d_allowlisted_gitlab_only_passes
  t_d2_allowlisted_diverged_passes t_e_bot_refs_not_checked t_f_live_marker_refused t_g_github_only_branch_passes
  t_m1_gitlab_only_branch_kept t_m2_diverged_head_refused t_m3_differing_tag_refused t_m4_github_ahead_head_moves
  t_m5_gitlab_main_ahead_stops_push t_m6_control_forced_prune_destroys_refs
  t_r1_gitlab_only_branch_refused_without_confirm t_r2_gitlab_commits_not_on_github_refused t_r3_github_ahead_allowed t_r4_main_not_equal_refused
)
printf '%-4s %-4s %-44s %s\n' "id" "exit" "test" "what | result"
for t in "${TESTS[@]}"; do "$t"; done
STUB_CALLS="$(wc -l < "$STUB_LOG" | tr -d ' ')"
echo "stub calls recorded: $STUB_CALLS (must be 0)"
echo "passed: $PASS, failed: $FAIL"
if [ "$FAIL" = 0 ] && [ "$STUB_CALLS" = 0 ]; then rm -rf "$T"; exit 0; fi
echo "fixtures kept in $T" >&2
exit 1
