#!/usr/bin/env bash
# Mutation check for the tests of lane cutover (VTID-05545, plan agentic-delivery §8). One plan value or one behaviour of the cutover is
# broken at a time in a scratch copy of the tree, and the test of that value must go red on a NAMED case. A mutation counts as caught only when
#   - the mutated file still parses as what it is (bash -n, node --check, JSON.parse), and
#   - the test file reports a failing case (a crash before any case runs is CRASH, not a catch).
# The failing case should be the one the mutation is aimed at (the pattern after the test file name); if only another case notices it, the
# line says "(other case)". A mutation that changes nothing (NOOP), breaks the syntax by accident (INVALID), or leaves every case of the
# test file green (SURVIVED) is reported as not caught. To save time the aimed case runs first (--test-name-pattern); only when it stays
# green is the whole test file run, so a survivor is a mutation that no case of the file notices.
#
# usage: mutate-cutover.sh <worktree of lane cutover>
# env:   TMPDIR  where the scratch copies go (default /tmp)      JOBS  parallel mutations (default 6)
#        ONLY    regex on the mutation name: run a subset        DRY=1  only apply and parse the mutations (no test run)
set -u
SRC="${1:?worktree}"
JOBS="${JOBS:-6}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mutcut-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
ENG=scripts/eng

mk_tree() {   # dir: the files the five test files read, as copies
  local t="$1"
  mkdir -p "$t/scripts" "$t/infra/gitlab-engineering" "$t/.github"
  cp -r "$SRC/scripts/eng" "$SRC/scripts/collab" "$t/scripts/"
  cp -r "$SRC/infra/gitlab-engineering/settings" "$SRC/infra/gitlab-engineering/RUNBOOK-cutover.md" "$t/infra/gitlab-engineering/"
  cp -r "$SRC/.github/workflows" "$t/.github/"
  mkdir -p "$t/.kiro" && cp -r "$SRC/.kiro/pipeline" "$t/.kiro/"
  [ -d "$SRC/config" ] && cp -r "$SRC/config" "$t/"
  return 0
}
parses() {   # file -> 0 when it still parses as its extension says
  case "$1" in
    *.sh)   bash -n "$1" 2>/dev/null ;;
    *.mjs)  node --check "$1" 2>/dev/null ;;
    *.json) node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$1" 2>/dev/null ;;
    *)      return 0 ;;
  esac
}

# The unmutated tree must pass, or every "caught" below would be meaningless.
if [ "${DRY:-0}" != 1 ] && [ "${SKIP_BASELINE:-0}" != 1 ]; then
  mk_tree "$WORK/base"
  for f in gitlab-settings-cutover github-workflows delivery-metrics parity-report delivery-cutover; do
    ( cd "$WORK/base" && node --test "$ENG/$f.test.mjs" > "$WORK/base-$f.out" 2>&1 ) &
  done
  wait
  line="baseline:"
  for f in gitlab-settings-cutover github-workflows delivery-metrics parity-report delivery-cutover; do
    o="$WORK/base-$f.out"
    if ! grep -q '^# fail 0' "$o" || grep -q '^# tests 0' "$o"; then echo "baseline: $f fails on the unmutated tree"; grep -E '^not ok' "$o" | head -3; exit 2; fi
    line="$line $f $(grep -E '^# pass ' "$o" | cut -c3-)/$(grep -E '^# tests ' "$o" | cut -c3-);"
  done
  echo "$line"
fi

n=0
mut() {   # name, file (relative to the tree), perl expression, test file (in scripts/eng), regex of the aimed case
  local name="$1" file="$2" expr="$3" tf="$4" pat="$5"
  if [ -n "${ONLY:-}" ] && ! [[ "$name" =~ $ONLY ]]; then return; fi
  n=$((n + 1)); local id; id="$(printf '%03d' "$n")"
  (
    local t="$WORK/m$id" out="$WORK/r$id.txt"
    mk_tree "$t"
    local f="$t/$file" before after
    before="$(sha256sum "$f" | cut -c1-16)"
    perl -0pi -e "$expr" "$f"
    after="$(sha256sum "$f" | cut -c1-16)"
    if [ "$before" = "$after" ]; then echo "NOOP        $name (the mutation changed nothing: fix the mutation)" > "$out"; exit 0; fi
    if ! parses "$f"; then echo "INVALID     $name (the mutated file does not parse: it proves nothing)" > "$out"; exit 0; fi
    if [ "${DRY:-0}" = 1 ]; then echo "applied     $name" > "$out"; exit 0; fi
    local o rc failed other="" ntests
    o="$(cd "$t" && timeout 300 node --test --test-name-pattern="$pat" "$ENG/$tf" 2>&1)"; rc=$?
    ntests="$(grep -E '^# tests ' <<<"$o" | awk '{print $3}')"
    if [ "$rc" = 124 ]; then echo "HUNG        $name" > "$out"; exit 0; fi
    if [ "$rc" = 0 ]; then   # the aimed case stayed green: does any case of the file notice?
      o="$(cd "$t" && timeout 600 node --test "$ENG/$tf" 2>&1)"; rc=$?; other=" (other case)"
      ntests="$(grep -E '^# tests ' <<<"$o" | awk '{print $3}')"
    fi
    failed="$(grep -E '^not ok' <<<"$o" | sed -E 's/^not ok [0-9]+ - //' | cut -c1-70 | head -2 | paste -sd'|' -)"
    if [ "$rc" = 0 ]; then echo "SURVIVED    $name (all $ntests cases of $tf stay green)" > "$out"
    elif [ -z "$failed" ]; then echo "CRASH       $name (the test file failed without a failing case: $(grep -m1 -E 'Error|error' <<<"$o" | cut -c1-80))" > "$out"
    else echo "caught      $name  <- $failed$other" > "$out"; fi
  ) &
  while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do wait -n; done
}

# ── settings file: the cutover values of plan §8.2 step 3 ─────────────────────────────────────────────────────────────────────────
S=infra/gitlab-engineering/settings/gitlab-settings.json
T=gitlab-settings-cutover.test.mjs
CFG='config: the shipped file has a cutover block'
mut "json: live required jobs lose gate"                $S 's#"required_jobs": \["lane-scope", "change-suite", "gate"\]#"required_jobs": ["lane-scope", "change-suite"]#' $T "$CFG"
mut "json: live webhook loses tag_push"                 $S 's#"push", "tag_push"\]#"push"]#' $T "$CFG"
mut "json: push mirror sends every branch"              $S 's#"only_protected_branches": true#"only_protected_branches": false#' $T "$CFG|every invalid"
mut "json: push mirror overwrites divergent refs"       $S 's#"keep_divergent_refs": true#"keep_divergent_refs": false#' $T "$CFG|every invalid"
mut "json: assist/* pushed by developers"               $S 's#"name": "assist/\*", "push": 40#"name": "assist/*", "push": 30#' $T "$CFG"
mut "json: assist/* merged by developers"               $S 's#"name": "assist/\*", "push": 40, "merge": 40#"name": "assist/*", "push": 40, "merge": 30#' $T "$CFG"
mut "json: skipped pipelines no longer count"           $S 's#"allow_merge_on_skipped_pipeline": true#"allow_merge_on_skipped_pipeline": false#' $T "$CFG"
mut "json: the bridge is a Maintainer when live"        $S 's#"live_role": "developer"#"live_role": "maintainer"#' $T "$CFG"
mut "json: the bridge is a Developer in shadow"         $S 's#"shadow_role": "reporter"#"shadow_role": "developer"#' $T "$CFG"
mut "json: the bridge loses write_repository"           $S 's#("username": "bot-bridge".*?"scopes": \[)"api", "write_repository"\]#$1"api"]#s' $T "$CFG"
mut "json: the old mirror user stays Maintainer live"   $S 's#"mirror_user_role": "reporter"#"mirror_user_role": "maintainer"#' $T "$CFG"
mut "json: the old mirror user is Reporter in shadow"   $S 's#"shadow": \{ "webhook_events": \["merge_request", "pipeline"\], "mirror_user_role": "maintainer"#"shadow": { "webhook_events": ["merge_request", "pipeline"], "mirror_user_role": "reporter"#' $T "$CFG"
mut "json: shadow sends no pipeline events"             $S 's#"shadow": \{ "webhook_events": \["merge_request", "pipeline"\]#"shadow": { "webhook_events": ["merge_request"]#' $T "$CFG"
mut "json: the webhook points at production"            $S 's#preview-aws-gateway\.vitanaland\.com#gateway.vitanaland.com#' $T "$CFG"
mut "json: the platform delivery file is renamed"       $S 's#platform-delivery\.gitlab-ci\.yml#platform-delivery-x.gitlab-ci.yml#' $T "$CFG|inactive|shadow:"
mut "json: the push mirror token file is renamed"       $S 's#github-push-mirror-token#github-mirror-token#' $T "$CFG"

# ── settings sync: states, marker, push mirror, branch rule ──────────────────────────────────────────────────────────────────────
G=$ENG/gitlab-settings.mjs
mut "sync: the marker path changes"                     $G "s#markerFile: \x27/etc/vitana/delivery-cutover\x27#markerFile: \x27/etc/vitana/cutover\x27#" $T 'live:|removing the marker|a marker that is not valid'
mut "sync: rehearsal is treated as live"                $G "s#marker\.mode === \x27rehearsal\x27\) return \x27rehearsal\x27#marker.mode === \x27rehearsal\x27) return \x27live\x27#" $T 'rehearsal:'
mut "sync: rehearsal runs the pipelines in shadow"      $G "s#mode: state === \x27shadow\x27 \? \x27shadow\x27 : \x27live\x27#mode: \x27shadow\x27#" $T 'rehearsal:'
mut "sync: the push mirror is created for every branch" $G 's#only_protected_branches: c\.pushMirror\.only_protected_branches#only_protected_branches: false#' $T 'live:'
mut "sync: the push mirror overwrites divergent refs"   $G 's#keep_divergent_refs: c\.pushMirror\.keep_divergent_refs#keep_divergent_refs: false#' $T 'live:'
mut "sync: the push mirror address loses x-access-token" $G 's#https://x-access-token:\$\{tok\.token\}\@github\.com#https://oauth2:\$\{tok.token\}\@github.com#' $T 'live:'
mut "sync: the push mirror stays after the rollback"    $G 's#for \(const m of mine\) removeMirror\(m\);\n    \} else \{#\n    \} else \{#' $T 'removing the marker'
mut "sync: the token file mode is not looked at"        $G 's#tok\.mode !== 0o600#tok.mode !== 0o777#' $T 'live: a token file'
mut "sync: assist/* stays protected after the rollback" $G 's#if \(have\) plan\.add\(\{ id, area, summary: `remove the protected branch rule#if (false) plan.add({ id, area, summary: `remove the protected branch rule#' $T 'removing the marker|live: a protected branch'
mut "sync: force push on assist/* is not looked at"     $G 's#if \(have\.allow_force_push !== false\)#if (false)#' $T 'live: a protected branch'
mut "sync: skipped pipelines count in shadow too"       $G 's#allowSkipped: live && c\.live\.allow_merge_on_skipped_pipeline#allowSkipped: c.live.allow_merge_on_skipped_pipeline#' $T 'shadow:|removing the marker'
mut "sync: DELIVERY_MODE is created protected"          $G 's#key: CUTOVER\.variable, value: c\.mode, protected: false#key: CUTOVER.variable, value: c.mode, protected: true#' $T 'shadow:|live:'
mut "sync: the mirror user keeps its old role"          $G 's#if \(m && m\.access_level !== level\) \{#if (false) {#' $T 'live:|removing the marker'
mut "sync: the bridge keeps the shadow role when live"  $G 's#role: mine\.some\(\(n\) => liveNames\.has\(n\)\) \? a\.live_role : a\.shadow_role#role: a.shadow_role#' $T 'live:'
mut "sync: bot-land is not Maintainer of a live project" $G "s#a\.role === \x27maintainer\x27 && liveNames\.size#a.role === \x27maintainer\x27 \&\& false#" $T 'live:|merge bot:'
mut "sync: a project without the delivery file is live" $G "s#if \(!p\.cutover \|\| !deliveryFiles\.has\(p\.cutover\.ci_file\)\) return \x27inactive\x27;#if (!p.cutover) return \x27inactive\x27;#" $T 'inactive:'

mut "sync: the push mirror token reaches the output and is not redacted" $G 's#divergent refs kept; token from \$\{c\.pushMirror\.token_file\}\)#divergent refs kept; token \$\{tok.token\})#; s#ctx\.redactor\.add\(token\); S\.pushMirrorTokens\.set\(name, \{ token#S.pushMirrorTokens.set(name, { token#' $T 'no secret appears'
mut "sync: a Premium-only name appears in the script"   $G "s#export function projectState#const premiumOnly = \x27merge_trains\x27;\nexport function projectState#" $T 'free tier: the script and the settings file'

# ── delivery-cutover.sh: the checklist (status) ──────────────────────────────────────────────────────────────────────────────────
C=$ENG/delivery-cutover.sh
DT=delivery-cutover.test.mjs
ITEMS='status --item: each red condition'
mut "status: a smaller GitLab host is accepted"         $C 's#\[ "\$type" = m6i\.2xlarge \]#[ -n "\$type" ]#' $DT "$ITEMS"
mut "status: the deploy runner class is not required"   $C 's#for r in vitana-eng vitana-eng-main vitana-eng-deploy; do#for r in vitana-eng vitana-eng-main; do#' $DT "$ITEMS"
mut "status: the assist role is not required"           $C 's#gl-verify gl-record gl-assist; do#gl-verify gl-record; do#' $DT "$ITEMS"
mut "status: one lane of the plan is not required"      $C 's# merge-queue github-bridge gateway-delivery cutover\)# merge-queue github-bridge cutover)#' $DT "$ITEMS"
mut "status: one shadow commit is enough"               $C 's#\[ "\$\(kv shadow\)" -ge 10 \]#[ "\$(kv shadow)" -ge 1 ]#' $DT "$ITEMS"
mut "status: a rehearsal never expires"                 $C 's#7 \* 86400#7000 * 86400#' $DT "$ITEMS"
mut "status: a running bridge timer is accepted"        $C 's#enabled\|enabled-runtime\) item bridge-dry-run fail#enabled|enabled-runtime) item bridge-dry-run ok#' $DT "$ITEMS"
mut "status: the merge bot is not looked at"            $C "s#grep -q \x27loadEffectiveProjects\x27#grep -q \x27\x27#" $DT "$ITEMS"
mut "status: an unclassified workflow is accepted"      $C 's# \|\| unknown="\$unknown \$r/\$f"# || true#' $DT "$ITEMS"

# ── delivery-cutover.sh: apply (plan §8.2) ───────────────────────────────────────────────────────────────────────────────────────
AP='apply: the cut, step by step'
mut "apply: GitHub admins may still push main"          $C 's#enforce_admins: true, required_pull_request_reviews: null#enforce_admins: false, required_pull_request_reviews: null#' $DT "$AP"
mut "apply: force pushes stay allowed on GitHub main"   $C 's#allow_force_pushes: false, allow_deletions: false\}#allow_force_pushes: true, allow_deletions: false\}#' $DT "$AP"
mut "apply: someone besides the mirror may push main"   $C 's#restrictions: \{users: \[\$u\], teams#restrictions: {users: [\$u, "someone"], teams#' $DT "$AP"
mut "apply: the plan slug is not checked"               $C 's#if \[ -n "\$slug" \] && \[ "\$slug" != "\$PLAN_SLUG" \]; then printf \x27ERROR: the plan slug is#if false; then printf \x27ERROR: the plan slug is#' $DT 'apply: a wrong plan slug'
mut "apply: no slug still changes things"               $C 's#if \[ "\$slug" = "\$PLAN_SLUG" \] && \[ "\$\{DRY_FORCED:-0\}" != 1 \]; then DRY=0; fi#if [ "\${DRY_FORCED:-0}" != 1 ]; then DRY=0; fi#' $DT 'apply: without the plan slug'
mut "apply: --dry-run with the slug still changes"      $C 's#--dry-run\) DRY=1; DRY_FORCED=1 ;;#--dry-run) DRY=1 ;;#' $DT 'apply: without the plan slug'
mut "apply: a red checklist does not stop the cut"      $C 's#Nothing was changed\."; fi\n      exit 1\n    fi#Nothing was changed."; fi\n    fi#' $DT 'apply: with a red checklist'
mut "apply: a mirror account that can only read"        $C 's#admin\|maintain\|write\) ;;#admin|maintain|write|read) ;;#' $DT 'apply: a wrong plan slug'
mut "apply: the kill switch is read the wrong way"      $C "s#jq -e \x27\.reason == \"kill_switch_on\"\x27#jq -e \x27.reason != \"kill_switch_on\"\x27#" $DT 'apply: waits for the owner|apply: the cut, step'
mut "apply: no wait for the kill switch"                $C 's#while \[ "\$waited" -lt "\$KILL_WAIT_SECONDS" \]; do#while false; do#' $DT 'apply: waits for the owner'
mut "apply: waiting for the owner exits 1, not 3"       $C 's#  return 3\n\}#  return 1\n\}#' $DT 'apply: waits for the owner'
mut "apply: the tags lose the delivery/ prefix"         $C 's#refs/tags/delivery/cutover-\$1" -f "sha#refs/tags/cutover-\$1" -f "sha#' $DT "$AP"
mut "apply: step 7 accepts any DELIVERY_MODE"           $C 's#\[ "\$\(kv delivery_mode\)" = live \] \|\|#[ -n "\$(kv delivery_mode)" ] ||#' $DT "$AP"
mut "apply: the final copy runs after the marker"       $C "s#if kv marker \| grep -q \x27\"mode\":\"live\"\x27; then say \"  the cutover marker is set#if false; then say \"  the cutover marker is set#" $DT 'failure at step 2'
mut "apply: the steps run in a different order"         $C 's#for n in 1 2 3 4 5 6 7 8; do#for n in 1 3 2 4 5 6 7 8; do#' $DT "$AP"
mut "apply: the disabled workflows are not saved"       $C 's# s4_backup "\$r" "\$todo"# true#' $DT "$AP|failure at step 4"
mut "apply: the protection is not saved first"          $C 's# s1_backup "\$r" "\$rc" \\# true \\#' $DT "$AP|failure at step 1"
mut "apply: the keep list is disabled, not the disable list" $C 's#for f in \$\(wf_names "\$r" disable\); do#for f in \$(wf_names "\$r" keep); do#' $DT "$AP"
mut "apply: step 1 failure does not put the protection back" $C 's#if restore_protection "\$r"; then say "undone: the protection#if true; then say "undone: the protection#' $DT 'failure at step 1'
mut "apply: a sync that fails leaves the marker"        $C 's#ssm_w "\$\(r_converge none\)" 100 >/dev/null \|\| true#true#' $DT 'failure at step 2'
mut "apply: a rerun does not see step 5 as done"        $C 's#    5\) ssm_run "\$\(r_probe\)" 30; \[ "\$\(kv bridge_active\)" = active \] \|\| return 1 ;;#    5) return 1 ;;#' $DT 'apply: run again after the cut'
mut "apply: the GitLab tag loses the delivery/ prefix"  $C 's#TAG="delivery/cutover-\$REPO"#TAG="cutover-\$REPO"#' $DT "$AP"
mut "machine scripts: the bot token goes on a curl command line" $C 's#printf \x27header = "PRIVATE-TOKEN: %s"\\n\x27 "\$\(cat /etc/vitana/bot-land-token\)" \| curl -sS --config - "\$\@"#curl -sS -H "PRIVATE-TOKEN: \$(cat /etc/vitana/bot-land-token)" "\$\@"#' $DT 'machine scripts'
mut "apply: the GitHub token goes on a command line"    $C 's#x_gh api user --jq \.login >/dev/null 2>&1#x_gh api user --jq .login --header "Authorization: token \$GH_TOKEN" >/dev/null 2>\&1#' $DT 'the GitHub token is typed hidden'
mut "apply: a stored value goes on the command line"    $C 's#printf \x27%s\x27 "\$2" \| aws_e secretsmanager put-secret-value --secret-id "\$1" --secret-string file:///dev/stdin >/dev/null#aws_e secretsmanager put-secret-value --secret-id "\$1" --secret-string "\$2" >/dev/null#' $DT "$AP|failure at step 1"

# ── delivery-cutover.sh: rehearse (plan §8.1 step 5) ─────────────────────────────────────────────────────────────────────────────
RH='rehearse: it needs --merges-paused'
mut "rehearse: merges need not be paused"               $C 's#\[ "\$paused" = 1 \] \|\| \{ say "rehearse: give#true || { say "rehearse: give#' $DT "$RH"
mut "rehearse: a deploy without a verification passes"  $C 's#\[ "\$\(kv deploy\)" -ge 1 \] 2>/dev/null && \[ "\$\(kv verify\)" -ge 1 \] 2>/dev/null; then#[ "\$(kv deploy)" -ge 1 ] 2>/dev/null; then#' $DT "$RH"
mut "rehearse: staging is not sent back to GitHub"      $C 's#  dispatch_and_wait vitana-platform AWS-STAGE-DEPLOY-GATEWAY\.yml \|\| return 1#  true || return 1#' $DT "$RH"
mut "rehearse: --dry-run still opens the rehearsal"     $C 's#--abort\) abort=1 ;; --dry-run\) DRY=1 ;;#--abort) abort=1 ;; --dry-run) ;;#' $DT 'rehearse --dry-run'
mut "rehearse: a dry run says the rehearsal is open"    $C 's#    if \[ "\$DRY" = 1 \]; then say "rehearse: dry run finished, nothing was changed"; return 0; fi\n    say "rehearse: OPEN#    say "rehearse: OPEN#' $DT 'rehearse --dry-run'
mut "rehearse: the rehearsal marker says live"          $C 's#ssm_w "\$\(r_converge rehearsal\)" 100#ssm_w "\$(r_converge live)" 100#' $DT "$RH"

# ── delivery-rollback.sh (plan §8.4) ─────────────────────────────────────────────────────────────────────────────────────────────
R=$ENG/delivery-rollback.sh
RB='rollback: it reverses the cut'
mut "rollback: GitHub main is not compared with GitLab main" $R 's#\[ -n "\$gh" \] && \[ "\$gh" = "\$gl" \] && break#break#' $DT 'rollback: it refuses while'
mut "rollback: GitLab-only branches are deleted silently" $R 's#if \[ "\$CONFIRM_PRUNE" != 1 \]; then say#if false; then say#' $DT 'rollback: it refuses while'
mut "rollback: every disable-list workflow is enabled"  $R 's#for f in \$\(jq -r \x27\.\[\]\x27 <<<"\$list"\); do#for f in \$(wf_names "\$r" disable); do#' $DT "$RB"
mut "rollback: the protection is not restored"          $R 's#protection-\$r" restore_protection "\$r" \|\| return 1#protection-\$r" true || return 1#' $DT "$RB"
mut "rollback: the marker stays"                        $R 's#ssm_w "\$\(r_converge none\)" 100 \|\| ok=1#ssm_w "\$(r_converge live)" 100 || ok=1#' $DT "$RB"
mut "rollback: the merge bot is stopped last"           $R 's#for n in 1 2 3 4 5 6 7 8 9 10 11; do#for n in 2 3 4 5 6 7 8 9 10 11 1; do#' $DT "$RB"
mut "rollback: the tags stay on GitHub"                 $R 's#W "delete the tag delivery/cutover-\$r on GitHub" gh_tag_delete "\$r" \|\| return 1#true#' $DT "$RB"
mut "rollback: the staging gateway is never redeployed" $R 's#  if staging_carries_cut; then\n    W "dispatch#  if false; then\n    W "dispatch#' $DT 'rollback: a staging gateway'
mut "rollback: no slug still changes things"            $R 's#if \[ "\$slug" = "\$PLAN_SLUG" \] && \[ "\$forced" != 1 \]; then DRY=0; fi#if [ "\$forced" != 1 ]; then DRY=0; fi#' $DT 'rollback: a staging gateway'
mut "rollback: the bridge is started, not stopped"      $R 's#r_unit disable-now vitana-github-bridge\.timer#r_unit enable-now vitana-github-bridge.timer#' $DT "$RB"

# ── the runbook and the pipeline runbooks (task C4) ──────────────────────────────────────────────────────────────────────────────
RBK=infra/gitlab-engineering/RUNBOOK-cutover.md
mut "runbook: the token prompt echoes what is typed"   $RBK 's#read -rsp "paste#read -rp "paste#' $DT 'runbook:'
mut "runbook: a status item is not explained"          $RBK 's#\| `bot-config` \|#| `bot-cfg` |#' $DT 'runbook:'
mut "runbook: the rollback flag is misspelled"         $RBK 's#--confirm-prune-gitlab-only-branches#--confirm-prune-branches#g' $DT 'runbook:'
mut "runbook: step 8 has no row in the cut table"      $RBK 's#\n\| 8 \| Creates the tags#\n| 9 | Creates the tags#' $DT 'runbook:'
FAKE_PAT="github_pa""t_11ABCDEFGHIJKLMNOPQRSTUV"   # assembled here so that the file holds no token-shaped literal
mut "runbook: a token is pasted into it"               $RBK "s~umask 077~umask 077 \\# $FAKE_PAT~" $DT 'runbook:'
DRV=.kiro/pipeline/driver.md
mut "driver: it no longer waits for delivery.landed"   $DRV 's#waits for `delivery\.landed`#waits for `merge.done`#' $DT 'pipeline runbooks:'
mut "driver: the Never line loses the cut rule"        $DRV 's#, never merge a pull request of a repository whose cut tag exists \(the merge bot lands it\)##' $DT 'pipeline runbooks:'
mut "driver: the flow before the tag changes"          $DRV 's#Before the tag, steps 2 and 6 are as written\.#Before the tag, steps 2 and 6 are replaced.#' $DT 'pipeline runbooks:'
mut "driver: the tag is looked up with another command" $DRV 's#git ls-remote --tags origin "refs/tags/delivery/cutover-<repo>"#git tag -l "delivery/cutover-<repo>"#' $DT 'pipeline runbooks:'
LL=.kiro/pipeline/lane-land.md
mut "lane-land: the land step does not skip a to e"    $LL 's#skip a–e#skip nothing#' $DT 'pipeline runbooks:'
mut "lane-land: the squash rule is gone"               $LL 's#\*\*squash\*\* \(the subject#**merge** (the subject#' $DT 'pipeline runbooks:'

W=$ENG/github-workflows.json
WT=github-workflows.test.mjs
RBK=infra/gitlab-engineering/RUNBOOK-cutover.md
# ── the findings B1 to B5 of the independent review (the cases named "B1: ..." to "B5: ...") ───────────────────────────────────────
mut "B1: the protection backup write is not checked"    $C 's#  secret_put "\$SECRET_PREFIX/protection-\$1" "\$want"#  secret_put "\$SECRET_PREFIX/protection-\$1" "\$want"; true#' $DT 'B1: a backup write'
mut "B1: a written secret is not read back"             $C 's#    0\) \[ "\$SECRET_VAL" = "\$2" \] && return 0;#    0) return 0;#' $DT 'B1: a backup write'
mut "B1: any GET error counts as no protection"         $C 's#if \[ "\$rc" != 0 \] && \[\[ "\$all" == \*"Branch not protected"\* \]\] && \[\[ "\$all" == \*404\* \]\]; then return 2; fi#if [ "\$rc" != 0 ]; then return 2; fi#' $DT 'B1: a 502'
mut "B1: any 404 counts as no protection"               $C 's#\[\[ "\$all" == \*"Branch not protected"\* \]\] && ##' $DT 'B1: a 502'
mut "B1: a missing backup counts as restored"           $C 's#protection_manual "\$1"; return 1; fi\n  if \[ "\$rc" != 0 \]#protection_manual "\$1"; return 0; fi\n  if [ "\$rc" != 0 ]#' $DT 'B1: a rollback whose protection backup'
mut "B1: every Secrets Manager error reads as not found" $C 's#  if grep -q ResourceNotFoundException "\$ef" 2>/dev/null; then return 2; fi#  return 2#' $DT 'B1: a rollback whose protection backup|B1: rollback step 4'
mut "B1: undone is printed after a failed restore"      $C 's#else say "NOT undone: GitHub main#else say "undone: GitHub main#' $DT 'B1: when step 1'
mut "B1: the started record is not checked"             $C 's#cut_state_put started \\\n      \|\| \{ say "apply: refused: the start#cut_state_put started \\\n      || true || { say "apply: refused: the start#' $DT 'B1: the record of a started'
mut "B1: the step 4 list is not checked"                $C 's#  secret_put "\$SECRET_PREFIX/workflows-\$1" "\$new"#  secret_put "\$SECRET_PREFIX/workflows-\$1" "\$new"; true#' $DT 'B1: the record of a started'
mut "B1: rollback step 4 without a list goes on"        $R 's#a workflow disabled before the cut stays disabled"\n      return 1#a workflow disabled before the cut stays disabled"\n      continue#' $DT 'B1: rollback step 4'
mut "B2: rollback step 3 restores whatever main has"    $R 's#if \[ "\$rc" = 0 \] && is_cut_lock "\$PROT_JSON" "\$CUT_MIRROR"; then#if true; then#' $DT 'B2: a second rollback'
mut "B2: rollback step 4 enables any disabled state"    $R 's#        disabled_manually\) W#        disabled_*) W#' $DT 'B2: a second rollback'
mut "B2: rollback step 4 acts after a finished rollback" $R 's#if \[ "\$RB_START_PHASE" = rolled-back \]; then#if false; then#' $DT 'B2: a second rollback'
mut "B2: rolling-back is not recorded"                  $R 's#cut_state_put rolling-back "\$CUT_MIRROR"#true#' $DT 'B2: the rollback records'
mut "B2: apply resumes a rolling-back cut"              $C 's#    rolling-back\)\n      say "apply: refused#    no-such-phase)\n      say "apply: refused#; s#    started\|complete\)\n      FRESH=0#    started|complete|rolling-back)\n      FRESH=0#' $DT 'B2: the rollback records'
mut "B2: an old record is resumed without the checklist" $C 's#RESUME_MAX_SECONDS=86400 #RESUME_MAX_SECONDS=8640000 #' $DT 'B2: apply resumes'
mut "B2: the mirror account of the record is ignored"   $C 's#&& \[ "\$CUT_MIRROR" != "\$MIRROR" \]#\&\& false#' $DT 'B2: apply resumes'
mut "B2: no lock is taken"                              $C 's#  if lock_create "\$body"; then LOCK_HELD=1; return 0; fi#  LOCK_HELD=0; return 0#' $DT 'B2: a lock'
mut "B2: --break-lock clears a young lock"              $C 's#LOCK_STALE_SECONDS=21600 #LOCK_STALE_SECONDS=60 #' $DT 'B2: a lock'
mut "B2: the lock is never released"                    $C 's#  LOCK_HELD=0\n  say "CHANGE: release the lock#  return 0\n  say "CHANGE: release the lock#' $DT 'B2: a lock|apply: run again'
mut "B3: bypass allowances are dropped"                 $C 's#\+ \(if \.bypass_pull_request_allowances then#+ (if false then#' $DT 'B3: '
mut "B3: a null app_id stays null"                      $C 's#app_id: \(\.app_id // -1\)#app_id#' $DT 'B3: '
mut "B3: contexts and checks are both sent"             $C 's#then \{checks: \[\.required_status_checks\.checks\[\] \| \{context, app_id: \(\.app_id // -1\)\}\]\}#then {contexts: (.required_status_checks.contexts // []), checks: [.required_status_checks.checks[] | {context, app_id: (.app_id // -1)}]}#' $DT 'B3: '
mut "B3: the round trip does not compare"               $C 's#  if \[ "\$b1" != "\$b2" \]; then#  if false; then#' $DT 'B3: rehearse first'
mut "B3: the rehearsal opens without the round trip"    $C 's#    roundtrip_all \|\| \{ say "rehearse: refused#    true || { say "rehearse: refused#' $DT 'B3: rehearse first'
mut "B3: the checklist leaves out the round trip"       $C 's#  want protection-roundtrip && chk_roundtrip\n##' $DT 'status: with every item|B3: rehearse first'
mut "B3: a changed protection keeps the item green"     $C 's#\[ "\$cur" = "\$\(restore_body_of "\$rec_p"\)" \] \|\| bad=#true || bad=#' $DT "$ITEMS|B3: rehearse first"
mut "B3: an old round trip still counts"                $C 's#ROUNDTRIP_MAX_SECONDS=604800 #ROUNDTRIP_MAX_SECONDS=60480000 #' $DT "$ITEMS"
mut "B4: heads of shared branches are not compared"     $R 's#    \[ "\$ghsha" = "\$sha" \] && continue#    continue#' $DT 'B4: the rollback refuses'
mut "B4: a diverged head reads as contained"            $R 's#\[ "\$st" = ahead \] \|\| \[ "\$st" = identical \]#true#' $DT 'B4: the rollback refuses'
mut "B4: commits at risk do not stop the rollback"      $R 's#(would rewind them[^\n]*\n      )\[ "\$DRY" = 1 \] \|\| return 1#${1}true#' $DT 'B4: the rollback refuses'
mut "B4: bot refs count as GitLab-only branches"        $R 's#BOT_REFS=\x27\^\(train\|assist\)/\x27#BOT_REFS=\x27^(nothing)/\x27#' $DT 'B4: the bot refs'
mut "B4: a full page 30 is not reported"                $R 's#if \[ "\$\(kv truncated\)" = 1 \]; then#if false; then#' $DT 'B4: the bot refs'
mut "B4: the machine never says truncated"              $C 's#\[ "\$page" -lt 30 \] \|\| truncated=1#true#' $DT 'B4: on the machine'
mut "B5: the redeploy run is not waited for"            $C 's#    if \[ "\$\{st:-\}" = completed \]; then#    if true; then return 0; fi; if false; then#' $DT 'B5: '
mut "B5: a failed redeploy counts as success"           $C 's#\[ "\$concl" = success \] && \{#true \&\& {#' $DT 'B5: the rollback'
mut "B5: the task definition is not read again"         $R 's#rb11_redeploy\(\) \{ dispatch_and_wait vitana-platform AWS-STAGE-DEPLOY-GATEWAY\.yml && staging_gateway_check; \}#rb11_redeploy() { dispatch_and_wait vitana-platform AWS-STAGE-DEPLOY-GATEWAY.yml; }#' $DT 'B5: the rollback'
mut "B5: the cut settings on staging are not seen"      $C 's#\$2 == "gitlab" \{ f = 1 \}#\$2 == "never" { f = 1 }#' $DT 'B5: '
mut "B5: the owner command is not printed"              $C 's#    staging_owner_command\n    return 1#    return 1#' $DT 'B5: '
mut "B5: the rehearsal is recorded passed before staging is back" $C 's#\|\| \{ say "rehearse: not closed: staging is not back on the GitHub path yet\.[^\n]*#|| { ssm_w "\$(r_record_rehearsal passed)" 30; exit 1; }#' $DT 'B5: closing the rehearsal'
mut "workflows: a push to github.ref_name passes unrecorded" $W 's#("i18n-translate\.yml": \{ "action": "keep", "family": "i18n-dispatch", "after_cut": "T7", )"pushes_dispatched_ref": true, #$1#' $WT 'kept workflows: a push to the dispatched ref'
mut "runbook: the round-trip item is not explained"     $RBK 's#\| `protection-roundtrip` \|#| `protection-rt` |#' $DT 'runbook:'

# ── github-workflows.json (plan §2.2) ────────────────────────────────────────────────────────────────────────────────────────────
W=$ENG/github-workflows.json
WT=github-workflows.test.mjs
mut "workflows: PR-GATE.yml is kept (platform)"         $W 's#("PR-GATE\.yml": \{ "action": )"disable"#$1"keep"#' $WT 'plan 2.2|protected gate files'
mut "workflows: UNIT.yml is kept"                       $W 's#("UNIT\.yml": \{ "action": )"disable"#$1"keep"#' $WT 'plan 2.2'
mut "workflows: PLAN-SPAR.yml is disabled"              $W 's#("PLAN-SPAR\.yml": \{ "action": )"keep"#$1"disable"#' $WT 'plan 2.2|protected gate files|kept workflows'
mut "workflows: DEPLOY-CLOUDFLARE-WORKERS no longer deploys production" $W 's#"main_push": "deploys-production"#"main_push": "none"#' $WT 'kept workflows: none pushes'
mut "workflows: a kept workflow runs on pull requests"  $W 's#("DEV-AUTOPILOT\.yml": \{[^}]*?)"dispatch_only": false#$1"dispatch_only": false, "pull_request": "all"#' $WT 'kept workflows: only PLAN-SPAR'
mut "workflows: a kept workflow gets a pull_request trigger" $W 's#("DEV-AUTOPILOT\.yml": \{[^\n]*?"triggers": \[)"schedule"#$1"pull_request", "schedule"#' $WT 'kept workflows: only PLAN-SPAR'
mut "workflows: an entry is missing"                    $W 's#        "UNIT\.yml": \{[^\n]*\n##' $WT 'list: '
mut "workflows: PR-GATE.yml loses its protected flag"   $W 's#("PR-GATE\.yml": \{ "action": "disable", "family": "pr-checks", "gitlab": "T1", )"protected": true, #$1#' $WT 'protected gate files'
mut "workflows: a recorded trigger is wrong"            $W 's#("UNIT\.yml": \{[^\n]*?"triggers": \[)"pull_request"\]#$1"schedule"]#' $WT 'list: the platform entries'

# ── delivery-metrics.mjs (plan §5, §2.1, §10) ────────────────────────────────────────────────────────────────────────────────────
M=$ENG/delivery-metrics.mjs
MT=delivery-metrics.test.mjs
mut "metrics: first result target 90 s"                 $M 's#first_result_seconds: Object\.freeze\(\{ typical: 60,#first_result_seconds: Object.freeze({ typical: 90,#' $MT 'targets:'
mut "metrics: required checks slowest 900 s"            $M 's#required_checks_seconds: Object\.freeze\(\{ typical: 300, slowest: 600#required_checks_seconds: Object.freeze({ typical: 300, slowest: 900#' $MT 'targets:'
mut "metrics: landing to verify typical 900 s"          $M 's#landing_to_verify_seconds: Object\.freeze\(\{ typical: 600,#landing_to_verify_seconds: Object.freeze({ typical: 900,#' $MT 'targets:'
mut "metrics: the GitHub baseline of first result"      $M 's#first_result_seconds: 666,#first_result_seconds: 600,#' $MT 'targets:'
mut "metrics: the budget is 6000 a month"               $M 's#BUDGET_USD_PER_MONTH = 5000#BUDGET_USD_PER_MONTH = 6000#' $MT 'compute:|a field without a source'
mut "metrics: gate is not a required job"               $M "s#\x27change-suite\x27, \x27gate\x27\]\)#\x27change-suite\x27])#" $MT 'pipeline timings'
mut "metrics: the percentile rounds down"               $M 's#Math\.ceil\(\(p / 100\) \* v\.length\) - 1#Math.floor((p / 100) * v.length) - 1#' $MT 'percentile:'
mut "metrics: no cost rows count as 0"                  $M 's#costs\.length \? costs\.reduce\(\(a, c\) => a \+ c\.usd, 0\) / costs\.length : null;#costs.length ? costs.reduce((a, c) => a + c.usd, 0) / costs.length : 0;#' $MT 'a field without a source'

# ── parity-report.mjs (plan §8.1 step 3) ─────────────────────────────────────────────────────────────────────────────────────────
P=$ENG/parity-report.mjs
PT=parity-report.test.mjs
mut "parity: a deploy of an unserved commit is compared" $P "s#new Set\(\[\x27t2\x27, \x27t3\x27\]\)#new Set([\x27t2\x27])#" $PT 'report: a commit staging never served'
mut "parity: both red is unexplained"                   $P "s#kind: \x27both_failed\x27, explained: true#kind: \x27both_failed\x27, explained: false#" $PT 'report: a difference with a reason'
mut "parity: a cancelled GitHub run is unexplained"     $P "s#kind: \x27github_did_not_run\x27, explained: true#kind: \x27github_did_not_run\x27, explained: false#" $PT 'report: a difference with a reason'
mut "parity: five shadow commits are enough"            $P 's#minShadow = 10, now#minShadow = 5, now#' $PT 'report: the checklist verdict|cli:'
mut "parity: the GitHub token is not redacted from an error" $P "s#\\$\\{redact\\(text, token\\)\\.replace#\\$\\{text.replace#; s#for \\(const s of secrets\\) if \\(s\\) msg = msg\\.split\\(s\\)\\.join\\(\\x27\\[redacted\\]\\x27\\);##" $PT 'cli: a GitHub or GitLab that refuses a token'
mut "parity: a missing GitLab job is explained"         $P "s#kind: \x27no_gitlab_job\x27, explained: false#kind: \x27no_gitlab_job\x27, explained: true#" $PT 'report: every unexplained'
mut "parity: a commit older than the shadow period counts" $P 's#if \(n > firstShadow\) \{ row\.state = #if (n < firstShadow) { row.state = #' $PT 'report: a commit older'

wait
cat "$WORK"/r*.txt > "$WORK/all.txt"
cat "$WORK/all.txt"
total="$(wc -l < "$WORK/all.txt")"
caught="$(grep -c '^caught ' "$WORK/all.txt")"
if [ "${DRY:-0}" = 1 ]; then echo; echo "applied: $(grep -c '^applied' "$WORK/all.txt")   not applied: $((total - $(grep -c '^applied' "$WORK/all.txt")))"; exit 0; fi
echo
echo "mutations: $total   caught: $caught   not caught: $((total - caught))"
[ "$caught" = "$total" ]
