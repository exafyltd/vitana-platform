#!/bin/bash
# The way back from the cut, within the 10 days (plan agentic-delivery §8.4, lane cutover, VTID-05545). The owner runs it in AWS CloudShell, in
# the same place and with the same rules as scripts/eng/delivery-cutover.sh, whose functions it uses (it sources that file; nothing runs on
# sourcing). It reverses §8.2 in the order of §8.4 and loses no commit:
#   1 stop landing on GitLab (the merge bot's timer)          2 check that GitHub main equals GitLab main (the push mirror copied it), that no
#   every branch and tag is the same on both hosts: none exists only on GitLab, and none on both hosts has another commit, GitHub ahead included (the
#   bot refs train/* and assist/* on GitLab are left out). A ref that exists only on GitHub is copied at step 6
#   3 restore the GitHub protection of main from the copy saved by the cut, only while main is still the cut's lock
#   4 enable again the workflows the cut disabled (exactly those, and only those still disabled_manually)   5 stop the bridge   6 start the GitHub-to-GitLab copy again
#   7 remove the cutover marker and run the settings sync (both projects are mirror projects again, the push mirror is gone)   8 start the merge bot again
#   9 delete the tags delivery/cutover-<repo> (GitHub and GitLab)   10 tell the owner to lift the Dev Autopilot pause   11 redeploy the staging gateway
#   through the GitHub path when it still carries the cut settings, wait for the run and read the task definition again.
# It records "rolling-back" in $SECRET_PREFIX/state before its first change (apply refuses to resume such a cut) and "rolled-back" at the end,
# and holds the lock of delivery-cutover.sh while it runs.
# Open PRs never left GitHub, so nothing is reopened. Every state-changing call is printed first ("CHANGE: ..."); without the plan slug, or with
# --dry-run, it prints "WOULD: ..." and changes nothing. A step that is already undone is skipped, so the command can be run again after a stop.
#
#   bash scripts/eng/delivery-rollback.sh [agentic-delivery] [--dry-run] [--confirm-prune-gitlab-only-branches] [--break-lock]
# Exit: 0 done, 1 a refusal or a failure, 2 a usage mistake.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/eng/delivery-cutover.sh
. "$HERE/delivery-cutover.sh"

rb_usage() {
  cat <<'USAGE'
usage: bash scripts/eng/delivery-rollback.sh [agentic-delivery] [--dry-run] [--confirm-prune-gitlab-only-branches] [--break-lock]
  Reverses the cut (plan section 8.4). Give the plan slug to make the changes; without it (or with --dry-run) nothing is changed.
  --confirm-prune-gitlab-only-branches   accepted for old command lines and changes nothing: a branch or tag that exists only on GitLab, or differs from GitHub's, is refused.
  --break-lock                           clear a lock left by a run that died, when it is older than 6 hours.
USAGE
}

# rb_branch_check and rb2 use the comparison of the cut (refs_read and ref_diffs in delivery-cutover.sh). A branch or tag on both hosts whose commit
# differs is refused, GitHub ahead included, and so is a branch or tag that exists only on GitLab. A ref that exists only on GitHub is copied at
# step 6, so it is not refused. The bot refs train/* and assist/* on GitLab are left out, as in the cut.
rb_branch_check() {   # repo: sets RB_ONLY_B and RB_ONLY_T (branch and tag names that exist only on GitLab), RB_RISK_B and RB_RISK_T (names on both hosts
  # whose commit differs, as name(GitLab:<head>,GitHub:<head>)); 1 when a listing is not read in full (REF_ERR says why)
  local r="$1" kind name detail
  RB_ONLY_B=""; RB_ONLY_T=""; RB_RISK_B=""; RB_RISK_T=""
  refs_read "$r" || { say "  $REF_ERR: nothing is restored"; return 1; }
  ref_diffs
  while IFS=$'\t' read -r kind name detail; do
    [ -n "$kind" ] || continue
    case "$detail" in
      "exists only on GitHub") ;;
      "exists only on GitLab") if [ "$kind" = branch ]; then RB_ONLY_B="$RB_ONLY_B $name"; else RB_ONLY_T="$RB_ONLY_T $name"; fi ;;
      *) if [ "$kind" = branch ]; then RB_RISK_B="$RB_RISK_B $name($detail)"; else RB_RISK_T="$RB_RISK_T $name($detail)"; fi ;;
    esac
  done <<<"$REF_DIFFS"
  return 0
}

rb_step_title() { case "$1" in
  1) echo "stop landing on GitLab" ;;
  2) echo "check that GitHub main equals GitLab main and that no commit or branch would be lost" ;;
  3) echo "restore the GitHub protection of main" ;;
  4) echo "enable the GitHub workflows the cut disabled" ;;
  5) echo "stop the bridge" ;;
  6) echo "restart the GitHub-to-GitLab copy" ;;
  7) echo "remove the cutover marker and run the settings sync" ;;
  8) echo "start the merge bot again" ;;
  9) echo "delete the tags delivery/cutover-<repo>" ;;
  10) echo "the Dev Autopilot pause" ;;
  11) echo "the staging gateway returns to the GitHub path" ;;
esac; }

rb1() { W "stop the merge bot (systemctl stop vitana-land.timer vitana-land.service on the GitLab machine)" ssm_w "$(r_unit stop vitana-land.timer vitana-land.service)"; }
rb2() {
  local r gh gl waited only refused=0
  for r in "${REPOS[@]}"; do
    waited=0
    while :; do
      gh="$(main_sha "$r")"; ssm_run "$(r_gitlab_main "$r")" 30; gl="$(kv main_sha)"
      [ -n "$gh" ] && [ "$gh" = "$gl" ] && break
      [ "$DRY" = 1 ] && { say "  (dry run) GitHub main of $r is ${gh:0:12}, GitLab main is ${gl:0:12}"; break; }
      [ "$waited" -ge "${CUTOVER_MIRROR_WAIT_SECONDS:-600}" ] && { say "  GitHub main of $r (${gh:0:12}) is not GitLab main (${gl:0:12}) after $waited s: the push mirror has not copied it. Nothing is restored; look at the mirror of vitana/$r (Settings, Repository, Mirroring repositories), then run this again"; return 1; }
      x_sleep 30; waited=$((waited + 30))
    done
    rb_branch_check "$r" || return 1
    if [ -n "$RB_RISK_B$RB_RISK_T" ]; then
      [ -z "$RB_RISK_B" ] || say "  branches of $r whose head differs from GitHub's (GitHub is ahead, or the two diverged):${RB_RISK_B}"
      [ -z "$RB_RISK_T" ] || say "  tags of $r whose commit differs from GitHub's:${RB_RISK_T}"
      say "  Make each one equal first. When GitHub is ahead, run the GitHub-to-GitLab copy (systemctl start vitana-mirror.service on the GitLab machine, after the mirror.sh install); otherwise push the GitLab commits to GitHub, or merge GitHub's head into the GitLab branch and push it. Then run this again. Nothing is restored"
      refused=1; [ "$DRY" = 1 ] || return 1
    fi
    if [ -n "$RB_ONLY_B$RB_ONLY_T" ]; then
      [ -z "$RB_ONLY_B" ] || say "  branches that exist only on GitLab ($r):${RB_ONLY_B}"
      [ -z "$RB_ONLY_T" ] || say "  tags that exist only on GitLab ($r):${RB_ONLY_T}"
      say "  GitHub does not have them. Push them to GitHub, or delete them on GitLab, then run this again. Nothing is restored"
      [ "$CONFIRM_PRUNE" != 1 ] || say "  --confirm-prune-gitlab-only-branches does not let them pass: it changes nothing"
      refused=1; [ "$DRY" = 1 ] || return 1
    fi
  done
  [ "$refused" = 1 ] || say "  GitHub main equals GitLab main in both repositories, and no branch or tag differs between the hosts (a ref only on GitHub is copied at step 6)"
}
rb3() {   # only while main is still the cut's lock (restricted to the recorded mirror account): a second rollback, or a protection changed since, is left alone
  local r rc
  for r in "${REPOS[@]}"; do
    gh_protection "$r"; rc=$?
    if [ "$rc" = 1 ]; then say "  GitHub did not answer for the protection of main of $r ($GH_ERR): nothing is restored; run this again"; return 1; fi
    if [ -z "$CUT_MIRROR" ]; then
      if [ "$rc" = 0 ] && looks_like_a_lock "$PROT_JSON"; then say "  GitHub main of $r is restricted to one account, but no cut (and no mirror account) is recorded in $SECRET_PREFIX/state: it is not restored by this script"; protection_manual "$r"; return 1; fi
      say "  $r: no cut is recorded and GitHub main is not locked: left as it is"; continue
    fi
    if [ "$rc" = 0 ] && is_cut_lock "$PROT_JSON" "$CUT_MIRROR"; then
      W "restore the protection of GitHub main of $r from $SECRET_PREFIX/protection-$r" restore_protection "$r" || return 1
    else
      say "  $r: GitHub main is not restricted to $CUT_MIRROR any more (restored already, or changed since): left as it is"
    fi
  done
}
rb4() {   # only the workflows the cut saved, and only those that are still disabled_manually; nothing after a finished rollback
  local r f list out st rc disabled
  for r in "${REPOS[@]}"; do
    if [ "$RB_START_PHASE" = rolled-back ]; then say "  $r: an earlier rollback finished: the workflows are left as they are"; continue; fi
    out="$(gh_workflows "$r")"
    [ -n "$out" ] || { say "  GitHub listed no workflow of $r: nothing is enabled; run this again"; return 1; }
    secret_read "$SECRET_PREFIX/workflows-$r"; rc=$?
    if [ "$rc" = 1 ]; then say "  the saved list $SECRET_PREFIX/workflows-$r cannot be read ($SM_ERR): nothing is enabled"; return 1; fi
    if [ "$rc" = 2 ]; then
      disabled=""; for f in $(wf_names "$r" disable); do [ "$(wf_state "$out" "$f")" = disabled_manually ] && disabled="$disabled $f"; done
      if [ -z "$disabled" ]; then say "  $r: no saved list of disabled workflows, and no workflow of the disable list is disabled: nothing to enable"; continue; fi
      say "  $r: no saved list of disabled workflows ($SECRET_PREFIX/workflows-$r does not exist), but these workflows of the disable list are disabled:${disabled}"
      say "  MANUAL (owner): enable the ones the cut disabled (gh workflow enable <file> -R $GH_OWNER/$r); a workflow disabled before the cut stays disabled"
      return 1
    fi
    list="$SECRET_VAL"
    jq -e 'type == "array"' <<<"$list" >/dev/null 2>&1 || { say "  the saved list $SECRET_PREFIX/workflows-$r does not parse: nothing is enabled"; return 1; }
    for f in $(jq -r '.[]' <<<"$list"); do
      st="$(wf_state "$out" "$f")"
      case "$st" in
        disabled_manually) W "PUT repos/$GH_OWNER/$r/actions/workflows/$f/enable" gh_workflow "$r" "$f" enable || return 1 ;;
        active) ;;
        *) say "  $r/$f is ${st:-not on GitHub}: left as it is" ;;
      esac
    done
  done
}
rb5() { W "stop the bridge (systemctl disable --now vitana-github-bridge.timer)" ssm_w "$(r_unit disable-now vitana-github-bridge.timer)"; }
rb6() { W "start the GitHub-to-GitLab copy again (systemctl enable --now vitana-mirror.timer)" ssm_w "$(r_unit enable-now vitana-mirror.timer)"; }
rb7() {
  local ok=0
  W "remove $MARKER_FILE on the GitLab machine and run the settings sync (both projects become mirror projects again; the push mirror to GitHub, assist/* and landing are removed; DELIVERY_MODE=shadow)" ssm_w "$(r_converge none)" 100 || ok=1
  if [ "$DRY" != 1 ] && { [ "$ok" = 1 ] || [ "$(kv settings_exit)" != 0 ] || [ "$(kv check_exit)" != 0 ]; }; then say "  the settings sync did not converge (sync exit $(kv settings_exit), check exit $(kv check_exit)); run  bash m2.sh settings  and read its log"; return 1; fi
}
rb8() { W "start the merge bot again (systemctl start vitana-land.timer): it lands on the rehearsal project only" ssm_w "$(r_unit start vitana-land.timer)"; }
rb9() {
  local r
  for r in "${REPOS[@]}"; do
    if x_gh api "repos/$GH_OWNER/$r/git/ref/tags/delivery/cutover-$r" >/dev/null 2>&1; then W "delete the tag delivery/cutover-$r on GitHub" gh_tag_delete "$r" || return 1; fi
    W "delete the tag delivery/cutover-$r on GitLab if it exists" ssm_w "$(r_tag_delete "$r")" 30 || return 1
  done
}
rb10() {
  if kill_switch_on; then say "  OWNER ACTION (production control): the Dev Autopilot kill switch is ON. Switch it off in the Command Hub when you want Dev Autopilot to run again (plan 8.4: lift the pause)."; else say "  the Dev Autopilot kill switch is off"; fi
}
rb11() {
  staging_read || { say "  the task definition of the staging gateway could not be read ($STAGING_CLUSTER/$STAGING_SERVICE): run this again"; return 1; }
  if staging_carries_cut; then
    W "dispatch AWS-STAGE-DEPLOY-GATEWAY.yml on main so that the staging gateway loses the cut settings (PM_AGENT_ENABLED=false, DELIVERY_HOST_*=gitlab), wait for the run and read the task definition again" rb11_redeploy || return 1
  else
    say "  the staging gateway carries no cut setting (no DELIVERY_HOST_* is gitlab on $STAGING_TD): nothing to redeploy"
  fi
}
rb11_redeploy() { dispatch_and_wait vitana-platform AWS-STAGE-DEPLOY-GATEWAY.yml && staging_gateway_check; }

RB_START_PHASE=none; RB_ONLY_B=""; RB_ONLY_T=""; RB_RISK_B=""; RB_RISK_T=""
rb_main() {
  local slug="" n rc
  DRY=1; CONFIRM_PRUNE=0; local forced=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) forced=1 ;;
      --break-lock) BREAK_LOCK=1 ;;
      --confirm-prune-gitlab-only-branches) CONFIRM_PRUNE=1 ;;
      -h|--help) rb_usage; exit 0 ;;
      -*) rb_usage >&2; exit 2 ;;
      *) [ -z "$slug" ] || { rb_usage >&2; exit 2; }; slug="$1" ;;
    esac
    shift
  done
  if [ -n "$slug" ] && [ "$slug" != "$PLAN_SLUG" ]; then printf 'ERROR: the plan slug is %s (you gave %s): nothing was done\n' "$PLAN_SLUG" "$slug" >&2; exit 2; fi
  if [ "$slug" = "$PLAN_SLUG" ] && [ "$forced" != 1 ]; then DRY=0; fi
  if [ "$DRY" = 1 ]; then say "rollback: DRY RUN: nothing will be changed ($([ "$forced" = 1 ] && echo '--dry-run' || echo "no plan slug given: give $PLAN_SLUG to make the changes"))"; fi
  need aws git jq node gh
  connect_aws; connect_github
  cut_state_read || { say "rollback: the record $SECRET_PREFIX/state cannot be read ($SM_ERR): nothing was changed. Run this again."; exit 1; }
  RB_START_PHASE="$CUT_PHASE"
  case "$CUT_PHASE" in
    none|rolled-back) say "rollback: no cut is recorded in $SECRET_PREFIX/state (phase $CUT_PHASE); the steps below look at the world and skip what is already undone" ;;
    rolling-back) say "rollback: an earlier rollback started at $CUT_AT and did not finish: it is continued" ;;
  esac
  W "take the lock $LOCK_NAME (no apply, rehearse or other rollback can run while this one does)" lock_take rollback || { say "rollback: nothing was changed."; exit 1; }
  W "record in $SECRET_PREFIX/state that a rollback is under way (rolling-back: apply refuses to resume the cut from now on), and read it back" cut_state_put rolling-back "$CUT_MIRROR" \
    || { say "rollback: the record could not be written, so nothing is changed."; exit 1; }
  for n in 1 2 3 4 5 6 7 8 9 10 11; do
    say "== ROLLBACK STEP $n of 11: $(rb_step_title "$n")"
    "rb$n"; rc=$?
    if [ "$rc" != 0 ]; then
      say "rollback: STOPPED at step $n (exit $rc). Steps before it are undone and step $n changed nothing that is left half-done. Run the same command again to continue."
      exit "$rc"
    fi
  done
  if [ "$DRY" = 1 ]; then say "rollback: dry run finished, nothing was changed"; else W "record in $SECRET_PREFIX/state that the cut is rolled back" cut_state_put rolled-back "$CUT_MIRROR" || { say "rollback: every step is undone, but $SECRET_PREFIX/state could not be written: run this again"; exit 1; }; say "rollback: done. GitHub is the home of main again; check with  bash scripts/eng/delivery-cutover.sh status  that the checklist is as before."; fi
}
if [ "${BASH_SOURCE[0]}" = "$0" ]; then rb_main "$@"; fi
