// Tests of scripts/eng/delivery-cutover.sh and scripts/eng/delivery-rollback.sh (plan agentic-delivery §8, lane cutover, VTID-05545).
// The two scripts run for real in bash against stand-ins for aws, gh, git, curl, node and sleep that sit first on PATH (as the tests of m2.sh and
// ops-install.sh do): the stand-ins keep a small world in files (GitHub protection and workflows, Secrets Manager, the GitLab machine behind
// Systems Manager, the lane files in git, the kill switch), record every call, and can be told to fail. Nothing here touches a network, an
// account or a repository. Dependency-free Node (node:test), so UNIT.yml runs it with no install; it needs bash and jq, which CloudShell and the
// runners have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CUT = path.join(HERE, 'delivery-cutover.sh');
const ROLL = path.join(HERE, 'delivery-rollback.sh');
const WORKFLOWS = JSON.parse(fs.readFileSync(path.join(HERE, 'github-workflows.json'), 'utf8'));
const GH_FIXTURE_TOKEN = ['github', 'pat', '11CUTOVERAAAAAAAAAAAAAA'].join('_');
const BOT_TOKEN = ['glp', 'at-secret-token-value'].join('');   // a fixture, assembled at run time like the others
const AWS_FAKE = ['AKIA', 'FAKEKEY000000'].join('');
const AWS_FAKE_SECRET = ['fake', 'secret', 'keyvalue'].join('');
const AWS_FAKE_SESSION = 'fakesessiontokenvalue';
const MIRROR = 'vitana-gitlab-mirror';
const REPOS = ['vitana-platform', 'vitana-v1'];
const SLUG = 'agentic-delivery';
const DISABLE = Object.fromEntries(REPOS.map((r) => [r, Object.entries(WORKFLOWS.repositories[r].workflows).filter(([, e]) => e.action === 'disable').map(([f]) => f).sort()]));
const KEEP = Object.fromEntries(REPOS.map((r) => [r, Object.entries(WORKFLOWS.repositories[r].workflows).filter(([, e]) => e.action === 'keep').map(([f]) => f).sort()]));
const SHA = { 'vitana-platform': '1111111111111111111111111111111111111111', 'vitana-v1': '2222222222222222222222222222222222222222' };
const ORIGINAL_PROTECTION = {
  url: 'https://api.github.com/x', required_status_checks: { url: 'u', strict: true, contexts: ['validate'], contexts_url: 'c', checks: [{ context: 'validate', app_id: 15368 }] },
  enforce_admins: { url: 'u', enabled: true },
  required_pull_request_reviews: { url: 'u', dismiss_stale_reviews: true, require_code_owner_reviews: false, required_approving_review_count: 1, require_last_push_approval: false },
  restrictions: null, required_linear_history: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false }, block_creations: { enabled: false },
  required_conversation_resolution: { enabled: true }, lock_branch: { enabled: false }, allow_fork_syncing: { enabled: false },
};
const RESTORE_BODY = {
  required_status_checks: { strict: true, checks: [{ context: 'validate', app_id: 15368 }] }, enforce_admins: true,
  required_pull_request_reviews: { dismiss_stale_reviews: true, require_code_owner_reviews: false, required_approving_review_count: 1, require_last_push_approval: false },
  restrictions: null, required_linear_history: true, allow_force_pushes: false, allow_deletions: false, block_creations: false, required_conversation_resolution: true, lock_branch: false, allow_fork_syncing: false,
};
const LANES = {
  'eng-gitlab-m1': ['gitlab-infra', 'gitlab-verify'],
  'eng-gitlab-m2': ['fleet', 'settings', 'merge-bot', 'scm-webhook', 'monitoring', 'rehearsal', 'gitlab-client'],
  'agentic-delivery': ['prerequisites', 'pipelines', 'deploy-path', 'verify-on-gitlab', 'merge-queue', 'github-bridge', 'gateway-delivery', 'cutover'],
};

// ═════════════════════════════════════════ the stand-ins ═════════════════════════════════════════════════════════════════════════
const LIB = String.raw`
F="$_{FAKE_DIR:?}"
US=$'\x1f'; RS=$'\x1e'
esc() { local s="$1"; printf '%s' "$_{s//$'\n'/$RS}"; }
# one record per call, appended to the output file of the script under test, so that the order of "CHANGE:" lines and calls can be read back
rec() {   # tool stdin
  local ctx=mgmt line; [ -n "$_{AWS_ACCESS_KEY_ID:-}" ] && ctx=eng
  line="@@CALL$_{US}$1$_{US}$ctx$_{US}$(esc "$_{2:-}")"
  local a; for a in "$_{ARGV[@]}"; do line="$line$_{US}$(esc "$a")"; done
  printf '%s\n' "$line" >> "$F/out.txt"
}
exists() { [ -e "$F/$1" ]; }
unit_get() { cat "$F/host/unit/$1" 2>/dev/null || echo "not-found/inactive"; }
unit_enabled() { local v; v="$(unit_get "$1")"; printf '%s' "$_{v%/*}"; }
unit_active() { local v; v="$(unit_get "$1")"; printf '%s' "$_{v#*/}"; }
setvar() { grep -m1 "^$1=" "$2" | cut -d= -f2- | sed 's/\\ / /g'; }
# a branch file holds "name" or "name sha" lines; a name without a sha gets the same made-up head on both hosts (main gets the sha of main)
heads() { local n h; while read -r n h; do [ -n "$n" ] || continue; if [ -z "$h" ]; then if [ "$n" = main ]; then h="$2"; else h="$(printf '%s' "$n" | sha1sum | cut -c1-40)"; fi; fi; printf '%s\t%s\n' "$n" "$h"; done < "$1"; }
# Secrets Manager failures on purpose: fail/sm-write, fail/sm-read, fail/sm-readback hold a part of the secret names they hit
sm_fails() { [ -e "$F/fail/$1" ] && [ -n "$2" ] && case "$2" in *"$(cat "$F/fail/$1")"*) return 0 ;; esac; return 1; }
host_sim() {   # script-file: runs what the script would do on the GitLab machine, in the world; writes <file>.out and <file>.status
  local f="$1" head kind name out="" status=Success repo sha mode action units u rc
  head="$(head -n 1 "$f")"; kind="$(awk '{print $3}' <<<"$head")"; name="$(awk '{print $4}' <<<"$head")"
  case "$name" in
    probe)
      out="marker=$( [ -s "$F/host/marker" ] && tr -d '\n' < "$F/host/marker" || echo none )
mirror_timer=$(unit_enabled vitana-mirror.timer)
bridge_timer=$(unit_enabled vitana-github-bridge.timer)
bridge_active=$(unit_active vitana-github-bridge.timer)
land_active=$(unit_active vitana-land.timer)
$(for n in github-push-mirror-token github-bridge-token gitlab-bridge-token; do echo "file_$n=$(cat "$F/host/file.$n" 2>/dev/null || echo missing)"; done)
rehearsal=$(cat "$F/host/rehearsal.json" 2>/dev/null | tr -d '\n')
settings_check=$(cat "$F/host/settings_check")
runner_tags=$(cat "$F/host/runner_tags")" ;;
    parity) repo="$(setvar REPO "$f")"; out="$(cat "$F/parity/$repo")" ;;
    bridge-dry-run) out="$(cat "$F/bridge")" ;;
    gitlab-main) repo="$(setvar REPO "$f")"; out="main_sha=$(cat "$F/gitlab/$repo.main")
truncated=$(exists "fail/gitlab-truncated.$repo" && echo 1 || echo 0)
$(heads "$F/gitlab/$repo.branches" "$(cat "$F/gitlab/$repo.main")" | sed 's/^/branch=/; s/\t/ /')" ;;
    variable) repo="$(setvar REPO "$f")"; out="delivery_mode=$(cat "$F/gitlab/$repo.mode")" ;;
    pipelines) repo="$(setvar REPO "$f")"; out="$(cat "$F/pipelines/$repo")" ;;
    converge)
      mode="$(setvar MODE "$f")"
      if [ "$mode" = none ]; then rm -f "$F/host/marker"; for r in vitana-platform vitana-v1; do echo shadow > "$F/gitlab/$r.mode"; done
      else printf '{"schema":"vitana.delivery-cutover-marker/v1","mode":"%s","plan":"agentic-delivery","at":"2026-11-10T08:00:00Z"}\n' "$mode" > "$F/host/marker"; if ! exists fail/mode-stuck; then for r in vitana-platform vitana-v1; do echo live > "$F/gitlab/$r.mode"; done; fi; fi
      if exists fail/converge; then rc=1; else rc=0; fi
      out="marker_written=1
sync_exit=0
settings_exit=$rc
{\"event\":\"done\",\"exit\":$rc}
check_exit=$rc"
      [ "$rc" = 0 ] && [ "$mode" != none ] && echo 52 > "$F/host/file.gitlab-bridge-token" && echo "600 52" > "$F/host/file.gitlab-bridge-token" ;;
    unit)
      action="$(setvar ACTION "$f")"; units="$(setvar UNITS "$f")"
      for u in $units; do
        case "$action" in enable-now) echo enabled/active > "$F/host/unit/$u" ;; disable-now) echo disabled/inactive > "$F/host/unit/$u" ;; start) echo "$(unit_enabled "$u")/active" > "$F/host/unit/$u" ;; stop) echo "$(unit_enabled "$u")/inactive" > "$F/host/unit/$u" ;; esac
        out="$_{out}state_$u=$(unit_active "$u")/$(unit_enabled "$u")
"
      done
      out="$_{out}unit_exit=0" ;;
    mirror-final)
      if exists fail/mirror-final; then status=Failed; out="mirror_exit=1"; else for r in vitana-platform vitana-v1; do cat "$F/gh/$r/main" > "$F/gitlab/$r.main"; done; out="mirror_exit=0"; fi ;;
    tag)
      repo="$(setvar REPO "$f")"; sha="$(setvar SHA "$f")"
      if exists "fail/tag.$repo"; then status=Failed; out="tag_state=failed"; else echo "$sha" > "$F/gitlab/$repo.tag"; out="tag_state=created"; fi ;;
    tag-delete) repo="$(setvar REPO "$f")"; rm -f "$F/gitlab/$repo.tag"; out="tag_delete_http=204" ;;
    rehearsal-record)
      mode="$(setvar STATE "$f")"
      if [ "$mode" = open ]; then printf '{"state":"open","started_at":"2026-11-10T08:00:00Z"}' > "$F/host/rehearsal.json"
      else printf '{"state":"%s","started_at":"2026-11-10T08:00:00Z","finished_at":"%s"}' "$mode" "$(date -u +%FT%TZ)" > "$F/host/rehearsal.json"; fi
      out="rehearsal_record=$mode" ;;
    *) status=Failed; out="unknown script $name" ;;
  esac
  printf '%s\n' "$out" > "$f.out"; printf '%s\n' "$status" > "$f.status"
}
`;

const AWS = String.raw`#!/bin/bash
. "$FAKE_DIR/lib.sh"
ARGV=("$@")
in=""; for a in "$@"; do [ "$a" = "file:///dev/stdin" ] && { in="$(cat)"; break; }; done
rec aws "$in"
argval() { local n="$1"; shift; while [ $# -gt 0 ]; do [ "$1" = "$n" ] && { printf '%s' "$_{2:-}"; return; }; shift; done; }
sid() { local id; id="$(argval --secret-id "$@")"; [ -n "$id" ] || id="$(argval --name "$@")"; printf '%s' "$_{id//\//__}"; }
case "$_{1:-} $_{2:-}" in
  "sts get-caller-identity") cat "$F/account" ;;
  "organizations list-accounts") echo 111122223333 ;;
  "sts assume-role") printf '{"AccessKeyId":"%s","SecretAccessKey":"%s","SessionToken":"%s"}\n' "${AWS_FAKE}" "${AWS_FAKE_SECRET}" "${AWS_FAKE_SESSION}" ;;
  "ec2 describe-instances") case "$(argval --query "$@")" in *InstanceType*) cat "$F/host/instance_type" ;; *) cat "$F/host/instance_id" ;; esac ;;
  "ssm send-command")
    n=$(( $(cat "$F/ssm.n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$F/ssm.n"
    mkdir -p "$F/ssm"; argval --parameters "$@" | jq -r '.commands[0]' > "$F/ssm/$n.sh"
    host_sim "$F/ssm/$n.sh"; echo "cmd-$n" ;;
  "ssm get-command-invocation")
    n="$(argval --command-id "$@")"; n="$_{n#cmd-}"
    case "$(argval --query "$@")" in Status) cat "$F/ssm/$n.sh.status" ;; StandardOutputContent) cat "$F/ssm/$n.sh.out" ;; *) : ;; esac ;;
  "secretsmanager describe-secret") sm_fails sm-read "$(sid "$@")" && { echo "An error occurred (AccessDeniedException) when calling the DescribeSecret operation" >&2; exit 254; }; [ -e "$F/secrets/$(sid "$@")" ] && echo '{}' || { echo "An error occurred (ResourceNotFoundException)" >&2; exit 254; } ;;
  "secretsmanager get-secret-value")
    sm_fails sm-read "$(sid "$@")" && { echo "An error occurred (AccessDeniedException) when calling the GetSecretValue operation" >&2; exit 254; }
    [ -e "$F/secrets/$(sid "$@")" ] || { echo "An error occurred (ResourceNotFoundException)" >&2; exit 254; }
    cat "$F/secrets/$(sid "$@")"; sm_fails sm-readback "$(sid "$@")" && printf ' ' ; : ;;
  "secretsmanager create-secret") sm_fails sm-write "$(sid "$@")" && { echo "An error occurred (ThrottlingException) when calling the CreateSecret operation: Rate exceeded" >&2; exit 254; }; mkdir -p "$F/secrets"; [ -e "$F/secrets/$(sid "$@")" ] && { echo "An error occurred (ResourceExistsException)" >&2; exit 254; }; printf '%s' "$in" > "$F/secrets/$(sid "$@")"; echo '{}' ;;
  "secretsmanager put-secret-value") sm_fails sm-write "$(sid "$@")" && { echo "An error occurred (ThrottlingException) when calling the PutSecretValue operation: Rate exceeded" >&2; exit 254; }; [ -e "$F/secrets/$(sid "$@")" ] || { echo "An error occurred (ResourceNotFoundException)" >&2; exit 254; }; printf '%s' "$in" > "$F/secrets/$(sid "$@")"; echo '{}' ;;
  "secretsmanager delete-secret") [ -e "$F/secrets/$(sid "$@")" ] || { echo "An error occurred (ResourceNotFoundException)" >&2; exit 254; }; rm -f "$F/secrets/$(sid "$@")"; echo '{}' ;;
  "iam list-open-id-connect-providers") cat "$F/iam/providers" ;;
  "iam get-role") [ -e "$F/iam/role.$(argval --role-name "$@")" ] && echo '{}' || { echo "An error occurred (NoSuchEntity)" >&2; exit 254; } ;;
  "ecs describe-services") echo arn:aws:ecs:eu-central-1:472838866351:task-definition/vitana-gateway:7 ;;
  "ecs describe-task-definition")   # the DELIVERY_HOST_* variables of the staging gateway, as the --query of staging_read prints them
    case "$(argval --query "$@")" in
      *starts_with*) v="$(cat "$F/staging_delivery_host")"; [ "$v" = None ] || printf 'DELIVERY_HOST_VITANA_PLATFORM\t%s\nDELIVERY_HOST_VITANA_V1\t%s\n' "$v" "$v" ;;
      *) cat "$F/staging_delivery_host" ;;
    esac ;;
  *) echo "unexpected aws call: $*" >&2; exit 99 ;;
esac
`;

const GH = String.raw`#!/bin/bash
. "$FAKE_DIR/lib.sh"
ARGV=("$@")
in=""; for a in "$@"; do [ "$a" = "-" ] && { in="$(cat)"; break; }; done
rec gh "$in"
if [ "$_{GH_TOKEN:-}" != "$(cat "$F/expect-gh-token")" ]; then echo "HTTP 401: Bad credentials" >&2; exit 1; fi
method=GET; path=""; raw=""
args=("$@"); i=0
if [ "$_{args[0]:-}" = workflow ]; then   # gh workflow run FILE -R owner/repo --ref main: a run that is finished at once; the real redeploy keeps DELIVERY_HOST_*
  wf="$_{args[2]}"; r=""; for ((j = 0; j < $_{#args[@]}; j++)); do [ "$_{args[$j]}" = -R ] && r="$_{args[$((j+1))]#*/}"; done
  n=$(( $(cat "$F/gh/runs.n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$F/gh/runs.n"
  concl=success; exists "fail/redeploy.$wf" && concl=failure
  printf '{"workflow_runs":[{"id":%s,"status":"completed","conclusion":"%s","created_at":"%s","html_url":"https://github.com/exafyltd/%s/actions/runs/%s"}]}' "$n" "$concl" "$(date -u +%FT%TZ)" "$r" "$n" > "$F/gh/$r.runs.$wf"
  if [ "$wf" = AWS-STAGE-DEPLOY-GATEWAY.yml ] && [ "$concl" = success ] && exists redeploy_clears_env; then echo None > "$F/staging_delivery_host"; fi
  exit 0
fi
[ "$_{args[0]:-}" = api ] || { echo "unexpected gh call: $*" >&2; exit 99; }
i=1
while [ $i -lt $_{#args[@]} ]; do
  case "$_{args[$i]}" in -X) method="$_{args[$((i+1))]}"; i=$((i+2)) ;; -H|-f|--jq|--input) i=$((i+2)) ;; --paginate) i=$((i+1)) ;; *) path="$_{args[$i]}"; i=$((i+1)) ;; esac
done
repo="$(sed -n 's#^repos/exafyltd/\([^/]*\).*#\1#p' <<<"$path")"
fail() { exists "fail/$1" && { echo "HTTP 500: boom" >&2; exit 1; }; return 0; }
case "$method $path" in
  "GET user") echo "owner-user" ;;
  "GET repos/exafyltd/$repo") cat "$F/gh/$repo/admin" ;;
  "GET repos/exafyltd/$repo/collaborators/"*"/permission") login="$_{path#*/collaborators/}"; login="$_{login%/permission}"; if [ -e "$F/gh/permission.$login" ]; then cat "$F/gh/permission.$login"; elif [ "$login" = "$_{MIRROR_LOGIN:-vitana-gitlab-mirror}" ]; then echo write; else exit 1; fi ;;
  "GET repos/exafyltd/$repo/branches/main/protection")   # as gh prints GitHub's answers: the body on stdout, "gh: <message> (HTTP <code>)" on stderr
    exists "fail/protection-get.$repo" && { echo '{"message":"Server Error"}'; echo "gh: Bad Gateway (HTTP 502)" >&2; exit 1; }
    exists "fail/protection-404-other.$repo" && { echo '{"message":"Not Found","status":"404"}'; echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
    [ -e "$F/gh/$repo/protection.json" ] && cat "$F/gh/$repo/protection.json" || { echo '{"message":"Branch not protected","documentation_url":"https://docs.github.com/rest/branches/branch-protection#get-branch-protection","status":"404"}'; echo "gh: Branch not protected (HTTP 404)" >&2; exit 1; } ;;
  "PUT repos/exafyltd/$repo/branches/main/protection")
    fail "protect.$repo"
    n=$(( $(cat "$F/gh/$repo/put.n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$F/gh/$repo/put.n"; printf '%s' "$in" > "$F/gh/$repo/put.$n.json"
    if exists "fail/protect-after.$repo" && [ "$n" -gt "$(cat "$F/fail/protect-after.$repo")" ]; then echo "gh: Server Error (HTTP 500)" >&2; exit 1; fi
    # the request schema of docs.github.com "Update branch protection"; GitHub also refuses contexts and checks in one call
    bad="$(jq -r '
      def strs: type == "array" and all(.[]; type == "string");
      def lists(p): (. // {}) | to_entries[] | select((.value | strs) | not) | "\(p).\(.key) must be a list of strings";
      [ (["required_status_checks","enforce_admins","required_pull_request_reviews","restrictions"][] as $k | select(has($k) | not) | "\($k) is required"),
        (.required_status_checks | select(. != null) | (
          (select((.strict | type) != "boolean") | "strict is required"),
          (select(has("contexts") and has("checks")) | "only one of contexts and checks may be given"),
          (select((has("contexts") or has("checks")) | not) | "contexts is required"),
          (select(has("contexts") and ((.contexts | strs) | not)) | "contexts must be a list of strings"),
          ((.checks // [])[] | select(has("app_id") and ((.app_id | type) != "number")) | "\(.app_id) is not of type integer (app_id)"))),
        (.required_pull_request_reviews | select(. != null) | ((.dismissal_restrictions | lists("dismissal_restrictions")), (.bypass_pull_request_allowances | lists("bypass_pull_request_allowances")))),
        (.restrictions | select(. != null) | lists("restrictions"))
      ] | .[0] // empty' <<<"$in" 2>&1)"
    if [ -n "$bad" ]; then echo '{"message":"Invalid request."}'; printf 'gh: Invalid request.\n\n%s (HTTP 422)\n' "$bad" >&2; exit 1; fi
    jq --arg u "https://api.github.com/repos/exafyltd/$repo/branches/main/protection" '
      def logins: [(. // [])[] | {login: .}]; def slugs: [(. // [])[] | {slug: .}];
      def en(k): {enabled: (.[k] // false)};
      {url: $u,
       required_status_checks: (.required_status_checks | if . == null then null else
         (if has("checks") then [.checks[] | {context, app_id: (if (.app_id // -1) == -1 then null else .app_id end)}] else [.contexts[] | {context: ., app_id: null}] end) as $c
         | {url: "u", strict, contexts: [$c[].context], contexts_url: "c", checks: $c} end),
       enforce_admins: {url: "u", enabled: .enforce_admins},
       required_pull_request_reviews: (.required_pull_request_reviews | if . == null then null else
         {url: "u", dismiss_stale_reviews: (.dismiss_stale_reviews // false), require_code_owner_reviews: (.require_code_owner_reviews // false), required_approving_review_count: (.required_approving_review_count // 0), require_last_push_approval: (.require_last_push_approval // false)}
         + (if .dismissal_restrictions then {dismissal_restrictions: {users: (.dismissal_restrictions.users | logins), teams: (.dismissal_restrictions.teams | slugs), apps: (.dismissal_restrictions.apps | slugs)}} else {} end)
         + (if .bypass_pull_request_allowances then {bypass_pull_request_allowances: {users: (.bypass_pull_request_allowances.users | logins), teams: (.bypass_pull_request_allowances.teams | slugs), apps: (.bypass_pull_request_allowances.apps | slugs)}} else {} end) end),
       restrictions: (if .restrictions then {url: "u", users: (.restrictions.users | logins), teams: (.restrictions.teams | slugs), apps: (.restrictions.apps | slugs)} else null end),
       required_linear_history: en("required_linear_history"), allow_force_pushes: en("allow_force_pushes"), allow_deletions: en("allow_deletions"), block_creations: en("block_creations"),
       required_conversation_resolution: en("required_conversation_resolution"), lock_branch: en("lock_branch"), allow_fork_syncing: en("allow_fork_syncing")}' <<<"$in" > "$F/gh/$repo/protection.json"
    if exists "fail/put-drift.$repo"; then jq '.required_linear_history.enabled = false' "$F/gh/$repo/protection.json" > "$F/gh/$repo/p.tmp" && mv "$F/gh/$repo/p.tmp" "$F/gh/$repo/protection.json"; fi   # GitHub keeps less than it was sent
    echo '{}' ;;
  "DELETE repos/exafyltd/$repo/branches/main/protection") [ -e "$F/gh/$repo/protection.json" ] || { echo '{"message":"Branch not protected"}'; echo "gh: Branch not protected (HTTP 404)" >&2; exit 1; }; rm -f "$F/gh/$repo/protection.json"; echo '{}' ;;
  "GET repos/exafyltd/$repo/compare/"*)   # base...head: "ahead" when gh/<repo>/contains lists "<head> <base>", else diverged
    bh="$_{path#*/compare/}"; base="$_{bh%%...*}"; head="$_{bh##*...}"
    if [ "$base" = "$head" ]; then echo identical; elif grep -qx "$head $base" "$F/gh/$repo/contains" 2>/dev/null; then echo ahead; else echo diverged; fi ;;
  "GET repos/exafyltd/$repo/actions/workflows/"*"/runs"*) wf="$_{path#*/actions/workflows/}"; wf="$_{wf%%/runs*}"; cat "$F/gh/$repo.runs.$wf" 2>/dev/null || echo '{"workflow_runs":[]}' ;;
  "GET repos/exafyltd/$repo/actions/workflows") cat "$F/gh/$repo/workflows.tsv" ;;
  "PUT repos/exafyltd/$repo/actions/workflows/"*)
    f="$_{path#*/workflows/}"; act="$_{f#*/}"; f="$_{f%/*}"; fail "workflow.$f"
    tmp="$F/gh/$repo/workflows.tsv.new"; awk -F'\t' -v f="$f" -v act="$act" 'BEGIN{OFS="\t"} { n=split($1,a,"/"); if (a[n]==f) $2=(act=="disable"?"disabled_manually":"active"); print }' "$F/gh/$repo/workflows.tsv" > "$tmp"; mv "$tmp" "$F/gh/$repo/workflows.tsv"; echo "$method $f $act" >> "$F/gh/$repo/workflow.log" ;;
  "GET repos/exafyltd/$repo/branches/main") cat "$F/gh/$repo/main" ;;
  "GET repos/exafyltd/$repo/branches") exists "fail/branches.$repo" && { echo "gh: Server Error (HTTP 500)" >&2; exit 1; }; heads "$F/gh/$repo/branches" "$(cat "$F/gh/$repo/main")" ;;
  "GET repos/exafyltd/$repo/contents/.github/workflows/"*) printf 'name: x\non:\n  workflow_dispatch:\n' ;;
  "GET repos/exafyltd/$repo/git/ref/tags/delivery/cutover-$repo") [ -e "$F/gh/$repo/tag" ] && echo '{}' || { echo "HTTP 404" >&2; exit 1; } ;;
  "POST repos/exafyltd/$repo/git/refs") fail "ghtag.$repo"; cat "$F/gh/$repo/main" > "$F/gh/$repo/tag"; echo '{}' ;;
  "DELETE repos/exafyltd/$repo/git/refs/tags/delivery/cutover-$repo") rm -f "$F/gh/$repo/tag"; echo '{}' ;;
  *) echo "unexpected gh api call: $method $path" >&2; exit 99 ;;
esac
`;

const GIT = String.raw`#!/bin/bash
. "$FAKE_DIR/lib.sh"
ARGV=("$@")
rec git ""
case " $* " in
  *" fetch "*) exists fail/fetch && exit 1; exit 0 ;;
  *" show origin/main:.kiro/specs/"*) a="$*"; p="$_{a##*origin/main:}"; p="$_{p#.kiro/specs/}"; plan="$_{p%%/*}"; lane="$_{p##*/}"; lane="$_{lane%.md}"
     [ -e "$F/lanes/$plan/$lane" ] || exit 128; printf -- '---\nlane: %s\nstate: %s\n---\n' "$lane" "$(cat "$F/lanes/$plan/$lane")" ;;
  *" show origin/main:scripts/eng/gitlab-land.mjs"*) if exists bot_reads_cut; then echo "import { loadEffectiveProjects } from './gitlab-settings.mjs';"; else echo "import { loadProjects } from './x.mjs';"; fi ;;
  *) echo "unexpected git call: $*" >&2; exit 99 ;;
esac
`;
const CURL = String.raw`#!/bin/bash
. "$FAKE_DIR/lib.sh"
ARGV=("$@")
rec curl ""
case "$*" in
  *"/api/v1/ops/runtime/autopilot/kill-switch"*) if [ "$(cat "$F/killswitch")" = on ]; then echo '{"status":"degraded","reason":"kill_switch_on","auto_approve":false}'; else echo '{"status":"ok","kill_switch":false}'; fi ;;
  *) echo "unexpected curl call: $*" >&2; exit 99 ;;
esac
`;
const NODE = String.raw`#!/bin/bash
. "$FAKE_DIR/lib.sh"
ARGV=("$@")
rec node "dir=$_{VITANA_V1_WORKFLOWS_DIR:-none} files=$(ls "$_{VITANA_V1_WORKFLOWS_DIR:-/nonexistent}" 2>/dev/null | wc -l | tr -d ' ')"
if exists fail/workflow-test; then echo "not ok 3 - list: the platform entries are exactly the files"; exit 1; fi
echo "ok 1"; exit 0
`;
const SLEEP = String.raw`#!/bin/bash
. "$FAKE_DIR/lib.sh"
ARGV=("$@")
n=$(( $(cat "$F/sleeps" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$F/sleeps"
if [ "$_{1:-}" = 15 ]; then   # the wait of step 6 for the owner to switch the kill switch on
  k=$(( $(cat "$F/ks.sleeps" 2>/dev/null || echo 0) + 1 )); echo "$k" > "$F/ks.sleeps"
  if [ -e "$F/killswitch.after" ] && [ "$k" -ge "$(cat "$F/killswitch.after")" ]; then echo on > "$F/killswitch"; fi
fi
exit 0
`;

// In the sources above a shell ${ is written $_{ so that the JavaScript template leaves it alone.
const sh = (s) => s.replaceAll('$_{', '${');

// ═════════════════════════════════════════ the world ════════════════════════════════════════════════════════════════════════════
const PARITY_OK = 'shadow=12\nunexplained=0\nready_targets=true\nfirst_result=41/75\nrequired_checks=210/390\nfirst_difference=none';
const BRIDGE_OK = 'bridge_rc=0\nbridge_planned=7\nbridge_problems=0\nbridge_tick_done=1';
const hours = (n) => new Date(Date.now() - n * 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z');

function makeWorld(T, { keep = false } = {}) {
  const F = path.join(T, 'fake');
  const w = {
    T, F, bin: path.join(T, 'bin'),
    put: (rel, text) => { const p = path.join(F, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); },
    get: (rel) => (fs.existsSync(path.join(F, rel)) ? fs.readFileSync(path.join(F, rel), 'utf8').trim() : null),
    rm: (rel) => fs.rmSync(path.join(F, rel), { force: true, recursive: true }),
    flag: (rel) => w.put(rel, '1'),
    cleanup: () => { if (!keep) fs.rmSync(T, { recursive: true, force: true }); },
  };
  const spawnEnv = (env) => ({ PATH: `${w.bin}:/usr/bin:/bin`, HOME: T, TMPDIR: path.join(T, 'tmp'), FAKE_DIR: F, CUTOVER_ROOT: path.join(T, 'repo'), CUTOVER_STATE: path.join(T, 'state.env'), GH_TOKEN: GH_FIXTURE_TOKEN, CUTOVER_KILL_WAIT_SECONDS: '30', CUTOVER_MIRROR_WAIT_SECONDS: '0', LC_ALL: 'C', ...env });
  const result = (status, signal, stderr) => {
    const timeline = fs.readFileSync(path.join(F, 'out.txt'), 'utf8').split('\n').filter(Boolean);
    const calls = timeline.filter((l) => l.startsWith('@@CALL')).map((l, n) => { const [, tool, ctx, stdin, ...argv] = l.split('\x1f'); return { n, tool, ctx, stdin: stdin.replaceAll('\x1e', '\n'), argv: argv.map((a) => a.replaceAll('\x1e', '\n')) }; });
    const stdout = timeline.filter((l) => !l.startsWith('@@CALL')).join('\n');
    const events = timeline.map((l) => { if (!l.startsWith('@@CALL')) return { line: l }; const [, tool, ctx, stdin, ...argv] = l.split('\x1f'); return { call: { tool, ctx, stdin: stdin.replaceAll('\x1e', '\n'), argv: argv.map((a) => a.replaceAll('\x1e', '\n')) } }; });
    return { status, signal, stdout, stderr, timeline, events, calls, all: `${stdout}\n${stderr}` };
  };
  w.run = (args, { env = {}, input = '' } = {}) => {
    fs.writeFileSync(path.join(F, 'out.txt'), '');
    const fd = fs.openSync(path.join(F, 'out.txt'), 'a');
    const r = spawnSync('bash', args, { encoding: 'utf8', input, stdio: ['pipe', fd, 'pipe'], timeout: 120_000, env: spawnEnv(env) });
    fs.closeSync(fd);
    return result(r.status, r.signal, r.stderr ?? '');
  };
  w.runAsync = (args, { env = {}, input = '' } = {}) => new Promise((resolve) => {
    fs.writeFileSync(path.join(F, 'out.txt'), '');
    const fd = fs.openSync(path.join(F, 'out.txt'), 'a');
    const child = spawn('bash', args, { stdio: ['pipe', fd, 'pipe'], env: spawnEnv(env) });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.end(input);
    child.on('close', (code, signal) => { fs.closeSync(fd); resolve(result(code, signal, stderr)); });
  });
  return w;
}
function newWorld(opts = {}) {
  const T = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'dcut-'));
  const w = makeWorld(T, opts);
  const F = w.F;
  for (const d of ['bin', 'fake', 'repo/scripts/eng', 'tmp', 'etc']) fs.mkdirSync(path.join(T, d), { recursive: true });
  fs.copyFileSync(path.join(HERE, 'github-workflows.json'), path.join(T, 'repo/scripts/eng/github-workflows.json'));
  w.put('lib.sh', sh(LIB));
  for (const [name, text] of Object.entries({ aws: AWS, gh: GH, git: GIT, curl: CURL, node: NODE, sleep: SLEEP })) fs.writeFileSync(path.join(w.bin, name), sh(text), { mode: 0o755 });
  fs.writeFileSync(path.join(T, 'state.env'), 'ACCOUNT_ID=111122223333\nGITLAB_ID=i-0abc123def4567890\n');
  w.put('expect-gh-token', GH_FIXTURE_TOKEN);
  w.put('account', '472838866351');
  for (const [plan, lanes] of Object.entries(LANES)) for (const l of lanes) w.put(`lanes/${plan}/${l}`, 'done');
  w.flag('bot_reads_cut');
  w.put('host/instance_type', 'm6i.2xlarge'); w.put('host/instance_id', 'i-0abc123def4567890');
  w.put('host/runner_tags', 'vitana-eng,vitana-eng-deploy,vitana-eng-main,vitana-legacy');
  w.put('host/settings_check', '0');
  for (const f of ['github-push-mirror-token', 'github-bridge-token', 'gitlab-bridge-token']) w.put(`host/file.${f}`, '600 52');
  w.put('host/rehearsal.json', JSON.stringify({ state: 'passed', started_at: hours(50), finished_at: hours(48) }));
  for (const r of REPOS) w.put(`secrets/${SM_PREFIX.replaceAll('/', '__')}__roundtrip-${r}`, JSON.stringify({ result: 'passed', at: hours(48), protection: ORIGINAL_PROTECTION }));
  for (const [u, s] of Object.entries({ 'vitana-mirror.timer': 'enabled/active', 'vitana-github-bridge.timer': 'disabled/inactive', 'vitana-land.timer': 'enabled/active', 'vitana-land.service': 'static/inactive' })) w.put(`host/unit/${u}`, s);
  w.put('iam/providers', 'arn:aws:iam::472838866351:oidc-provider/gitlab.vitanaland.com');
  for (const r of ['gl-v1-staging', 'gl-platform-staging', 'gl-v1-preview', 'gl-verify', 'gl-record', 'gl-assist']) w.put(`iam/role.${r}`, '1');
  w.put('staging_delivery_host', 'None');
  w.put('killswitch', 'off');
  w.put('bridge', BRIDGE_OK);
  for (const r of REPOS) {
    w.put(`parity/${r}`, PARITY_OK);
    w.put(`pipelines/${r}`, 'deploy=0\nverify=0');
    w.put(`gh/${r}/admin`, 'true');
    w.put(`gh/${r}/main`, `${SHA[r]}\n`.trim());
    w.put(`gh/${r}/branches`, 'main\nkiro/a\nkiro/b\n');
    w.put(`gh/${r}/protection.json`, JSON.stringify(ORIGINAL_PROTECTION));
    const rows = Object.entries(WORKFLOWS.repositories[r].workflows).map(([f]) => `.github/workflows/${f}\tactive`).join('\n');
    w.put(`gh/${r}/workflows.tsv`, `${rows}\n`);
    w.put(`gitlab/${r}.main`, SHA[r]);
    w.put(`gitlab/${r}.branches`, 'main\nkiro/a\nkiro/b\n');
    w.put(`gitlab/${r}.mode`, 'shadow');
  }
  return w;
}
const cloneWorld = (src) => { const T = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'dcut-')); fs.cpSync(src.T, T, { recursive: true }); return makeWorld(T); };
const withWorld = async (fn, opts) => { const w = newWorld(opts); try { return await fn(w); } finally { w.cleanup(); } };

// call classification: a write is a state-changing call; a Systems Manager script says on its first line whether it only reads
const scriptOf = (c) => { const i = c.argv.indexOf('--parameters'); return i < 0 ? '' : JSON.parse(c.argv[i + 1]).commands[0]; };
const marker = (c) => (scriptOf(c).split('\n')[0].match(/^# vitana-cutover: (read|write) (\S+)/) ?? []).slice(1);
function isWrite(c) {
  if (c.tool === 'gh') {
    if (c.argv[0] === 'workflow') return true;
    const m = c.argv.indexOf('-X');
    return m >= 0 && ['PUT', 'POST', 'DELETE'].includes(c.argv[m + 1]);
  }
  if (c.tool === 'aws') {
    if (c.argv[0] === 'secretsmanager') return ['create-secret', 'put-secret-value', 'delete-secret'].includes(c.argv[1]);
    if (c.argv[0] === 'ssm' && c.argv[1] === 'send-command') return marker(c)[0] === 'write';
  }
  return false;
}
const writes = (r) => r.calls.filter(isWrite);
const writeKinds = (r) => writes(r).map((c) => (c.tool === 'gh' ? `gh ${c.argv.includes('-X') ? c.argv[c.argv.indexOf('-X') + 1] : 'workflow'} ${c.argv.find((a) => a.startsWith('repos/')) ?? ''}` : c.argv[0] === 'ssm' ? `ssm ${marker(c)[1]}` : `secret ${c.argv[1]}`));
const ssmNames = (r) => r.calls.filter((c) => c.tool === 'aws' && c.argv[1] === 'send-command').map((c) => marker(c).join(' '));
const secrets = (w) => { const d = path.join(w.F, 'secrets'); return fs.existsSync(d) ? Object.fromEntries(fs.readdirSync(d).map((f) => [f.replaceAll('__', '/'), fs.readFileSync(path.join(d, f), 'utf8')])) : {}; };
const SM_PREFIX = 'vitana/engineering/gitlab/delivery-cutover';
const protection = (w, r) => JSON.parse(w.get(`gh/${r}/protection.json`));
const wfState = (w, r) => Object.fromEntries(w.get(`gh/${r}/workflows.tsv`).trim().split('\n').map((l) => { const [p, s] = l.split('\t'); return [p.split('/').pop(), s]; }));
const APPLY = [CUT, 'apply', SLUG, '--mirror-account', MIRROR];
const items = (out) => Object.fromEntries([...out.matchAll(/^\[( OK |FAIL)\] (\S+)\s+(.*)$/gm)].map((m) => [m[2], { ok: m[1] === ' OK ', text: m[3] }]));
const ITEM_IDS = ['m1', 'm2', 'm2-rehearsal', 'lanes', 'a1', 'a2', 'a3', 'shadow-commits', 'shadow-parity', 'shadow-targets', 'bridge-dry-run', 'rehearsal', 'protection-roundtrip', 'workflows', 'bot-config'];
const LOCK = `${SM_PREFIX}/lock`;
const isLockCall = (c) => c.tool === 'aws' && c.argv[0] === 'secretsmanager' && c.argv.includes(LOCK);
const writesBesidesLock = (r) => writes(r).filter((c) => !isLockCall(c));
const smKey = (name) => `secrets/${name.replaceAll('/', '__')}`;
const putSecret = (w, name, value) => w.put(smKey(name), typeof value === 'string' ? value : JSON.stringify(value));
const putState = (w, phase, at, mirror = MIRROR) => putSecret(w, `${SM_PREFIX}/state`, { phase, mirror_account: mirror, at });

// ═════════════════════════════════════════ the scripts as files ═══════════════════════════════════════════════════════════════════
test('structure: both scripts are strict bash, have no xtrace, name the management account, and reach the world only through the x_ wrappers and W', () => {
  for (const f of [CUT, ROLL]) {
    const r = spawnSync('bash', ['-n', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${path.basename(f)}: ${r.stderr}`);
    const text = fs.readFileSync(f, 'utf8');
    assert.match(text, /^#!\/bin\/bash\n/);
    assert.match(text, /^set -uo pipefail$/m);
    assert.equal(/\bset -[a-z]*x\b|\bset -o xtrace/.test(text.replace(/^\s*#.*$/gm, '')), false, `${path.basename(f)}: no xtrace`);
  }
  const text = fs.readFileSync(CUT, 'utf8');
  assert.match(text, /^MGMT=472838866351$/m);
  assert.match(text, /AWS_REGION=eu-central-1 AWS_DEFAULT_REGION=eu-central-1/);
  assert.match(text, /^GH_OWNER=exafyltd$/m);
  assert.match(text, /^PLAN_SLUG=agentic-delivery$/m);
  for (const c of ['status', 'rehearse', 'apply']) assert.match(text, new RegExp(`\\b${c}\\b`));
  // outside the wrapper definitions and the scripts that run on the machine, no external command is called by its own name
  const body = text.replace(/cat <<'REMOTE'[\s\S]*?\nREMOTE\n/g, '').split('\n').filter((l) => !/^\s*#/.test(l) && !/^x_[a-z]+\(\) \{/.test(l)).join('\n');
  const bare = body.split('\n').filter((l) => /(^|[;&|(]\s*|\$\(\s*|then\s+|do\s+|\|\|\s*|&&\s*)(aws|gh|git|curl|node|sleep)\s/.test(l.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''")));
  assert.deepEqual(bare, [], 'every aws, gh, git, curl, node and sleep goes through x_aws, x_gh, x_git, x_curl, x_node, x_sleep');
  const roll = fs.readFileSync(ROLL, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.deepEqual(roll.split('\n').filter((l) => /(^|[;&|(]\s*|\$\(\s*)(aws|gh|git|curl|node|sleep)\s/.test(l.replace(/"[^"]*"/g, '""'))), []);
  // secrets: a value goes through stdin or the environment of the call, never an argument
  assert.equal(/--secret-string\s+"?\$/.test(text), false, 'no secret value as an argument');
  assert.match(text, /--secret-string file:\/\/\/dev\/stdin/);
  assert.equal(/(echo|printf|say)[^\n]*\$\{?GH_TOKEN/.test(text.replace(/read -rsp[^\n]*\n/g, '')), false, 'the token is never printed');
  assert.equal(/Authorization|--token\b|-u\s+\S+:/i.test(text.replace(/cat <<'REMOTE'[\s\S]*?\nREMOTE\n/g, '')), false);
  // every state-changing call is made through W (printed first, skipped in a dry run)
  for (const fn of ['gh_protect_put', 'gh_protect_delete', 'gh_workflow', 'gh_tag_create', 'gh_tag_delete', 'secret_put']) {
    const uses = [...(text + fs.readFileSync(ROLL, 'utf8')).matchAll(new RegExp(`^.*\\b${fn}\\b.*$`, 'gm'))].map((m) => m[0]).filter((l) => !new RegExp(`^${fn}\\(\\)`).test(l));
    for (const l of uses) assert.ok(/\bW "|UNDO|restore_protection|s[14]_(backup|undo)|cut_state_put|secret_put "\$SECRET_PREFIX|^\s*(for|if)\b/.test(l) || l.includes('rollback') || /\$\(|\|\|/.test(l), `${fn} is reached through W or an UNDO: ${l.trim().slice(0, 100)}`);
  }
  // every script for the machine starts with its read or write line and runs in plain sh
  const remote = [...text.matchAll(/^r_([a-z_]+)\(\) \{[\s\S]*?\n\}\n/gm)].map((m) => m[0]);
  assert.ok(remote.length >= 12, `the machine scripts: ${remote.length}`);
  for (const fn of remote) assert.match(fn, /rhead (read|write) [a-z-]+/, fn.slice(0, 40));
});

test('usage: no command, an unknown command and extra words are exit 2 with the usage; --help is exit 0; nothing is called', () => withWorld((w) => {
  for (const args of [[CUT], [CUT, 'nonsense'], [CUT, 'status', 'extra'], [CUT, 'apply', 'a', 'b'], [CUT, 'apply', '--nope']]) {
    const r = w.run(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.all, /usage: bash scripts\/eng\/delivery-cutover\.sh/);
    assert.equal(r.calls.length, 0, 'no call for a usage message');
  }
  const h = w.run([CUT, '--help']);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /status[\s\S]*rehearse[\s\S]*apply/);
  const hr = w.run([ROLL, '--help']);
  assert.equal(hr.status, 0);
  assert.match(hr.stdout, /usage: bash scripts\/eng\/delivery-rollback\.sh/);
}));

// ═════════════════════════════════════════ status: the checklist of plan §8.1 ═══════════════════════════════════════════════════════
test('status: with every item true it prints the 15 items of plan §8.1 one by one, green, says the cut may start, exits 0, and only reads', () => withWorld((w) => {
  const r = w.run([CUT, 'status']);
  assert.equal(r.status, 0, r.all);
  const it = items(r.stdout);
  assert.deepEqual(Object.keys(it), ITEM_IDS, 'the items, in the order of the plan');
  for (const id of ITEM_IDS) assert.equal(it[id].ok, true, `${id}: ${it[id].text}`);
  assert.match(r.stdout, /status: all 15 items are green: the cut may start/);
  assert.match(it.m1.text, /M1 done/);
  assert.match(it['shadow-targets'].text, /first result 1\/3 min, required checks 5\/10 min/);
  assert.match(it.workflows.text, /160 workflows classified/);
  assert.deepEqual(writes(r), [], 'status never changes anything');
  assert.deepEqual(ssmNames(r).filter((x) => !x.startsWith('read ')), [], 'every script it sends to the machine only reads');
  assert.ok(ssmNames(r).includes('read parity') && ssmNames(r).includes('read bridge-dry-run') && ssmNames(r).includes('read probe'));
  const node = r.calls.find((c) => c.tool === 'node');
  assert.match(node.stdin, /files=46/, 'the workflow test ran with the 46 workflow files of vitana-v1 fetched from GitHub');
  assert.deepEqual(node.argv.slice(0, 1), ['--test']);
  assert.match(node.argv[1], /scripts\/eng\/github-workflows\.test\.mjs$/);
  const names = r.calls.filter((c) => c.tool === 'aws' && c.ctx === 'mgmt').map((c) => c.argv.slice(0, 2).join(' '));
  assert.ok(names.includes('iam get-role'), 'A1 is read in the signed-in account');
  assert.ok(r.calls.filter((c) => c.tool === 'aws' && c.argv[0] === 'ssm').every((c) => c.ctx === 'eng'), 'the machine is reached with the credentials of the engineering account');
}));

const RED = [
  ['M1 lane not done', (w) => w.put('lanes/eng-gitlab-m1/gitlab-infra', 'ready'), 'm1', /not done: gitlab-infra=ready/],
  ['an M2 lane in review', (w) => w.put('lanes/eng-gitlab-m2/monitoring', 'in-review'), 'm2', /not done: monitoring=in-review/],
  ['an M2 lane file that is missing', (w) => w.rm('lanes/eng-gitlab-m2/scm-webhook'), 'm2', /scm-webhook=missing/],
  ['the M2 rehearsal not done', (w) => w.put('lanes/eng-gitlab-m2/rehearsal', 'ready'), 'm2-rehearsal', /rehearsal=ready/],
  ['a lane of plan section 9 not done', (w) => w.put('lanes/agentic-delivery/cutover', 'in-review'), 'lanes', /cutover=in-review/],
  ['the OIDC provider missing', (w) => w.put('iam/providers', 'arn:aws:iam::472838866351:oidc-provider/token.actions.githubusercontent.com'), 'a1', /oidc-provider/],
  ['an IAM role missing', (w) => w.rm('iam/role.gl-record'), 'a1', /gl-record/],
  ['the GitLab host not grown', (w) => w.put('host/instance_type', 'm6i.xlarge'), 'a2', /host-is-m6i\.xlarge-not-m6i\.2xlarge/],
  ['a runner class missing', (w) => w.put('host/runner_tags', 'vitana-eng,vitana-eng-main'), 'a2', /no-runner-tagged-vitana-eng-deploy/],
  ['the bridge token file missing', (w) => w.rm('host/file.github-bridge-token'), 'a3', /github-bridge-token:missing/],
  ['the push mirror token file with the wrong mode', (w) => w.put('host/file.github-push-mirror-token', '644 52'), 'a3', /github-push-mirror-token:not-mode-600-or-empty/],
  ['a token file that is empty', (w) => w.put('host/file.github-bridge-token', '600 0'), 'a3', /github-bridge-token:not-mode-600-or-empty/],
  ['nine shadow commits', (w) => w.put('parity/vitana-v1', PARITY_OK.replace('shadow=12', 'shadow=9')), 'shadow-commits', /vitana-v1:9-shadow-commits/],
  ['an unexplained difference', (w) => w.put('parity/vitana-platform', PARITY_OK.replace('unexplained=0', 'unexplained=2').replace('first_difference=none', 'first_difference=UNIT.yml:gitlab_failed_github_passed:abc123def')), 'shadow-parity', /vitana-platform:2-unexplained\(first:UNIT\.yml:gitlab_failed_github_passed:abc123def\)/],
  ['the section 5 targets missed', (w) => w.put('parity/vitana-v1', PARITY_OK.replace('ready_targets=true', 'ready_targets=false')), 'shadow-targets', /vitana-v1:first-result=41\/75,required-checks=210\/390/],
  ['no parity report', (w) => w.put('parity/vitana-v1', 'parity_failed=1'), 'shadow-commits', /vitana-v1:no-report/],
  ['a bridge dry run with a refused branch', (w) => w.put('bridge', BRIDGE_OK.replace('bridge_problems=0', 'bridge_problems=1')), 'bridge-dry-run', /1 problem line\(s\)/],
  ['a bridge dry run that crashed', (w) => w.put('bridge', BRIDGE_OK.replace('bridge_rc=0', 'bridge_rc=1')), 'bridge-dry-run', /exit 1/],
  ['the bridge timer already running', (w) => w.put('host/unit/vitana-github-bridge.timer', 'enabled/active'), 'bridge-dry-run', /enabled before the cut/],
  ['the bridge timer not installed', (w) => w.rm('host/unit/vitana-github-bridge.timer'), 'bridge-dry-run', /not installed/],
  ['no rehearsal', (w) => w.rm('host/rehearsal.json'), 'rehearsal', /state is none/],
  ['a rehearsal that is still open', (w) => w.put('host/rehearsal.json', JSON.stringify({ state: 'open', started_at: hours(2) })), 'rehearsal', /state is open/],
  ['a rehearsal that passed ten days ago', (w) => w.put('host/rehearsal.json', JSON.stringify({ state: 'passed', finished_at: hours(240) })), 'rehearsal', /older than 7 days/],
  ['a workflow GitHub has and the list does not', (w) => w.put('gh/vitana-v1/workflows.tsv', `${w.get('gh/vitana-v1/workflows.tsv')}\n.github/workflows/BRAND-NEW.yml\tactive\n`), 'workflows', /do not classify: vitana-v1\/BRAND-NEW\.yml|does not classify:? vitana-v1\/BRAND-NEW\.yml|not classify:? vitana-v1\/BRAND-NEW\.yml/],
  ['a listed workflow that GitHub no longer has', (w) => w.put('gh/vitana-platform/workflows.tsv', w.get('gh/vitana-platform/workflows.tsv').split('\n').filter((l) => !l.includes('/UNIT.yml')).join('\n')), 'workflows', /not on GitHub: vitana-platform\/UNIT\.yml/],
  ['the workflow test failing', (w) => w.flag('fail/workflow-test'), 'workflows', /github-workflows\.test\.mjs failed: not ok 3/],
  ['a merge bot that does not read the cut configuration', (w) => w.rm('bot_reads_cut'), 'bot-config', /does not call loadEffectiveProjects/],
  ['no round trip of the protection', (w) => w.rm(`secrets/${SM_PREFIX.replaceAll('/', '__')}__roundtrip-vitana-v1`), 'protection-roundtrip', /vitana-v1:never-run.*rehearse --protection-only/],
  ['a round trip that failed', (w) => w.put(`secrets/${SM_PREFIX.replaceAll('/', '__')}__roundtrip-vitana-platform`, JSON.stringify({ result: 'failed', at: hours(1) })), 'protection-roundtrip', /vitana-platform:failed/],
  ['a round trip of eight days ago', (w) => w.put(`secrets/${SM_PREFIX.replaceAll('/', '__')}__roundtrip-vitana-v1`, JSON.stringify({ result: 'passed', at: hours(192), protection: ORIGINAL_PROTECTION })), 'protection-roundtrip', /vitana-v1:older-than-7-days/],
  ['a protection changed after the round trip', (w) => w.put('gh/vitana-v1/protection.json', JSON.stringify({ ...ORIGINAL_PROTECTION, required_linear_history: { enabled: false } })), 'protection-roundtrip', /vitana-v1:protection-changed-since/],
  ['a round trip record that cannot be read', (w) => w.put('fail/sm-read', 'roundtrip-vitana-platform'), 'protection-roundtrip', /vitana-platform:record-unreadable/],
];
// every role of plan section 7 and every lane of the checklist turns its own item red, not only the first one of each list
for (const role of ['gl-v1-staging', 'gl-platform-staging', 'gl-v1-preview', 'gl-verify', 'gl-record', 'gl-assist']) RED.push([`the IAM role ${role} missing`, (w) => w.rm(`iam/role.${role}`), 'a1', new RegExp(`missing:.*${role}`)]);
for (const [plan, item, lanes] of [['eng-gitlab-m1', 'm1', ['gitlab-infra', 'gitlab-verify']], ['eng-gitlab-m2', 'm2', ['fleet', 'settings', 'merge-bot', 'scm-webhook', 'monitoring']], ['agentic-delivery', 'lanes', LANES['agentic-delivery']]]) {
  for (const lane of lanes) RED.push([`the lane ${plan}/${lane} not done`, (w) => w.put(`lanes/${plan}/${lane}`, 'in-review'), item, new RegExp(`${lane}=in-review`)]);
}
test('status --item: each red condition turns exactly its own item red, names the reason, makes the exit code 1; the other items of the same group stay as they were', async () => {
  const cases = RED.map(async ([label, mutate, id, re]) => {
    const fresh = newWorld();
    try {
      mutate(fresh);
      const r = await fresh.runAsync([CUT, 'status', '--item', id]);
      assert.equal(r.status, 1, `${label}: ${r.all.slice(-400)}`);
      const it = items(r.stdout);
      assert.deepEqual(Object.keys(it), [id], `${label}: only ${id} is printed`);
      assert.equal(it[id].ok, false, label);
      assert.match(it[id].text, re, label);
      assert.match(r.stdout, new RegExp(`status: not green: ${id} -- the cut does not start \\(apply refuses\\)`));
      assert.deepEqual(writes(r), [], `${label}: still read only`);
    } finally {
      fresh.cleanup();
    }
  });
  await Promise.all(cases);
});

test('status --item: a green item is green and exits 0, an unknown item is a usage mistake, and the full status marks exactly the broken item when two items are broken', () => withWorld((w) => {
  for (const id of ITEM_IDS) {
    const r = w.run([CUT, 'status', '--item', id]);
    assert.equal(r.status, 0, `${id}: ${r.all}`);
    assert.deepEqual(Object.keys(items(r.stdout)), [id]);
    assert.match(r.stdout, new RegExp(`status: ${id} is green`));
  }
  const bad = w.run([CUT, 'status', '--item', 'nonsense']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--item is one of: m1 m2/);
  w.put('lanes/agentic-delivery/pipelines', 'ready');
  w.put('parity/vitana-v1', PARITY_OK.replace('unexplained=0', 'unexplained=1'));
  const r = w.run([CUT, 'status']);
  assert.equal(r.status, 1);
  assert.deepEqual(Object.entries(items(r.stdout)).filter(([, v]) => !v.ok).map(([k]) => k), ['lanes', 'shadow-parity']);
  assert.match(r.stdout, /status: not green: lanes shadow-parity -- the cut does not start/);
}));

test('status: when git cannot fetch origin/main, the four lane items fail by name and the others still run', () => withWorld((w) => {
  w.flag('fail/fetch');
  const r = w.run([CUT, 'status']);
  assert.equal(r.status, 1);
  const it = items(r.stdout);
  assert.deepEqual(Object.entries(it).filter(([, v]) => !v.ok).map(([k]) => k), ['m1', 'm2', 'm2-rehearsal', 'lanes']);
  assert.match(it.m1.text, /git fetch of origin\/main failed/);
  assert.equal(it.workflows.ok, true);
}));

test('preflight: the wrong AWS account, a missing tool, a GitHub token GitHub does not accept and one without admin rights each stop the command before anything is read or changed', () => withWorld((w) => {
  w.put('account', '999999999999');
  let r = w.run([CUT, 'status']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /run this in the management account 472838866351/);
  assert.deepEqual(r.calls.filter((c) => c.tool !== 'aws'), [], 'not even GitHub was asked');
  w.put('account', '472838866351');
  // A hermetic PATH: the system's own programs, minus the tools the script checks for, so a machine that happens to have gh or aws
  // in /usr/bin (a GitHub runner has both) cannot hide the missing tool.
  const sysbin = path.join(w.T, 'sysbin');
  fs.mkdirSync(sysbin, { recursive: true });
  const checked = new Set(['aws', 'git', 'jq', 'node', 'gh', 'curl', 'glab']);
  for (const dir of ['/bin', '/usr/bin']) for (const n of fs.readdirSync(dir)) {
    if (checked.has(n) || fs.existsSync(path.join(sysbin, n))) continue;
    try { fs.symlinkSync(path.join(dir, n), path.join(sysbin, n)); } catch { /* a name that cannot be linked is not needed */ }
  }
  fs.symlinkSync(fs.realpathSync(spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim()), path.join(sysbin, 'jq'));
  fs.mkdirSync(path.join(w.T, 'onlybin'), { recursive: true });
  const noTools = spawnSync('bash', [CUT, 'status'], { encoding: 'utf8', env: { PATH: `${path.join(w.T, 'onlybin')}:${sysbin}`, HOME: w.T } });
  for (const t of ['aws', 'git', 'node']) fs.copyFileSync(path.join(w.bin, t), path.join(w.T, 'onlybin', t));
  const r2 = spawnSync('bash', [CUT, 'status'], { encoding: 'utf8', env: { PATH: `${path.join(w.T, 'onlybin')}:${sysbin}`, HOME: w.T, FAKE_DIR: w.F } });
  assert.equal(noTools.status, 2);
  assert.match(noTools.stderr, /ERROR: aws is not installed here/);
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /ERROR: gh is not installed here/);
  r = w.run([CUT, 'status'], { env: { GH_TOKEN: ['a-token', 'github-refuses'].join('-') } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /GitHub did not accept the token/);
  w.put('gh/vitana-v1/admin', 'false');
  r = w.run([CUT, 'status']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no admin rights on exafyltd\/vitana-v1/);
  w.put('gh/vitana-v1/admin', 'true');
  fs.writeFileSync(path.join(w.T, 'state.env'), 'ACCOUNT_ID=111122223333\n');
  w.put('host/instance_id', 'None');
  r = w.run([CUT, 'status']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the GitLab machine vitana-eng-gitlab was not found in account 111122223333, region eu-central-1/);
}));

test('the GitHub token is typed hidden when GH_TOKEN is not set, and it appears in no output, no argument and no file', () => withWorld((w) => {
  const r = w.run([CUT, 'status'], { env: { GH_TOKEN: '' }, input: `${GH_FIXTURE_TOKEN}\n` });
  const typed = spawnSync('bash', ['-c', `unset GH_TOKEN; exec bash ${CUT} status`], { encoding: 'utf8', input: `${GH_FIXTURE_TOKEN}\n`, env: { PATH: `${w.bin}:/usr/bin:/bin`, HOME: w.T, TMPDIR: path.join(w.T, 'tmp'), FAKE_DIR: w.F, CUTOVER_ROOT: path.join(w.T, 'repo'), CUTOVER_STATE: path.join(w.T, 'state.env') } });
  assert.equal(typed.status, 0, typed.stdout + typed.stderr);
  assert.equal(typed.stdout.includes(GH_FIXTURE_TOKEN), false);
  assert.equal(typed.stderr.includes(GH_FIXTURE_TOKEN), false);
  assert.equal(r.status === 0 || r.status === 1, true);
  const seen = fs.readFileSync(path.join(w.F, 'out.txt'), 'utf8');
  assert.equal(seen.includes(GH_FIXTURE_TOKEN), false, 'no call has the token in its arguments or stdin');
  for (const s of [AWS_FAKE, AWS_FAKE_SECRET, AWS_FAKE_SESSION]) assert.equal(`${typed.stdout}${typed.stderr}${seen}`.includes(s), false, 'no AWS credential is printed');
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
  walk(w.T);
  for (const f of files.filter((x) => !x.endsWith('expect-gh-token'))) assert.equal(fs.readFileSync(f, 'utf8').includes(GH_FIXTURE_TOKEN), false, `${path.relative(w.T, f)} holds no token`);
  const none = spawnSync('bash', ['-c', `unset GH_TOKEN; exec bash ${CUT} status`], { encoding: 'utf8', input: '', env: { PATH: `${w.bin}:/usr/bin:/bin`, HOME: w.T, FAKE_DIR: w.F, CUTOVER_ROOT: path.join(w.T, 'repo'), CUTOVER_STATE: path.join(w.T, 'state.env') } });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no GitHub token/);
}));

// ═════════════════════════════════════════ apply: the cut of plan §8.2 ═══════════════════════════════════════════════════════════
/** Every state-changing call is preceded by the "CHANGE: ..." (or "UNDO: ...") line that says what it is; returns the ones that are not. */
function unannounced(r) {
  const bad = [];
  r.events.forEach((e, i) => {
    if (!e.call || !isWrite(e.call)) return;
    let j = i - 1;
    while (j >= 0 && r.events[j].call) j -= 1;
    const prev = j >= 0 ? r.events[j].line : '(nothing)';
    if (!/^(CHANGE|UNDO): /.test(prev)) bad.push(`${e.call.tool} ${e.call.argv.slice(0, 4).join(' ')} after "${prev.slice(0, 70)}"`);
  });
  return bad;
}
const idxOf = (r, pred) => r.calls.findIndex(pred);
const unitWrite = (action, unit) => (c) => c.tool === 'aws' && c.argv[1] === 'send-command' && marker(c).join(' ') === 'write unit' && scriptOf(c).includes(`ACTION=${action}`) && scriptOf(c).includes(unit);
const ssmWrite = (name) => (c) => c.tool === 'aws' && c.argv[1] === 'send-command' && marker(c).join(' ') === `write ${name}`;
const ghWrite = (needle) => (c) => c.tool === 'gh' && c.argv.includes('-X') && c.argv.some((a) => a.includes(needle));
const stepsDone = (r) => [...r.stdout.matchAll(/== STEP (\d) of 8/g)].length;
const POST_CUT_KILL = (w) => w.put('killswitch.after', '1');
const doneWorld = () => { const w = newWorld(); POST_CUT_KILL(w); const r = w.run(APPLY); assert.equal(r.status, 0, r.all); return { w, r }; };

test('apply: without the plan slug, or with --dry-run, it is a dry run: it shows every change as WOULD, makes none, and still reads the checklist', async () => {
  const runs = await Promise.all([
    withWorld((w) => w.run([CUT, 'apply', '--mirror-account', MIRROR])),
    withWorld((w) => w.run([CUT, 'apply', SLUG, '--dry-run'])),
  ]);
  for (const r of runs) {
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /apply: DRY RUN: nothing will be changed/);
    assert.deepEqual(Object.keys(items(r.stdout)), ITEM_IDS, 'the checklist is read first');
    for (let n = 1; n <= 8; n += 1) assert.match(r.stdout, new RegExp(`== STEP ${n} of 8: `));
    assert.deepEqual(writes(r), [], 'no state-changing call');
    assert.equal(/^CHANGE: /m.test(r.stdout), false);
    assert.match(r.stdout, /apply: dry run finished, nothing was changed/);
  }
  const r = runs[1];
  for (const repo of REPOS) {
    for (const f of DISABLE[repo]) assert.match(r.stdout, new RegExp(`WOULD: PUT repos/exafyltd/${repo}/actions/workflows/${f.replace(/\./g, '\\.')}/disable`), `${repo}/${f} would be disabled`);
    for (const f of KEEP[repo]) assert.equal(r.stdout.includes(`/actions/workflows/${f}/disable`), false, `${repo}/${f} is kept`);
  }
  assert.equal((r.stdout.match(/WOULD: PUT repos\/exafyltd\/[a-z0-9-]+\/actions\/workflows\/\S+\/disable/g) ?? []).length, 71);
  assert.match(r.stdout, /WOULD: PUT repos\/exafyltd\/vitana-v1\/branches\/main\/protection: push and merge restricted to <mirror-account>|WOULD: PUT repos\/exafyltd\/vitana-v1\/branches\/main\/protection: push and merge restricted to vitana-gitlab-mirror/);
  assert.match(r.stdout, /WOULD: run the GitHub-to-GitLab copy once more/);
  assert.match(r.stdout, /WOULD: write \/etc\/vitana\/delivery-cutover \(mode live\)/);
  assert.match(r.stdout, /WOULD: start the bridge/);
  assert.match(r.stdout, /WOULD: create the tag delivery\/cutover-vitana-platform on GitHub/);
  assert.match(r.stdout, /OWNER ACTION \(production control, plan B1\)/);
  assert.match(r.stdout, /WOULD: wait up to 30s for the kill switch/);
});

test('apply: a wrong plan slug, an unknown option, a real run without --mirror-account and a mirror account that cannot push are refused before anything is changed', () => withWorld((w) => {
  let r = w.run([CUT, 'apply', 'some-other-plan', '--mirror-account', MIRROR]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /the plan slug is agentic-delivery \(you gave some-other-plan\): nothing was done/);
  assert.equal(r.calls.length, 0, 'not a single call');
  r = w.run([CUT, 'apply', SLUG]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /give --mirror-account LOGIN/);
  assert.equal(r.calls.length, 0);
  r = w.run([CUT, 'apply', SLUG, '--mirror-account', 'someone-else']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /someone-else has no push access to exafyltd\/vitana-platform/);
  assert.deepEqual(writes(r), []);
  r = w.run([CUT, 'apply', SLUG, '--mirror-account', 'bad login!']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--mirror-account must be the GitHub login/);
  assert.deepEqual(writes(r), []);
  for (const level of ['read', 'triage', 'none']) {   // an account that cannot push main cannot be the mirror
    w.put('gh/permission.reader', `${level}\n`);
    r = w.run([CUT, 'apply', SLUG, '--mirror-account', 'reader']);
    assert.equal(r.status, 1, level);
    assert.match(r.stderr, new RegExp(`reader has no push access to exafyltd/vitana-platform \\(GitHub says: ${level}\\)`));
    assert.deepEqual(writes(r), [], level);
  }
  for (const level of ['write', 'maintain', 'admin']) {
    w.put('gh/permission.pusher', `${level}\n`);
    r = w.run([CUT, 'apply', SLUG, '--mirror-account', 'pusher', '--dry-run']);
    assert.equal(r.status, 0, `${level}: ${r.all}`);
  }
}));

test('apply: with a red checklist it refuses, names the red item, and changes nothing', () => withWorld((w) => {
  w.put('parity/vitana-v1', PARITY_OK.replace('unexplained=0', 'unexplained=3'));
  const r = w.run(APPLY);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /\[FAIL\] shadow-parity/);
  assert.match(r.stdout, /status: not green: shadow-parity -- the cut does not start \(apply refuses\)/);
  assert.match(r.stdout, /apply: refused\. Nothing was changed\./);
  assert.equal(/== STEP 1/.test(r.stdout), false, 'step 1 never started');
  assert.deepEqual(writes(r), []);
  assert.equal(protection(w, 'vitana-v1').restrictions, null);
}));

test('apply: the cut, step by step in the order of plan §8.2, each change printed before it is made, and every effect in place at the end', () => {
  const { w, r } = doneWorld();
  try {
    assert.equal(stepsDone(r), 8);
    assert.match(r.stdout, /apply: the cut is done\./);
    assert.deepEqual(unannounced(r), [], 'every state-changing call is printed first');
    // the changes, in order
    const order = [
      idxOf(r, ghWrite('/branches/main/protection')), idxOf(r, ssmWrite('mirror-final')), idxOf(r, unitWrite('disable-now', 'vitana-mirror.timer')), idxOf(r, ssmWrite('converge')),
      idxOf(r, ghWrite('/disable')), idxOf(r, unitWrite('enable-now', 'vitana-github-bridge.timer')), idxOf(r, (c) => c.tool === 'curl'), idxOf(r, ghWrite('/git/refs')), idxOf(r, ssmWrite('tag')),
    ];
    assert.ok(order.every((n) => n >= 0), `all the calls exist: ${order}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, '1 protection, 2 final copy and stop, 3 marker, 4 workflows, 5 bridge, 6 kill switch read, 8 tags');
    // 1: GitHub main accepts pushes and merges only from the mirror account
    for (const repo of REPOS) {
      const p = protection(w, repo);
      assert.deepEqual(p.restrictions.users.map((u) => u.login), [MIRROR]);
      assert.equal(p.required_status_checks, null);
      assert.equal(p.enforce_admins.enabled, true, 'also for admins');
      assert.deepEqual(JSON.parse(w.get(`gh/${repo}/put.1.json`)), { required_status_checks: null, enforce_admins: true, required_pull_request_reviews: null, restrictions: { users: [MIRROR], teams: [], apps: [] }, allow_force_pushes: false, allow_deletions: false });
    }
    const saved = secrets(w);
    for (const repo of REPOS) assert.deepEqual(JSON.parse(saved[`${SM_PREFIX}/protection-${repo}`]), ORIGINAL_PROTECTION, 'the protection before the cut is saved, byte for byte');
    // 2: the copy ran once more and is stopped; both mains are the same
    assert.equal(w.get('host/unit/vitana-mirror.timer'), 'disabled/inactive');
    for (const repo of REPOS) assert.equal(w.get(`gitlab/${repo}.main`).trim(), SHA[repo]);
    // 3: the marker, the sync, DELIVERY_MODE
    assert.equal(JSON.parse(w.get('host/marker')).mode, 'live');
    for (const repo of REPOS) assert.equal(w.get(`gitlab/${repo}.mode`).trim(), 'live');
    // 4: exactly the disable list is disabled, PR-GATE.yml included, and nothing that is kept
    for (const repo of REPOS) {
      const st = wfState(w, repo);
      for (const f of DISABLE[repo]) assert.equal(st[f], 'disabled_manually', `${repo}/${f}`);
      for (const f of KEEP[repo]) assert.equal(st[f], 'active', `${repo}/${f} stays`);
      assert.deepEqual(JSON.parse(saved[`${SM_PREFIX}/workflows-${repo}`]), DISABLE[repo], 'the workflows the cut disabled are saved for the rollback');
    }
    assert.equal(wfState(w, 'vitana-platform')['PR-GATE.yml'], 'disabled_manually');
    assert.equal(wfState(w, 'vitana-platform')['PLAN-SPAR.yml'], 'active');
    assert.equal(wfState(w, 'vitana-platform')['DEPLOY-CLOUDFLARE-WORKERS.yml'], 'active');
    // 5, 6, 7, 8
    assert.equal(w.get('host/unit/vitana-github-bridge.timer'), 'enabled/active');
    assert.match(r.stdout, /the kill switch is on/);
    assert.match(r.stdout, /armed: the first landing on vitana-platform main that changes the gateway deploys it to staging with PM_AGENT_ENABLED=false/);
    for (const repo of REPOS) { assert.equal(w.get(`gh/${repo}/tag`).trim(), SHA[repo]); assert.equal(w.get(`gitlab/${repo}.tag`).trim(), SHA[repo], 'the tag is on both hosts at the same commit'); }
    // the tag names: GitHub gets the ref refs/tags/delivery/cutover-<repo> at the commit of main, GitLab gets the tag of that name from the script sent to the machine
    for (const repo of REPOS) {
      const post = r.calls.find((c) => c.tool === 'gh' && c.argv.includes('POST') && c.argv.includes(`repos/exafyltd/${repo}/git/refs`));
      assert.ok(post, `${repo}: a git/refs call`);
      assert.ok(post.argv.includes(`ref=refs/tags/delivery/cutover-${repo}`) && post.argv.includes(`sha=${SHA[repo]}`), `${repo}: ${post.argv.join(' ')}`);
    }
    const tagScripts = r.calls.filter((c) => c.argv[1] === 'send-command').map(scriptOf).filter((s) => /^# vitana-cutover: write tag$/m.test(s));
    assert.deepEqual(tagScripts.map((s) => s.match(/^REPO=(\S+)/m)[1]), REPOS);
    for (const s of tagScripts) assert.match(s, /TAG="delivery\/cutover-\$REPO"/);
    assert.equal(JSON.parse(saved[`${SM_PREFIX}/state`]).phase, 'complete');
    assert.equal(JSON.parse(saved[`${SM_PREFIX}/state`]).mirror_account, MIRROR);
    // what a cut never does
    const scripts = r.calls.filter((c) => c.argv[1] === 'send-command').map(scriptOf).join('\n');
    assert.equal(/AWS-PROD|publish|ecs update-service|supabase|psql|RUN-MIGRATION/i.test(scripts + r.stdout.replace(/AWS-PROD-\*|production/gi, '')), false, 'no production deploy and no database call');
    const curls = r.calls.filter((c) => c.tool === 'curl');
    assert.ok(curls.length >= 1 && curls.every((c) => c.argv.join(' ').includes('https://gateway.vitanaland.com/api/v1/ops/runtime/autopilot/kill-switch') && !c.argv.includes('-X')), 'the only call to production is the public, read-only health check of the kill switch');
    // secrets
    const blob = `${r.all}\n${fs.readFileSync(path.join(w.F, 'out.txt'), 'utf8')}`;
    for (const t of [GH_FIXTURE_TOKEN, AWS_FAKE_SECRET, AWS_FAKE_SESSION]) assert.equal(blob.includes(t), false, 'no token or credential in any output, argument or stdin');
  } finally {
    w.cleanup();
  }
});

test('apply: step 7 stops when DELIVERY_MODE of a project is not live after the sync, and no tag is made', () => withWorld((w) => {
  POST_CUT_KILL(w);
  w.flag('fail/mode-stuck');
  const r = w.run(APPLY);
  assert.equal(r.status, 1, r.all);
  assert.match(r.stdout, /== STEP 7 of 8/);
  assert.match(r.stdout, /DELIVERY_MODE of vitana\/vitana-platform is shadow, not live/);
  assert.match(r.stdout, /apply: STOPPED at step 7/);
  assert.equal(/== STEP 8/.test(r.stdout), false, 'step 8 never started');
  assert.equal(/armed:/.test(r.stdout), false);
  for (const repo of REPOS) assert.equal(w.get(`gh/${repo}/tag`), null, `${repo}: no tag`);
}));

test('apply: step 2 does not run the GitHub-to-GitLab copy when the cutover marker is already set (it would overwrite GitLab main with GitHub main)', () => withWorld((w) => {
  w.put('host/marker', '{"schema":"vitana.delivery-cutover-marker/v1","mode":"live","plan":"agentic-delivery","at":"2026-11-10T08:00:00Z"}\n');
  const r = w.run(APPLY);
  assert.equal(r.status, 1, r.all);
  assert.match(r.stdout, /== STEP 2 of 8/);
  assert.match(r.stdout, /the cutover marker is set: the GitHub-to-GitLab copy must never run after the cut/);
  assert.match(r.stdout, /apply: STOPPED at step 2/);
  assert.equal(ssmNames(r).includes('write mirror-final'), false, 'the copy was not started');
  assert.equal(w.get('host/unit/vitana-mirror.timer'), 'enabled/active', 'and its timer was not touched');
}));

test('apply: run again after the cut it does nothing: every step says already done, no state-changing call is made, exit 0', () => {
  const { w } = doneWorld();
  try {
    const r = w.run(APPLY);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /resuming a cut that this script started/);
    assert.equal((r.stdout.match(/^ {2}already done$/gm) ?? []).length + (r.stdout.match(/already done/g) ?? []).length >= 8, true);
    assert.deepEqual(writesBesidesLock(r), [], 'no state-changing call besides taking and releasing the lock');
    assert.deepEqual(writes(r).map((c) => c.argv[1]), ['create-secret', 'delete-secret'], 'the lock is taken and released');
    assert.equal(/== the checklist of plan section 8\.1/.test(r.stdout), false, 'the checklist is not asked again for a cut that started');
  } finally {
    w.cleanup();
  }
});

test('apply: waits for the owner at step 6 (exit 3), is resumed from step 6 when the switch is on, and a switch that is flipped during the wait lets one run finish', async () => {
  const waiting = await withWorld((w) => {
    const r = w.run(APPLY);
    assert.equal(r.status, 3, r.all);
    assert.match(r.stdout, /OWNER ACTION \(production control, plan B1\): in the Command Hub open Dev Autopilot and switch the kill switch ON/);
    assert.match(r.stdout, /the kill switch is still off after 30s: set it, then run this command again \(steps 1 to 5 are done and are skipped\)/);
    assert.match(r.stdout, /apply: STOPPED at step 6 \(exit 3\)\. Steps 1 to 5 are done/);
    assert.equal(w.get('gh/vitana-v1/tag'), null, 'no tag before the switch');
    assert.equal(JSON.parse(secrets(w)[`${SM_PREFIX}/state`]).phase, 'started');
    assert.deepEqual(unannounced(r), []);
    const sleeps = Number(w.get('ks.sleeps'));
    assert.equal(sleeps, 2, 'it polled the health check every 15 s for 30 s');
    w.put('killswitch', 'on');
    const again = w.run(APPLY);
    assert.equal(again.status, 0, again.all);
    assert.match(again.stdout, /resuming a cut that this script started/);
    assert.equal(writeKinds(again).filter((k) => k.includes('/disable')).length, 0, 'the resumed run disables no workflow again');
    assert.equal(writeKinds(again).filter((k) => k.includes('/protection')).length, 0);
    assert.equal(JSON.parse(secrets(w)[`${SM_PREFIX}/state`]).phase, 'complete');
    return true;
  });
  assert.equal(waiting, true);
  const live = doneWorld();
  try { assert.match(live.r.stdout, /OWNER ACTION/); assert.match(live.r.stdout, /the kill switch is on/); } finally { live.w.cleanup(); }
});

// ═════════════════════════════════════════ a step that fails leaves nothing half-done ═════════════════════════════════════════════
test('failure at step 1: the protection of the first repository is put back, the cut stops, and the next run (after the fix) finishes with the original protection still saved', async () => {
  await withWorld((w) => {
    w.flag('fail/protect.vitana-v1');
    POST_CUT_KILL(w);
    const r = w.run(APPLY);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stdout, /apply: STOPPED at step 1 \(exit 1\)\. Steps 1 to 0 are done|apply: STOPPED at step 1 \(exit 1\)/);
    assert.match(r.stdout, /UNDO: put the saved protection of GitHub main of vitana-platform back/);
    assert.match(r.stdout, /undone: the protection of vitana-platform is back as it was/);
    assert.deepEqual(unannounced(r), []);
    assert.deepEqual(JSON.parse(w.get('gh/vitana-platform/put.2.json')), RESTORE_BODY, 'the saved answer of GitHub became the body that restores it');
    assert.equal(protection(w, 'vitana-platform').restrictions, null);
    assert.equal(protection(w, 'vitana-platform').required_status_checks.strict, true);
    assert.equal(protection(w, 'vitana-v1').restrictions, null, 'the second repository was never changed');
    assert.equal(w.get('host/marker'), null, 'nothing after step 1 ran');
    assert.equal(JSON.parse(secrets(w)[`${SM_PREFIX}/state`]).phase, 'started');
    w.rm('fail/protect.vitana-v1');
    const again = w.run(APPLY);
    assert.equal(again.status, 0, again.all);
    assert.deepEqual(JSON.parse(secrets(w)[`${SM_PREFIX}/protection-vitana-platform`]), ORIGINAL_PROTECTION, 'the second run did not overwrite the saved protection with the one it made');
    assert.deepEqual(protection(w, 'vitana-platform').restrictions.users.map((u) => u.login), [MIRROR]);
  });
});

test('failure at step 2: a final copy that fails leaves the copy running and changes nothing else; at step 3: a sync that does not converge removes the marker again', async () => {
  await Promise.all([
    withWorld((w) => {
      w.flag('fail/mirror-final'); POST_CUT_KILL(w);
      const r = w.run(APPLY);
      assert.equal(r.status, 1, r.all);
      assert.match(r.stdout, /apply: STOPPED at step 2/);
      assert.equal(w.get('host/unit/vitana-mirror.timer'), 'enabled/active', 'the GitHub-to-GitLab copy keeps running');
      assert.equal(w.get('host/marker'), null);
      assert.deepEqual(wfState(w, 'vitana-v1')['PR-GATE.yml'], 'active');
      w.rm('fail/mirror-final');
      assert.equal(w.run(APPLY).status, 0);
    }),
    withWorld((w) => {
      w.flag('fail/converge'); POST_CUT_KILL(w);
      const r = w.run(APPLY);
      assert.equal(r.status, 1, r.all);
      assert.match(r.stdout, /apply: STOPPED at step 3 \(exit 1\)\. Steps 1 to 2 are done/);
      assert.match(r.stdout, /the settings sync did not converge \(sync exit 1, check exit 1\): removing the marker again/);
      assert.match(r.stdout, /UNDO: remove \/etc\/vitana\/delivery-cutover and run the settings sync again/);
      assert.equal(w.get('host/marker'), null, 'the marker is gone again');
      for (const repo of REPOS) assert.equal(w.get(`gitlab/${repo}.mode`).trim(), 'shadow');
      assert.deepEqual(ssmNames(r).filter((n) => n === 'write converge').length, 2, 'set, then removed');
      assert.equal(wfState(w, 'vitana-v1')['PR-GATE.yml'], 'active', 'no workflow was disabled');
      w.rm('fail/converge');
      assert.equal(w.run(APPLY).status, 0);
      assert.equal(JSON.parse(w.get('host/marker')).mode, 'live');
    }),
  ]);
});

test('failure at step 4: the workflows disabled in that step are enabled again, the cut stops, and the next run disables exactly the list', async () => {
  await withWorld((w) => {
    w.flag('fail/workflow.i18n-check.yml'); POST_CUT_KILL(w);
    const r = w.run(APPLY);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stdout, /apply: STOPPED at step 4 \(exit 1\)\. Steps 1 to 3 are done/);
    assert.match(r.stdout, /undone: the workflows disabled in this step are enabled again/);
    assert.deepEqual(unannounced(r), []);
    for (const repo of REPOS) assert.deepEqual(Object.values(wfState(w, repo)).filter((s) => s !== 'active'), [], `${repo}: every workflow is active again`);
    assert.ok(writeKinds(r).filter((k) => k.includes('/disable')).length > 0);
    assert.equal(w.get('host/unit/vitana-github-bridge.timer'), 'disabled/inactive', 'the bridge did not start');
    w.rm('fail/workflow.i18n-check.yml');
    const again = w.run(APPLY);
    assert.equal(again.status, 0, again.all);
    for (const repo of REPOS) assert.deepEqual(Object.entries(wfState(w, repo)).filter(([, s]) => s !== 'active').map(([f]) => f).sort(), DISABLE[repo]);
    assert.deepEqual(JSON.parse(secrets(w)[`${SM_PREFIX}/workflows-vitana-v1`]), DISABLE['vitana-v1']);
  });
});

test('failure at step 8: the tags made in that step are deleted again on both hosts', async () => {
  await withWorld((w) => {
    w.flag('fail/tag.vitana-v1'); POST_CUT_KILL(w);
    const r = w.run(APPLY);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stdout, /apply: STOPPED at step 8/);
    assert.match(r.stdout, /undone: the tags created in this step are deleted again/);
    for (const repo of REPOS) { assert.equal(w.get(`gh/${repo}/tag`), null, `${repo}: no GitHub tag`); assert.equal(w.get(`gitlab/${repo}.tag`), null, `${repo}: no GitLab tag`); }
    assert.deepEqual(unannounced(r), []);
    w.rm('fail/tag.vitana-v1');
    assert.equal(w.run(APPLY).status, 0);
    for (const repo of REPOS) assert.ok(w.get(`gh/${repo}/tag`) && w.get(`gitlab/${repo}.tag`));
  });
});

// ═════════════════════════════════════════ the way back: delivery-rollback.sh, plan §8.4 ═══════════════════════════════════════════════
const ROLLBACK = [ROLL, SLUG];
const rollbackBase = {};
function postCutWorld() {   // one cut, cloned for each rollback test (the clone is much cheaper than another cut)
  if (!rollbackBase.w) { const d = doneWorld(); rollbackBase.w = d.w; process.on('exit', () => d.w.cleanup()); }
  return cloneWorld(rollbackBase.w);
}

test('rollback: it reverses the cut in the order of plan §8.4, restores exactly what the cut changed, loses no commit, and prints every change first', () => {
  const w = postCutWorld();
  try {
    w.put('staging_delivery_host', 'None');
    const r = w.run(ROLLBACK);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /rollback: done\./);
    for (let n = 1; n <= 11; n += 1) assert.match(r.stdout, new RegExp(`== ROLLBACK STEP ${n} of 11: `));
    assert.deepEqual(unannounced(r), []);
    const order = [
      idxOf(r, unitWrite('stop', 'vitana-land.timer')), idxOf(r, ghWrite('/branches/main/protection')), idxOf(r, ghWrite('/enable')), idxOf(r, unitWrite('disable-now', 'vitana-github-bridge.timer')),
      idxOf(r, unitWrite('enable-now', 'vitana-mirror.timer')), idxOf(r, ssmWrite('converge')), idxOf(r, unitWrite('start', 'vitana-land.timer')), idxOf(r, ghWrite('/git/refs/tags/')),
    ];
    assert.ok(order.every((n) => n >= 0), `the calls exist: ${order}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'stop landing, restore protection, enable workflows, stop the bridge, restart the copy, remove the marker, start the bot, delete the tags');
    for (const repo of REPOS) {
      assert.deepEqual(JSON.parse(w.get(`gh/${repo}/put.2.json`)), RESTORE_BODY, `${repo}: the protection is put back as it was`);
      const p = protection(w, repo);
      assert.equal(p.restrictions, null);
      assert.equal(p.required_status_checks.strict, true);
      assert.deepEqual(Object.values(wfState(w, repo)).filter((s) => s !== 'active'), [], `${repo}: every workflow is active again`);
      assert.equal(w.get(`gh/${repo}/tag`), null);
      assert.equal(w.get(`gitlab/${repo}.tag`), null);
      assert.equal(w.get(`gitlab/${repo}.mode`), 'shadow');
    }
    assert.equal(w.get('host/marker'), null);
    assert.equal(w.get('host/unit/vitana-github-bridge.timer'), 'disabled/inactive');
    assert.equal(w.get('host/unit/vitana-mirror.timer'), 'enabled/active');
    assert.equal(w.get('host/unit/vitana-land.timer'), 'enabled/active');
    assert.match(r.stdout, /OWNER ACTION \(production control\): the Dev Autopilot kill switch is ON\. Switch it off in the Command Hub/);
    assert.match(r.stdout, /the staging gateway carries no cut setting \(no DELIVERY_HOST_\* is gitlab on \S+\): nothing to redeploy/);
    assert.equal(JSON.parse(secrets(w)[`${SM_PREFIX}/state`]).phase, 'rolled-back');
    assert.equal(r.calls.some((c) => c.tool === 'gh' && c.argv[0] === 'workflow'), false);
    assert.equal(r.calls.filter((c) => c.tool === 'curl').every((c) => !c.argv.includes('-X')), true, 'production is only read');
    // a new cut after the way back starts from a clean checklist
    const again = w.run([CUT, 'apply', '--mirror-account', MIRROR]);
    assert.equal(again.status, 0, again.all);
    assert.match(again.stdout, /== the checklist of plan section 8\.1/, 'a rolled-back cut is not resumed: the checklist is asked again');
  } finally {
    w.cleanup();
  }
});

test('rollback: it enables again only the workflows the cut disabled; one that was already disabled before the cut stays disabled', () => {
  const w = newWorld();
  try {
    const pre = DISABLE['vitana-platform'].slice(0, 2);   // two workflows of the disable list that somebody had disabled before the cut
    const rows = w.get('gh/vitana-platform/workflows.tsv').split('\n').map((l) => (pre.some((f) => l.startsWith(`.github/workflows/${f}\t`)) ? l.replace(/\tactive$/, '\tdisabled_manually') : l)).join('\n');
    w.put('gh/vitana-platform/workflows.tsv', `${rows}\n`);
    POST_CUT_KILL(w);
    const cut = w.run(APPLY);
    assert.equal(cut.status, 0, cut.all);
    assert.deepEqual(JSON.parse(secrets(w)[`${SM_PREFIX}/workflows-vitana-platform`]), DISABLE['vitana-platform'].filter((f) => !pre.includes(f)), 'the saved list holds only what the cut disabled');
    assert.equal(cut.calls.filter((c) => ghWrite('/disable')(c) && c.argv.some((a) => pre.some((f) => a.includes(`/${f}/`)))).length, 0, 'the cut does not touch a workflow that was disabled already');
    w.put('staging_delivery_host', 'None');
    const r = w.run(ROLLBACK);
    assert.equal(r.status, 0, r.all);
    const st = wfState(w, 'vitana-platform');
    for (const f of pre) assert.equal(st[f], 'disabled_manually', `${f} stays disabled`);
    assert.deepEqual(Object.entries(st).filter(([f, s]) => s !== 'active' && !pre.includes(f)), [], 'every other workflow is active again');
    assert.equal(r.calls.filter(ghWrite('/enable')).length, DISABLE['vitana-platform'].length - pre.length + DISABLE['vitana-v1'].length, 'one enable call for each workflow the cut disabled');
  } finally {
    w.cleanup();
  }
});

test('rollback: a staging gateway that still carries the cut settings is redeployed through the GitHub path; without the slug or with --dry-run nothing is changed', async () => {
  const [withSettings, dry] = [postCutWorld(), postCutWorld()];
  try {
    withSettings.put('staging_delivery_host', 'gitlab');
    withSettings.flag('redeploy_clears_env');   // a redeploy that does remove DELIVERY_HOST_* (the lasting fix of the workflow, another lane)
    const r = withSettings.run(ROLLBACK);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /AWS-STAGE-DEPLOY-GATEWAY\.yml ran on main and succeeded/);
    assert.match(r.stdout, /the staging gateway \(\S+\) carries no cut setting any more/);
    assert.match(r.stdout, /CHANGE: dispatch AWS-STAGE-DEPLOY-GATEWAY\.yml on main so that the staging gateway loses the cut settings/);
    const run = r.calls.find((c) => c.tool === 'gh' && c.argv[0] === 'workflow');
    assert.deepEqual(run.argv, ['workflow', 'run', 'AWS-STAGE-DEPLOY-GATEWAY.yml', '-R', 'exafyltd/vitana-platform', '--ref', 'main']);
    assert.ok(idxOf(r, (c) => c === run) > idxOf(r, ghWrite('/enable')), 'the workflow is enabled again before it is dispatched');
    for (const argv of [[ROLL], [ROLL, SLUG, '--dry-run']]) {
      const d = dry.run(argv);
      assert.equal(d.status, 0, d.all);
      assert.match(d.stdout, /rollback: DRY RUN: nothing will be changed/);
      assert.deepEqual(writes(d), []);
      assert.match(d.stdout, /WOULD: restore the protection of GitHub main of vitana-v1/);
      assert.match(d.stdout, /rollback: dry run finished, nothing was changed/);
    }
    assert.equal(dry.run([ROLL, 'other-plan']).status, 2);
    assert.equal(dry.run([ROLL, SLUG, '--nope']).status, 2);
  } finally {
    withSettings.cleanup(); dry.cleanup();
  }
});

test('rollback: it refuses while GitHub main is not GitLab main, and while branches exist only on GitLab, and restores nothing then', () => {
  const w = postCutWorld();
  try {
    w.put('gitlab/vitana-v1.main', '3333333333333333333333333333333333333333');
    let r = w.run(ROLLBACK);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /GitHub main of vitana-v1 \(222222222222\) is not GitLab main \(333333333333\) after 0 s: the push mirror has not copied it\. Nothing is restored/);
    assert.match(r.stdout, /rollback: STOPPED at step 2/);
    assert.equal(writeKinds(r).some((k) => k.includes('/protection') || k.includes('/enable')), false, 'no protection or workflow was restored');
    assert.deepEqual(wfState(w, 'vitana-v1')['PR-GATE.yml'], 'disabled_manually');
    w.put('gitlab/vitana-v1.main', SHA['vitana-v1']);
    w.put('gitlab/vitana-v1.branches', 'main\nkiro/a\nkiro/b\nkiro/only-on-gitlab\n');
    r = w.run(ROLLBACK);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /branches that exist only on GitLab \(vitana-v1\): kiro\/only-on-gitlab/);
    assert.match(r.stdout, /run again with --confirm-prune-gitlab-only-branches to let them go/);
    assert.equal(writeKinds(r).some((k) => k.includes('/protection')), false);
    r = w.run([...ROLLBACK, '--confirm-prune-gitlab-only-branches']);
    assert.equal(r.status, 0, r.all);
    assert.equal(protection(w, 'vitana-v1').restrictions, null);
  } finally {
    w.cleanup();
  }
});

test('rollback: from a cut that stopped half way (the settings sync failed at step 3) it undoes what exists and skips the rest; a second rollback is harmless', async () => {
  await withWorld((w) => {
    w.flag('fail/converge');
    const cut = w.run(APPLY);
    assert.equal(cut.status, 1);
    w.rm('fail/converge');
    const r = w.run(ROLLBACK);
    assert.equal(r.status, 0, r.all);
    for (const repo of REPOS) assert.deepEqual(JSON.parse(w.get(`gh/${repo}/put.2.json`)), RESTORE_BODY);
    assert.match(r.stdout, /no saved list of disabled workflows, and no workflow of the disable list is disabled: nothing to enable/);
    assert.equal(w.get('host/unit/vitana-mirror.timer'), 'enabled/active', 'the copy that step 2 stopped runs again');
    assert.equal(JSON.parse(secrets(w)[`${SM_PREFIX}/state`]).phase, 'rolled-back');
    const twice = w.run(ROLLBACK);
    assert.equal(twice.status, 0, twice.all);
    assert.deepEqual(unannounced(twice), []);
  });
});

// ═════════════════════════════════════════ the rehearsal, plan §8.1 step 5 ═══════════════════════════════════════════════════════════
test('rehearse: it needs --merges-paused, opens with the marker "rehearsal", waits (exit 3) until a live pipeline on main deployed and verified each repository, then closes and sends staging back to the GitHub path', async () => {
  await withWorld((w) => {
    w.rm('host/rehearsal.json');
    let r = w.run([CUT, 'rehearse']);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /give --merges-paused to confirm that merges are paused except the two rehearsal landings/);
    assert.deepEqual(writes(r), []);
    r = w.run([CUT, 'rehearse', '--merges-paused']);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /rehearse: OPEN\./);
    assert.deepEqual(unannounced(r), []);
    assert.equal(JSON.parse(w.get('host/marker')).mode, 'rehearsal');
    assert.equal(JSON.parse(w.get('host/rehearsal.json')).state, 'open');
    assert.equal(r.calls.some((c) => c.tool === 'gh' && c.argv[0] === 'workflow'), false);
    assert.equal(wfState(w, 'vitana-v1')['PR-GATE.yml'], 'active', 'the rehearsal disables no workflow and protects nothing');
    assert.equal(protection(w, 'vitana-v1').restrictions, null);
    // not yet
    r = w.run([CUT, 'rehearse']);
    assert.equal(r.status, 3);
    assert.match(r.stdout, /rehearse: not yet: no deploy-staging and staging-verify success since 2026-11-10T08:00:00Z for: vitana-platform vitana-v1/);
    assert.deepEqual(writes(r), []);
    // a deploy without a passed verification, and a verification without a deploy, are not the evidence
    w.put('pipelines/vitana-platform', 'deploy=1\nverify=0');
    w.put('pipelines/vitana-v1', 'deploy=0\nverify=1');
    r = w.run([CUT, 'rehearse']);
    assert.equal(r.status, 3);
    assert.match(r.stdout, /rehearse: not yet: .* for: vitana-platform vitana-v1/);
    assert.deepEqual(writes(r), []);
    w.put('pipelines/vitana-v1', 'deploy=0\nverify=0');
    // only one repository
    w.put('pipelines/vitana-platform', 'deploy=1\nverify=1');
    r = w.run([CUT, 'rehearse']);
    assert.equal(r.status, 3);
    assert.match(r.stdout, /vitana-platform: a live pipeline on main deployed to staging \(1 job\(s\)\) and STAGING-VERIFY passed \(1\)/);
    assert.match(r.stdout, /not yet: .* for: vitana-v1/);
    // both
    w.put('pipelines/vitana-v1', 'deploy=1\nverify=2');
    r = w.run([CUT, 'rehearse']);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /rehearse: PASSED/);
    assert.equal(w.get('host/marker'), null, 'the marker is removed again');
    assert.equal(JSON.parse(w.get('host/rehearsal.json')).state, 'passed');
    assert.deepEqual(r.calls.filter((c) => c.tool === 'gh' && c.argv[0] === 'workflow').map((c) => c.argv.slice(0, 5).join(' ')), ['workflow run AWS-STAGE-DEPLOY-GATEWAY.yml -R exafyltd/vitana-platform', 'workflow run AWS-STAGE-DEPLOY-FRONTEND.yml -R exafyltd/vitana-v1']);
    assert.deepEqual(unannounced(r), []);
    const st = w.run([CUT, 'status', '--item', 'rehearsal']);
    assert.equal(st.status, 0, st.all);
  });
});

test('rehearse --dry-run: opening, closing and aborting print every change as WOULD, make none, and claim no result', async () => {
  await withWorld((w) => {
    w.rm('host/rehearsal.json');
    let r = w.run([CUT, 'rehearse', '--merges-paused', '--dry-run']);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /WOULD: write \/etc\/vitana\/delivery-cutover with mode rehearsal/);
    assert.match(r.stdout, /WOULD: record the rehearsal as open in \/etc\/vitana\/delivery-rehearsal\.json/);
    assert.match(r.stdout, /rehearse: dry run finished, nothing was changed/);
    assert.equal(/rehearse: OPEN/.test(r.stdout), false, 'a dry run does not say it opened the rehearsal');
    assert.deepEqual(writes(r), []);
    assert.equal(w.get('host/marker'), null);
    assert.equal(w.get('host/rehearsal.json'), null);
    // open it for real, give the evidence, then look at closing and aborting as dry runs
    assert.equal(w.run([CUT, 'rehearse', '--merges-paused']).status, 0);
    w.put('pipelines/vitana-platform', 'deploy=1\nverify=1');
    w.put('pipelines/vitana-v1', 'deploy=1\nverify=1');
    r = w.run([CUT, 'rehearse', '--dry-run']);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /WOULD: remove the marker, run the settings sync \(back to shadow\) and record the rehearsal as passed/);
    assert.match(r.stdout, /WOULD: dispatch AWS-STAGE-DEPLOY-GATEWAY\.yml and AWS-STAGE-DEPLOY-FRONTEND\.yml/);
    assert.equal(/rehearse: PASSED/.test(r.stdout), false, 'a dry run does not say the rehearsal passed');
    assert.deepEqual(writes(r), []);
    assert.equal(JSON.parse(w.get('host/rehearsal.json')).state, 'open', 'still open');
    assert.equal(JSON.parse(w.get('host/marker')).mode, 'rehearsal', 'the marker is still there');
    r = w.run([CUT, 'rehearse', '--abort', '--dry-run']);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /WOULD: remove the marker, run the settings sync \(back to shadow\) and record the rehearsal as aborted/);
    assert.deepEqual(writes(r), []);
    assert.equal(JSON.parse(w.get('host/rehearsal.json')).state, 'open');
  });
});

test('rehearse: a red checklist blocks it, --abort closes an open rehearsal without a pass, and an aborted rehearsal is not a pass', async () => {
  await withWorld((w) => {
    w.rm('host/rehearsal.json');
    w.put('parity/vitana-v1', PARITY_OK.replace('unexplained=0', 'unexplained=1'));
    let r = w.run([CUT, 'rehearse', '--merges-paused']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /rehearse: refused, not green: shadow-parity/);
    assert.deepEqual(writes(r), []);
    w.put('parity/vitana-v1', PARITY_OK);
    assert.equal(w.run([CUT, 'rehearse', '--merges-paused']).status, 0);
    r = w.run([CUT, 'rehearse', '--abort']);
    assert.equal(r.status, 0, r.all);
    assert.equal(w.get('host/marker'), null);
    assert.equal(JSON.parse(w.get('host/rehearsal.json')).state, 'aborted');
    const st = w.run([CUT, 'status', '--item', 'rehearsal']);
    assert.equal(st.status, 1);
    assert.match(st.stdout, /state is aborted/);
    assert.match(w.run([CUT, 'rehearse', '--abort']).stdout, /no rehearsal is open/);
  });
});

// ═════════════════════════════════════════ what runs on the GitLab machine ═══════════════════════════════════════════════════════
const hasDash = spawnSync('sh', ['-c', 'command -v dash'], { encoding: 'utf8' }).status === 0;
function machineScripts() {
  const out = new Map();
  const add = (r) => { for (const c of r.calls) if (c.tool === 'aws' && c.argv[1] === 'send-command') { const s = scriptOf(c); out.set(s.split('\n').slice(0, 1)[0] + ' ' + s.length, s); } };
  const d = doneWorld();
  try {
    add(d.r);
    const rb = cloneWorld(d.w);
    try { add(rb.run(ROLLBACK)); } finally { rb.cleanup(); }
    const re = newWorld();
    try { re.rm('host/rehearsal.json'); add(re.run([CUT, 'rehearse', '--merges-paused'])); re.put('pipelines/vitana-platform', 'deploy=1\nverify=1'); re.put('pipelines/vitana-v1', 'deploy=1\nverify=1'); add(re.run([CUT, 'rehearse'])); } finally { re.cleanup(); }
  } finally {
    d.w.cleanup();
  }
  return [...out.values()];
}
test('machine scripts: every script sent to the GitLab machine starts with its read or write line, parses in plain sh, and names a token file only to test it or to feed it to curl through stdin', () => {
  const scripts = machineScripts();
  const kinds = new Set(scripts.map((s) => s.split('\n')[0].replace(/^# vitana-cutover: /, '')));
  for (const k of ['read probe', 'read parity', 'read bridge-dry-run', 'read gitlab-main', 'read variable', 'read pipelines', 'write converge', 'write unit', 'write mirror-final', 'write tag', 'write tag-delete', 'write rehearsal-record']) assert.ok(kinds.has(k), `a ${k} script was sent`);
  const T = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'dcut-sh-'));
  try {
    scripts.forEach((s, i) => {
      assert.match(s.split('\n')[0], /^# vitana-cutover: (read|write) [a-z-]+$/);
      const f = path.join(T, `s${i}.sh`);
      fs.writeFileSync(f, s);
      const r = spawnSync(hasDash ? 'dash' : 'sh', ['-n', f], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${s.split('\n')[0]}: ${r.stderr}`);
      for (const line of s.split('\n')) {
        if (!/\/etc\/vitana\/[a-z-]*token/.test(line)) continue;
        assert.ok(/stat -c|test -s|printf 'header = "PRIVATE-TOKEN: %s"\\n' "\$\(cat \/etc\/vitana\/[a-z-]+\)"|--token-file \/etc\/vitana\/[a-z-]+ 2>|for f in github-push-mirror-token/.test(line) || /^ {2}local|files=/.test(line) || /file_\$f/.test(line), `a token file is only tested or fed to curl: ${line.trim().slice(0, 120)}`);
      }
      assert.equal(/echo[^\n]*\$\(cat \/etc\/vitana\/[a-z-]*token/.test(s), false, 'no token is echoed');
      assert.equal(/curl[^\n]*(-H|--header)\b[^\n]*PRIVATE-TOKEN/.test(s), false, 'the token is not an argument of curl');
    });
  } finally {
    fs.rmSync(T, { recursive: true, force: true });
  }
});

function sandboxRun(script, { files = {}, bins = {}, env = {} } = {}) {
  const T = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'dcut-host-'));
  try {
    const etc = path.join(T, 'etc/vitana');
    fs.mkdirSync(etc, { recursive: true });
    fs.mkdirSync(path.join(T, 'bin'));
    for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(etc, n), c);
    const log = path.join(T, 'calls.log');
    fs.writeFileSync(log, '');
    const stub = (name, body) => fs.writeFileSync(path.join(T, 'bin', name), `#!/bin/bash\nprintf '%s %s\\n' "${name}" "$*" >> "${log}"\n[ -z "$STDIN_LOG" ] || { cat >> "${log}.stdin" 2>/dev/null || true; }\n${body}\n`, { mode: 0o755 });
    for (const [n, b] of Object.entries({ systemctl: 'exit 0', journalctl: 'echo \'{"event":"done","exit":0}\'', node: 'exit 0', sleep: 'exit 0', ...bins })) stub(n, b);
    const rewritten = script.replaceAll('/etc/vitana', etc).replaceAll('/opt/vitana/platform', path.join(T, 'checkout'));
    fs.mkdirSync(path.join(T, 'checkout'), { recursive: true });
    const r = spawnSync(hasDash ? 'dash' : 'sh', ['-c', rewritten], { encoding: 'utf8', env: { PATH: `${path.join(T, 'bin')}:/usr/bin:/bin`, ...env } });
    const snapshot = Object.fromEntries(fs.readdirSync(etc).map((n) => [n, fs.readFileSync(path.join(etc, n), 'utf8')]));
    return { ...r, etc, calls: fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean), read: (n) => snapshot[n] ?? null };
  } finally {
    fs.rmSync(T, { recursive: true, force: true });
  }
}
test('machine scripts, run for real in sh on stand-ins: the converge script writes and removes the marker and runs the two syncs; the unit script touches only the named units; the tag script feeds its token to curl through stdin', () => {
  const d = doneWorld();
  let scripts;
  try { scripts = Object.fromEntries(d.r.calls.filter((c) => c.argv[1] === 'send-command').map((c) => [marker(c).join(' ') + (scriptOf(c).match(/^(ACTION|MODE)=\S+/m)?.[0] ?? ''), scriptOf(c)])); } finally { d.w.cleanup(); }
  const converge = scripts['write convergeMODE=live'];
  let r = sandboxRun(converge, { files: { env: 'REGION=eu-central-1\n' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.read('delivery-cutover')).mode, 'live');
  assert.equal(JSON.parse(r.read('delivery-cutover')).schema, 'vitana.delivery-cutover-marker/v1');
  assert.match(r.stdout, /marker_written=1\nsync_exit=0\nsettings_exit=0/);
  assert.match(r.stdout, /check_exit=0$/m);
  assert.deepEqual(r.calls.filter((l) => l.startsWith('systemctl')), ['systemctl start vitana-platform-sync.service', 'systemctl start vitana-settings.service']);
  const none = Object.values(scripts).find((s) => /^MODE=none$/m.test(s)) ?? converge.replace('MODE=live', 'MODE=none');
  r = sandboxRun(none, { files: { 'delivery-cutover': '{}', env: 'REGION=x\n' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.read('delivery-cutover'), null, 'the marker is removed');
  const failing = sandboxRun(converge, { files: { env: 'x=1\n' }, bins: { systemctl: '[ "$2" = vitana-settings.service ] && exit 1; exit 0' } });
  assert.match(failing.stdout, /settings_exit=1/);
  // units: named units only, known actions only
  const unit = Object.entries(scripts).find(([k]) => k.startsWith('write unitACTION=enable-now'))[1];
  r = sandboxRun(unit);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.filter((l) => l.startsWith('systemctl enable')), ['systemctl enable --now vitana-github-bridge.timer']);
  for (const [bad, re] of [[unit.replace('vitana-github-bridge.timer', 'sshd.service'), /refused unit sshd\.service/], [unit.replace('ACTION=enable-now', 'ACTION=mask'), /refused action mask/]]) {
    const x = sandboxRun(bad);
    assert.equal(x.status, 1);
    assert.match(x.stdout, re);
    assert.equal(x.calls.filter((l) => /^systemctl (enable|disable|start|stop|mask)/.test(l)).length, 0, 'systemctl is not called for a refused unit or action');
  }
  // the tag: a token file goes to curl through stdin (--config -), never an argument
  const tag = Object.values(scripts).find((s) => /^# vitana-cutover: write tag$/m.test(s));
  r = sandboxRun(tag, { files: { 'bot-land-token': `${BOT_TOKEN}\n` }, bins: { curl: `cat >/dev/null; case "$*" in *"-X POST"*) echo '{"name":"delivery/cutover-vitana-v1"}' ;; *) echo '{"message":"404 Tag Not Found"}' ;; esac` } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /tag_state=created/);
  assert.equal(r.calls.filter((l) => l.startsWith('curl')).every((l) => /--config -/.test(l) && !l.includes(BOT_TOKEN)), true, 'curl takes its header from stdin');
  const sha = tag.match(/^SHA=(\S+)/m)[1];
  const exists = sandboxRun(tag, { files: { 'bot-land-token': `${BOT_TOKEN}\n` }, bins: { curl: `cat >/dev/null; echo '{"commit":{"id":"${sha}"}}'` } });
  assert.equal(exists.status, 0, exists.stderr + exists.stdout);
  assert.match(exists.stdout, /tag_state=exists/);
  assert.equal(exists.calls.some((l) => l.includes('-X POST')), false, 'an existing tag at the same commit is not created again');
  const other = sandboxRun(tag, { files: { 'bot-land-token': `${BOT_TOKEN}\n` }, bins: { curl: `cat >/dev/null; echo '{"commit":{"id":"0000000000000000000000000000000000000000"}}'` } });
  assert.equal(other.status, 1);
  assert.match(other.stdout, /tag_state=other:0000/);
});

// ═════════════════════════════════════════ the runbook and the pipeline runbooks (plan §8.2, task C4) ═════════════════════════════════
const RUNBOOK = fs.readFileSync(path.join(ROOT, 'infra', 'gitlab-engineering', 'RUNBOOK-cutover.md'), 'utf8');
const DRIVER = fs.readFileSync(path.join(ROOT, '.kiro', 'pipeline', 'driver.md'), 'utf8');
const LANE_LAND = fs.readFileSync(path.join(ROOT, '.kiro', 'pipeline', 'lane-land.md'), 'utf8');

test('runbook: every bash block parses, it explains every checklist item, shows the commands of the scripts and states the counts of the workflow list', () => {
  const blocks = [...RUNBOOK.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 5, 'the runbook has command blocks');
  blocks.forEach((b, i) => {
    const r = spawnSync('bash', ['-n'], { input: b, encoding: 'utf8' });
    assert.equal(r.status, 0, `block ${i + 1} does not parse: ${r.stderr}`);
  });
  const section = (n) => RUNBOOK.split(/^## /m).find((x) => x.startsWith(`${n}. `)) ?? '';
  for (const id of ITEM_IDS) assert.ok(section(4).includes(`\`${id}\``), `section 4 explains the status item ${id}`);
  for (const cmd of ['delivery-cutover.sh status', 'delivery-cutover.sh rehearse --merges-paused', 'delivery-cutover.sh apply agentic-delivery --mirror-account LOGIN --dry-run', 'delivery-cutover.sh apply agentic-delivery --mirror-account LOGIN', 'delivery-rollback.sh agentic-delivery', '--confirm-prune-gitlab-only-branches', 'delivery/cutover-vitana-platform', 'delivery/cutover-vitana-v1']) {
    assert.ok(RUNBOOK.includes(cmd), `the runbook shows ${cmd}`);
  }
  const all = Object.values(WORKFLOWS.repositories).flatMap((r) => Object.values(r.workflows));
  assert.ok(RUNBOOK.includes(`all ${all.length} workflows`), 'the number of workflows');
  assert.ok(RUNBOOK.includes(`${all.filter((e) => e.action === 'disable').length} \`disable\``) && RUNBOOK.includes(`${all.filter((e) => e.action === 'keep').length} \`keep\``), 'the disable and keep counts');
  for (let n = 1; n <= 8; n += 1) assert.match(section(6), new RegExp(`^\\| ${n} \\|`, 'm'), `the cut table (section 6) has a row for step ${n}`);
  const rolled = new Set([...section(8).matchAll(/^\| ([\d, ]+) \|/gm)].flatMap((m) => m[1].split(',').map((x) => Number(x.trim()))));
  for (let n = 1; n <= 11; n += 1) assert.ok(rolled.has(n), `the rollback table (section 8) has a row for step ${n}`);
  // owner step A3: exactly the two files that status item a3 and the settings file name, typed hidden, mode 600, never in an argument
  const a3 = blocks.find((b) => b.includes('github-bridge-token'));
  assert.ok(a3, 'a command block writes the token files');
  for (const f of ['github-push-mirror-token', 'github-bridge-token']) assert.ok(a3.includes(f) && RUNBOOK.includes(`/etc/vitana/${f}`), f);
  assert.match(a3, /read -rsp "paste the token/);
  assert.match(a3, /umask 077/);
  assert.match(a3, /printf "%s" "\$t" > "\$n" && mv "\$n" "\/etc\/vitana\/\$f"/, 'the token goes to a file from a variable, never to an argument');
  assert.equal(/echo "?\$t/.test(a3), false, 'the token is never echoed');
  assert.equal(/ghp_|github_pat_[A-Za-z0-9_]{10,}/.test(RUNBOOK), false, 'no token in the runbook');
});

test('pipeline runbooks: after the cut tag of a repository the merge bot lands and the driver waits for delivery.landed instead of merging; before the tag the merge flow is unchanged', () => {
  for (const [name, text] of [['driver.md', DRIVER], ['lane-land.md', LANE_LAND]]) {
    assert.match(text, /delivery\/cutover-<repo>/, `${name} names the cut tag`);
    assert.match(text, /git ls-remote --tags origin "refs\/tags\/delivery\/cutover-<repo>"/, `${name} says how to look for the tag`);
    assert.match(text, /merge bot/, name);
  }
  assert.match(DRIVER, /waits for `delivery\.landed`/);
  assert.match(DRIVER, /does not merge in that repository/);
  assert.match(DRIVER, /authority: merge bot \(plan agentic-delivery §3\.5\)/);
  assert.match(DRIVER, /never merge a pull request of a repository whose cut tag exists/);
  assert.match(LANE_LAND, /skip a–e/);
  assert.match(LANE_LAND, /merged_by: merge\s+bot/);
  // the tag the runbooks look for is the tag the script creates and the rollback deletes
  const cut = fs.readFileSync(CUT, 'utf8');
  assert.ok(cut.includes('refs/tags/delivery/cutover-$1') && cut.includes('git/ref/tags/delivery/cutover-$r') && cut.includes('git/refs/tags/delivery/cutover-$1'));
  // before the tag nothing changed: the §7b flow and the land guard are still the way
  assert.match(DRIVER, /Before the tag, steps 2 and 6 are as written\./);
  assert.match(DRIVER, /Land an accepted lane\*\* under the §7b merge rule/);
  assert.match(LANE_LAND, /land-guard\.mjs merge --gh/);
  assert.match(LANE_LAND, /with \*\*squash\*\* \(the subject keeps the PR title's VTID, which STAGING-VERIFY reads;/);
});

// ═════════════════════════════════════════ the findings B1 to B5 of the independent review of this lane ═══════════════════════════════════
const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const statePhase = (w) => JSON.parse(secrets(w)[`${SM_PREFIX}/state`]).phase;
const ANY_APP_PROTECTION = {
  ...ORIGINAL_PROTECTION,
  required_status_checks: { url: 'u', strict: false, contexts: ['validate', 'unit'], contexts_url: 'c', checks: [{ context: 'validate', app_id: null }, { context: 'unit', app_id: 15368 }] },
  required_pull_request_reviews: {
    ...ORIGINAL_PROTECTION.required_pull_request_reviews,
    dismissal_restrictions: { users: [{ login: 'lead' }], teams: [], apps: [] },
    bypass_pull_request_allowances: { users: [{ login: 'release-bot' }], teams: [{ slug: 'core' }], apps: [{ slug: 'deploy-app' }] },
  },
  restrictions: { url: 'u', users: [{ login: 'owner-user' }], teams: [{ slug: 'admins' }], apps: [] },
};
const ANY_APP_RESTORE = {
  required_status_checks: { strict: false, checks: [{ context: 'validate', app_id: -1 }, { context: 'unit', app_id: 15368 }] },
  enforce_admins: true,
  required_pull_request_reviews: {
    dismiss_stale_reviews: true, require_code_owner_reviews: false, required_approving_review_count: 1, require_last_push_approval: false,
    dismissal_restrictions: { users: ['lead'], teams: [], apps: [] }, bypass_pull_request_allowances: { users: ['release-bot'], teams: ['core'], apps: ['deploy-app'] },
  },
  restrictions: { users: ['owner-user'], teams: ['admins'], apps: [] },
  required_linear_history: true, allow_force_pushes: false, allow_deletions: false, block_creations: false, required_conversation_resolution: true, lock_branch: false, allow_fork_syncing: false,
};
const withProtection = (w, p) => { for (const r of REPOS) { w.put(`gh/${r}/protection.json`, JSON.stringify(p)); putSecret(w, `${SM_PREFIX}/roundtrip-${r}`, { result: 'passed', at: hours(2), protection: p }); } };
const restoreBody = (json) => {   // the restore body of the script itself, called by sourcing it (nothing runs on sourcing)
  const r = spawnSync('bash', ['-c', `. "${CUT}"; protection_restore_body`], { encoding: 'utf8', input: JSON.stringify(json), env: { PATH: '/usr/bin:/bin' } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test('B1: a backup write that Secrets Manager refuses, or one that reads back different, stops step 1 before that GitHub main is changed', async () => {
  for (const [label, flag, value] of [['write refused', 'fail/sm-write', 'protection-'], ['read back different', 'fail/sm-readback', 'protection-vitana-v1']]) {
    await withWorld((w) => {
      w.put(flag, value); POST_CUT_KILL(w);
      const r = w.run(APPLY);
      assert.equal(r.status, 1, `${label}: ${r.all}`);
      assert.match(r.stdout, /apply: STOPPED at step 1/, label);
      assert.match(r.stdout, /the protection of vitana-(platform|v1) is not saved, so GitHub main of vitana-(platform|v1) is not changed/, label);
      assert.equal(w.get('gh/vitana-v1/put.n'), null, `${label}: the lock of vitana-v1 was never sent`);
      for (const repo of REPOS) assert.equal(protection(w, repo).restrictions, null, `${label}: ${repo} is not locked`);
      assert.equal(w.get('host/marker'), null);
      assert.deepEqual(unannounced(r), []);
    });
  }
});

test('B1: the record of a started cut, and the list of step 4, are read back too: a write that fails stops apply before the change they protect', async () => {
  await withWorld((w) => {
    w.put('fail/sm-write', 'delivery-cutover__state');
    const r = w.run(APPLY);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stdout, /the start of the cut could not be recorded, so nothing is changed on GitHub or GitLab/);
    assert.equal(/== STEP 1/.test(r.stdout), false);
    assert.deepEqual(writesBesidesLock(r).filter((c) => !c.argv.includes(`${SM_PREFIX}/state`)), [], 'only the refused write of the record');
  });
  await withWorld((w) => {
    w.put('fail/sm-write', 'workflows-vitana-v1'); POST_CUT_KILL(w);
    const r = w.run(APPLY);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stdout, /apply: STOPPED at step 4/);
    assert.match(r.stdout, /the list is not saved, so no workflow of vitana-v1 is disabled/);
    assert.match(r.stdout, /undone: the workflows disabled in this step are enabled again/);
    for (const repo of REPOS) assert.deepEqual(Object.values(wfState(w, repo)).filter((s) => s !== 'active'), [], `${repo}: every workflow is active`);
    assert.deepEqual(unannounced(r), []);
  });
});

test('B1: a 502 on the protection GET stops step 1 and saves nothing; only GitHub\'s 404 "Branch not protected" counts as no protection, and it is restored by a DELETE', async () => {
  await withWorld((w) => {
    putState(w, 'started', hours(1));   // a cut that is resumed: no checklist (whose round-trip item would see the 502 first), straight to step 1
    w.flag('fail/protection-get.vitana-platform'); POST_CUT_KILL(w);
    let r = w.run(APPLY);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stdout, /GitHub did not answer for the protection of main of vitana-platform \(.*HTTP 502.*\): it cannot be saved, so GitHub main of vitana-platform is not changed/);
    assert.equal(secrets(w)[`${SM_PREFIX}/protection-vitana-platform`], undefined, 'no {"absent":true} is saved for a 502');
    assert.equal(r.calls.some(ghWrite('/branches/main/protection')), false);
    w.rm('fail/protection-get.vitana-platform');
    w.flag('fail/protection-404-other.vitana-v1');   // a 404 that is not "Branch not protected"
    r = w.run(APPLY);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stdout, /GitHub did not answer for the protection of main of vitana-v1 \(.*Not Found/);
    assert.equal(secrets(w)[`${SM_PREFIX}/protection-vitana-v1`], undefined);
    assert.equal(protection(w, 'vitana-platform').restrictions, null, 'the lock of vitana-platform made in that run is undone');
    assert.match(r.stdout, /undone: the protection of vitana-platform is back as it was/);
  });
  await withWorld((w) => {
    w.rm('gh/vitana-v1/protection.json');
    putSecret(w, `${SM_PREFIX}/roundtrip-vitana-v1`, { result: 'passed', at: hours(1), protection: { absent: true } });
    POST_CUT_KILL(w);
    const cut = w.run(APPLY);
    assert.equal(cut.status, 0, cut.all);
    assert.deepEqual(JSON.parse(secrets(w)[`${SM_PREFIX}/protection-vitana-v1`]), { absent: true });
    const rb = w.run(ROLLBACK);
    assert.equal(rb.status, 0, rb.all);
    assert.equal(w.get('gh/vitana-v1/protection.json'), null, 'main of vitana-v1 has no protection again, as before the cut');
    assert.ok(rb.calls.some((c) => c.tool === 'gh' && c.argv.includes('DELETE') && c.argv.includes('repos/exafyltd/vitana-v1/branches/main/protection')));
  });
});

test('B1: a rollback whose protection backup is deleted or cannot be read exits 1 with the manual instruction, never says done, and leaves GitHub main locked', () => {
  for (const [label, setup, re] of [
    ['deleted', (w) => w.rm(smKey(`${SM_PREFIX}/protection-vitana-platform`)), /no saved protection for vitana-platform \(.*does not exist\): it cannot be restored by this script/],
    ['unreadable', (w) => w.put('fail/sm-read', 'protection-vitana-platform'), /the saved protection of vitana-platform cannot be read \(.*AccessDeniedException.*\): nothing was restored/],
  ]) {
    const w = postCutWorld();
    try {
      setup(w);
      const r = w.run(ROLLBACK);
      assert.equal(r.status, 1, `${label}: ${r.all}`);
      assert.match(r.stdout, re, label);
      assert.match(r.stdout, /MANUAL \(owner\): in GitHub open exafyltd\/vitana-platform, Settings, Branches/, label);
      assert.match(r.stdout, /rollback: STOPPED at step 3/, label);
      assert.equal(/rollback: done/.test(r.stdout), false, label);
      assert.deepEqual(protection(w, 'vitana-platform').restrictions.users.map((u) => u.login), [MIRROR], `${label}: still locked, and the run says so`);
      assert.equal(statePhase(w), 'rolling-back', label);
    } finally {
      w.cleanup();
    }
  }
});

test('B1: when step 1 cannot put a protection back it says NOT undone, never "undone"', () => withWorld((w) => {
  w.put('fail/protect-after.vitana-platform', '1');   // the lock of vitana-platform is taken, its restore is refused
  w.flag('fail/protect.vitana-v1');
  const r = w.run(APPLY);
  assert.equal(r.status, 1, r.all);
  assert.match(r.stdout, /UNDO: put the saved protection of GitHub main of vitana-platform back/);
  assert.match(r.stdout, /GitHub refused the restore of the protection of main of vitana-platform/);
  assert.match(r.stdout, /NOT undone: GitHub main of vitana-platform is still restricted to vitana-gitlab-mirror/);
  assert.equal(/^undone: the protection/m.test(r.stdout), false);
}));

test('B1: rollback step 4 without its saved list exits 1 with the manual instruction while workflows of the disable list are disabled; an unreadable list stops it too', () => {
  const w = postCutWorld();
  try {
    w.rm(smKey(`${SM_PREFIX}/workflows-vitana-v1`));
    let r = w.run(ROLLBACK);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stdout, /vitana-v1: no saved list of disabled workflows \(.*does not exist\), but these workflows of the disable list are disabled: /);
    assert.match(r.stdout, /MANUAL \(owner\): enable the ones the cut disabled/);
    assert.match(r.stdout, /rollback: STOPPED at step 4/);
    w.put('fail/sm-read', 'workflows-vitana-platform');
    r = w.run(ROLLBACK);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stdout, /the saved list vitana\/engineering\/gitlab\/delivery-cutover\/workflows-vitana-platform cannot be read/);
  } finally {
    w.cleanup();
  }
});

test('B2: a second rollback after a good one restores no protection and enables no workflow, even when the team changed both since; only disabled_manually workflows of the list are enabled', () => {
  const w = postCutWorld();
  try {
    const odd = DISABLE['vitana-platform'][3];
    w.put('gh/vitana-platform/workflows.tsv', `${w.get('gh/vitana-platform/workflows.tsv').replace(`${odd}\tdisabled_manually`, `${odd}\tdisabled_inactivity`)}\n`);
    const first = w.run(ROLLBACK);
    assert.equal(first.status, 0, first.all);
    assert.match(first.stdout, new RegExp(`vitana-platform/${odd.replace(/\./g, '\\.')} is disabled_inactivity: left as it is`));
    assert.equal(wfState(w, 'vitana-platform')[odd], 'disabled_inactivity', 'a workflow GitHub disabled for inactivity is not enabled');
    const changed = { ...ORIGINAL_PROTECTION, required_status_checks: { ...ORIGINAL_PROTECTION.required_status_checks, contexts: ['validate', 'new-required-check'], checks: [{ context: 'validate', app_id: 15368 }, { context: 'new-required-check', app_id: 15368 }] } };
    for (const repo of REPOS) w.put(`gh/${repo}/protection.json`, JSON.stringify(changed));
    const f = DISABLE['vitana-v1'][0];
    w.put('gh/vitana-v1/workflows.tsv', `${w.get('gh/vitana-v1/workflows.tsv').replace(`${f}\tactive`, `${f}\tdisabled_manually`)}\n`);
    const r = w.run(ROLLBACK);
    assert.equal(r.status, 0, r.all);
    assert.equal(r.calls.some(ghWrite('/branches/main/protection')), false, 'no protection is written');
    assert.equal(r.calls.some(ghWrite('/enable')), false, 'no workflow is enabled');
    for (const repo of REPOS) assert.deepEqual(protection(w, repo), changed, `${repo}: the protection the team set stays`);
    assert.equal(wfState(w, 'vitana-v1')[f], 'disabled_manually', 'a workflow disabled on purpose since stays disabled');
    assert.match(r.stdout, /GitHub main is not restricted to vitana-gitlab-mirror any more \(restored already, or changed since\): left as it is/);
    assert.match(r.stdout, /an earlier rollback finished: the workflows are left as they are/);
  } finally {
    w.cleanup();
  }
});

test('B2: the rollback records rolling-back before its first change; apply refuses to resume such a cut; the next rollback continues and finishes it', () => {
  const w = postCutWorld();
  try {
    w.put('gitlab/vitana-v1.main', '3333333333333333333333333333333333333333');
    const r = w.run(ROLLBACK);
    assert.equal(r.status, 1, r.all);
    const first = writesBesidesLock(r)[0];
    assert.ok(first && first.argv.includes(`${SM_PREFIX}/state`) && first.stdin.includes('"phase":"rolling-back"'), `the first change is the record: ${first?.argv.join(' ')}`);
    assert.ok(idxOf(r, (c) => c === first) < idxOf(r, unitWrite('stop', 'vitana-land.timer')), 'before rollback step 1');
    assert.equal(statePhase(w), 'rolling-back');
    assert.equal(JSON.parse(secrets(w)[`${SM_PREFIX}/state`]).mirror_account, MIRROR, 'the mirror account of the cut is kept for the next rollback');
    const a = w.run(APPLY);
    assert.equal(a.status, 1, a.all);
    assert.match(a.stdout, /apply: refused: a rollback started at \S+ and has not finished/);
    assert.deepEqual(writes(a), [], 'apply changes nothing');
    w.put('gitlab/vitana-v1.main', SHA['vitana-v1']);
    const again = w.run(ROLLBACK);
    assert.equal(again.status, 0, again.all);
    assert.match(again.stdout, /an earlier rollback started at \S+ and did not finish: it is continued/);
    assert.equal(statePhase(w), 'rolled-back');
    assert.equal(protection(w, 'vitana-v1').restrictions, null);
  } finally {
    w.cleanup();
  }
});

test('B2: apply resumes a started cut only within 24 hours; an older record needs the checklist green again; the saved protection is kept; another mirror account is refused', () => withWorld((w) => {
  w.flag('fail/protect.vitana-platform');   // the cut starts and stops at step 1 with nothing changed on GitHub
  const first = w.run(APPLY);
  assert.equal(first.status, 1, first.all);
  assert.equal(statePhase(w), 'started');
  w.rm('fail/protect.vitana-platform');
  const saved = secrets(w)[`${SM_PREFIX}/protection-vitana-platform`];
  w.put('gh/permission.other-mirror', 'write\n');
  let r = w.run([CUT, 'apply', SLUG, '--mirror-account', 'other-mirror']);
  assert.equal(r.status, 1, r.all);
  assert.match(r.stdout, /the recorded cut uses the mirror account vitana-gitlab-mirror, not other-mirror/);
  putState(w, 'started', hours(30));
  w.put('parity/vitana-v1', PARITY_OK.replace('unexplained=0', 'unexplained=3'));
  r = w.run(APPLY);
  assert.equal(r.status, 1, r.all);
  assert.match(r.stdout, /older than 24 hours: it is resumed only after the checklist is green again/);
  assert.match(r.stdout, /Make the checklist green to resume the old cut, or roll it back: bash scripts\/eng\/delivery-rollback\.sh agentic-delivery/);
  assert.deepEqual(writes(r), []);
  w.put('parity/vitana-v1', PARITY_OK);
  POST_CUT_KILL(w);
  r = w.run(APPLY);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /== the checklist of plan section 8\.1/);
  assert.match(r.stdout, /\(already saved by this cut, read back\)/);
  assert.equal(secrets(w)[`${SM_PREFIX}/protection-vitana-platform`], saved, 'the backup of the old cut is not overwritten');
  assert.equal(statePhase(w), 'complete');
}));

test('B2: a lock keeps runs apart: apply, rehearse and the rollback refuse while it exists; --break-lock clears only a lock older than 6 hours; a run releases its lock', () => withWorld((w) => {
  POST_CUT_KILL(w);
  putSecret(w, LOCK, { holder: 'rollback', at: hours(1) });
  let r = w.run(APPLY);
  assert.equal(r.status, 1, r.all);
  assert.match(r.stdout, /CHANGE: take the lock vitana\/engineering\/gitlab\/delivery-cutover\/lock/);
  assert.match(r.stdout, /another run holds the lock \S+: rollback since \S+ \(\d+ s ago\)/);
  assert.match(r.stdout, /run the same command with --break-lock/);
  assert.equal(/== STEP 1/.test(r.stdout), false);
  assert.deepEqual(writesBesidesLock(r), []);
  r = w.run([...APPLY, '--break-lock']);
  assert.equal(r.status, 1, r.all);
  assert.match(r.stdout, /--break-lock clears only a lock older than 6 hours/);
  assert.ok(secrets(w)[LOCK], 'a young lock is kept');
  r = w.run(ROLLBACK);
  assert.equal(r.status, 1, r.all);
  assert.match(r.stdout, /another run holds the lock/);
  assert.deepEqual(writesBesidesLock(r), []);
  w.rm('host/rehearsal.json');
  r = w.run([CUT, 'rehearse', '--merges-paused']);
  assert.equal(r.status, 1, r.all);
  assert.match(r.stdout, /another run holds the lock/);
  assert.equal(w.get('host/marker'), null);
  w.put('host/rehearsal.json', JSON.stringify({ state: 'passed', started_at: hours(50), finished_at: hours(48) }));
  putSecret(w, LOCK, { holder: 'apply', at: hours(7) });
  assert.equal(w.run(APPLY).status, 1, 'a stale lock is not cleared without --break-lock');
  r = w.run([...APPLY, '--break-lock']);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /CHANGE: delete the stale lock \S+ \(older than 6 hours, --break-lock\) and take it/);
  assert.match(r.stdout, /CHANGE: release the lock/);
  assert.equal(secrets(w)[LOCK], undefined, 'the lock is released at the end');
  assert.deepEqual(unannounced(r), []);
}));

test('B3: the restore body carries bypass allowances and dismissal restrictions, sends a null app_id as -1, and gives checks or contexts, never both', () => {
  assert.deepEqual(restoreBody(ANY_APP_PROTECTION), ANY_APP_RESTORE);
  assert.deepEqual(restoreBody(ORIGINAL_PROTECTION), RESTORE_BODY);
  const ctxOnly = { ...ORIGINAL_PROTECTION, required_status_checks: { url: 'u', strict: true, contexts: ['ci/legacy'], contexts_url: 'c' } };
  assert.deepEqual(restoreBody(ctxOnly).required_status_checks, { strict: true, contexts: ['ci/legacy'] });
  for (const p of [ORIGINAL_PROTECTION, ANY_APP_PROTECTION]) {
    const rsc = restoreBody(p).required_status_checks;
    assert.equal('contexts' in rsc && 'checks' in rsc, false, 'never both');
    assert.ok(rsc.checks.every((c) => Number.isInteger(c.app_id)), 'app_id is always an integer');
  }
});

test('B3: a cut and its rollback restore a protection with bypass allowances and an any-app check through the documented schema, exactly', () => {
  const w = newWorld();
  try {
    withProtection(w, ANY_APP_PROTECTION);
    POST_CUT_KILL(w);
    const cut = w.run(APPLY);
    assert.equal(cut.status, 0, cut.all);
    const r = w.run(ROLLBACK);
    assert.equal(r.status, 0, r.all);
    for (const repo of REPOS) {
      assert.deepEqual(JSON.parse(w.get(`gh/${repo}/put.2.json`)), ANY_APP_RESTORE, `${repo}: the body of the restore`);
      const p = protection(w, repo);
      assert.deepEqual(p.required_pull_request_reviews.bypass_pull_request_allowances, ANY_APP_PROTECTION.required_pull_request_reviews.bypass_pull_request_allowances);
      assert.deepEqual(p.required_status_checks.checks, ANY_APP_PROTECTION.required_status_checks.checks);
      assert.deepEqual(restoreBody(p), ANY_APP_RESTORE, `${repo}: GitHub holds the protection of before the cut`);
    }
  } finally {
    w.cleanup();
  }
});

test('B3: rehearse first runs the round trip of the protection (PUT the restore body back, GET, compare) before the marker; the checklist item is green only on the protection of today', async () => {
  await withWorld((w) => {
    w.rm('host/rehearsal.json');
    for (const repo of REPOS) w.rm(smKey(`${SM_PREFIX}/roundtrip-${repo}`));
    let st = w.run([CUT, 'status', '--item', 'protection-roundtrip']);
    assert.equal(st.status, 1, st.all);
    assert.match(st.stdout, /vitana-platform:never-run vitana-v1:never-run/);
    const r = w.run([CUT, 'rehearse', '--merges-paused']);
    assert.equal(r.status, 0, r.all);
    assert.deepEqual(unannounced(r), []);
    assert.equal(r.calls.filter(ghWrite('/branches/main/protection')).length, 2, 'one PUT per repository');
    assert.ok(idxOf(r, ghWrite('/branches/main/protection')) < idxOf(r, ssmWrite('converge')), 'the round trip runs before the marker is written');
    for (const repo of REPOS) {
      assert.deepEqual(JSON.parse(w.get(`gh/${repo}/put.1.json`)), RESTORE_BODY, `${repo}: the body the rollback would send`);
      const rec = JSON.parse(secrets(w)[`${SM_PREFIX}/roundtrip-${repo}`]);
      assert.equal(rec.result, 'passed');
      assert.deepEqual(rec.protection, ORIGINAL_PROTECTION);
      assert.deepEqual(restoreBody(protection(w, repo)), RESTORE_BODY, `${repo}: the protection is as before`);
    }
    st = w.run([CUT, 'status', '--item', 'protection-roundtrip']);
    assert.equal(st.status, 0, st.all);
    w.put('gh/vitana-v1/protection.json', JSON.stringify({ ...ORIGINAL_PROTECTION, required_linear_history: { enabled: false } }));
    st = w.run([CUT, 'status', '--item', 'protection-roundtrip']);
    assert.equal(st.status, 1);
    assert.match(st.stdout, /vitana-v1:protection-changed-since/);
    const again = w.run([CUT, 'rehearse', '--protection-only']);
    assert.equal(again.status, 0, again.all);
    assert.match(again.stdout, /rehearse: the round trip of the protection passed for both repositories/);
    assert.equal(w.run([CUT, 'status', '--item', 'protection-roundtrip']).status, 0);
    const dry = w.run([CUT, 'rehearse', '--protection-only', '--dry-run']);
    assert.equal(dry.status, 0, dry.all);
    assert.deepEqual(writes(dry), []);
    assert.match(dry.stdout, /WOULD: round trip of the protection of GitHub main of vitana-v1/);
  });
  for (const [label, flag, re] of [['refused by GitHub', 'fail/protect.vitana-v1', /GitHub refused the restore body for vitana-v1/], ['read back different', 'fail/put-drift.vitana-v1', /the protection of main of vitana-v1 reads back different after the round trip/]]) {
    await withWorld((w) => {
      w.rm('host/rehearsal.json');
      w.flag(flag);
      const r = w.run([CUT, 'rehearse', '--merges-paused']);
      assert.equal(r.status, 1, `${label}: ${r.all}`);
      assert.match(r.stdout, re, label);
      assert.match(r.stdout, /rehearse: refused: the round trip of the protection failed, so the rehearsal does not open/, label);
      assert.equal(w.get('host/marker'), null, `${label}: no marker`);
      assert.equal(JSON.parse(secrets(w)[`${SM_PREFIX}/roundtrip-vitana-v1`]).result, 'failed', label);
      assert.deepEqual(unannounced(r), [], label);
      const st = w.run([CUT, 'status', '--item', 'protection-roundtrip']);
      assert.equal(st.status, 1, label);
      assert.match(st.stdout, /vitana-v1:failed/, label);
    });
  }
});

test('B4: the rollback refuses while a branch on both hosts has GitLab commits that GitHub lacks, lists it and restores nothing; a GitLab head that GitHub contains is fine', () => {
  const w = postCutWorld();
  try {
    const glHead = '4444444444444444444444444444444444444444';
    w.put('gitlab/vitana-v1.branches', `main\nkiro/a ${glHead}\nkiro/b\n`);
    let r = w.run(ROLLBACK);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stdout, /branches of vitana-v1 whose GitLab commits GitHub does not have: kiro\/a\(GitLab:444444444444,GitHub:[0-9a-f]{12}\)/);
    assert.match(r.stdout, /force-pushes every branch and would rewind them/);
    assert.match(r.stdout, /rollback: STOPPED at step 2/);
    assert.equal(writeKinds(r).some((k) => k.includes('/protection') || k.includes('/enable')), false, 'nothing is restored');
    assert.equal(w.get('host/unit/vitana-mirror.timer'), 'disabled/inactive', 'the copy is not restarted');
    assert.ok(r.calls.some((c) => c.tool === 'gh' && c.argv.includes(`repos/exafyltd/vitana-v1/compare/${glHead}...${sha1('kiro/a')}`)), 'GitHub is asked whether its head contains the GitLab head');
    r = w.run([...ROLLBACK, '--confirm-prune-gitlab-only-branches']);
    assert.equal(r.status, 1, 'the flag for GitLab-only branches does not let commits go');
    w.put('gh/vitana-v1/contains', `${sha1('kiro/a')} ${glHead}\n`);
    r = w.run(ROLLBACK);
    assert.equal(r.status, 0, r.all);
  } finally {
    w.cleanup();
  }
});

test('B4: the bot refs train/* and assist/* are left out of the GitLab-only check; a full 30th page of GitLab branches stops the rollback instead of being cut short', () => {
  const w = postCutWorld();
  try {
    w.put('gitlab/vitana-platform.branches', 'main\nkiro/a\nkiro/b\ntrain/17\nassist/42-i18n\n');
    w.flag('fail/gitlab-truncated.vitana-v1');
    let r = w.run(ROLLBACK);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stdout, /GitLab lists more than 3000 branches of vitana-v1 \(page 30 of 100 is full\)/);
    assert.equal(/branches that exist only on GitLab/.test(r.stdout), false, 'train/* and assist/* are not listed');
    w.rm('fail/gitlab-truncated.vitana-v1');
    r = w.run(ROLLBACK);
    assert.equal(r.status, 0, r.all);
    w.put('gitlab/vitana-v1.branches', 'main\nkiro/a\nkiro/b\nkiro/c\n');
    w.put('gh/vitana-v1/branches', 'main\nkiro/a\nkiro/b\n');
    r = w.run(ROLLBACK);
    assert.equal(r.status, 1, 'a real GitLab-only branch still needs the confirmation');
    assert.match(r.stdout, /branches that exist only on GitLab \(vitana-v1\): kiro\/c/);
  } finally {
    w.cleanup();
  }
});

test('B4: on the machine the GitLab branch listing prints every head, stops at a short page, and says truncated when page 30 is still full', () => {
  const w = postCutWorld();
  let script;
  try {
    const r = w.run([ROLL]);
    script = r.calls.filter((c) => c.argv[1] === 'send-command').map(scriptOf).find((s) => /^# vitana-cutover: read gitlab-main$/m.test(s));
  } finally {
    w.cleanup();
  }
  assert.ok(script, 'the rollback sends the listing script');
  const curl = (perPage) => `cat >/dev/null; case "$*" in *branches/main) echo '{"commit":{"id":"aaaa"}}' ;; *page=1|*page=2) jq -n '[range(${perPage}) | {name: "b\\(.)", commit: {id: "s\\(.)"}}]' ;; *) jq -n '[range(${perPage}) | {name: "c\\(.)", commit: {id: "t\\(.)"}}]' ;; esac`;
  const short = sandboxRun(script, { files: { 'bot-metrics-token': `${BOT_TOKEN}\n` }, bins: { curl: `cat >/dev/null; case "$*" in *branches/main) echo '{"commit":{"id":"aaaa"}}' ;; *page=1) jq -n '[{name: "main", commit: {id: "aaaa"}}, {name: "kiro/x", commit: {id: "bbbb"}}]' ;; *) echo '[]' ;; esac` } });
  assert.equal(short.status, 0, short.stderr);
  assert.match(short.stdout, /^main_sha=aaaa$/m);
  assert.match(short.stdout, /^truncated=0$/m);
  assert.match(short.stdout, /^branch=main aaaa$/m);
  assert.match(short.stdout, /^branch=kiro\/x bbbb$/m);
  assert.equal(short.calls.filter((l) => l.includes('repository/branches?')).length, 1, 'a short first page ends the listing');
  const full = sandboxRun(script, { files: { 'bot-metrics-token': `${BOT_TOKEN}\n` }, bins: { curl: curl(100) } });
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /^truncated=1$/m);
  assert.equal(full.calls.filter((l) => l.includes('repository/branches?')).length, 30, 'it stops at page 30');
  const exact = sandboxRun(script, { files: { 'bot-metrics-token': `${BOT_TOKEN}\n` }, bins: { curl: `cat >/dev/null; case "$*" in *branches/main) echo '{"commit":{"id":"aaaa"}}' ;; *page=1) jq -n '[range(100) | {name: "b\\(.)", commit: {id: "s"}}]' ;; *) echo '[]' ;; esac` } });
  assert.match(exact.stdout, /^truncated=0$/m, 'a full page followed by an empty one is complete');
});

test('B5: the rollback waits for the redeploy, reads the staging task definition again, and stops with the owner command while DELIVERY_HOST_* is still gitlab', () => {
  const w = postCutWorld();
  try {
    w.put('staging_delivery_host', 'gitlab');
    let r = w.run(ROLLBACK);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stdout, /AWS-STAGE-DEPLOY-GATEWAY\.yml ran on main and succeeded \(https:\/\/github\.com\/exafyltd\/vitana-platform\/actions\/runs\/\d+\)/);
    assert.match(r.stdout, /still carries the cut settings after the redeploy: DELIVERY_HOST_VITANA_PLATFORM=gitlab DELIVERY_HOST_VITANA_V1=gitlab/);
    assert.match(r.stdout, /OWNER ACTION: the GitHub redeploy keeps every variable it does not name/);
    assert.match(r.stdout, /startswith\("DELIVERY_HOST_"\) \| not/);
    assert.match(r.stdout, /aws ecs register-task-definition --cli-input-json file:\/\/td-without-cut\.json/);
    assert.match(r.stdout, /aws ecs update-service --cluster Vitana-ECS-Cluster --service vitana-gateway --task-definition "\$NEW"/);
    assert.match(r.stdout, /rollback: STOPPED at step 11/);
    assert.equal(/rollback: done/.test(r.stdout), false);
    assert.equal(statePhase(w), 'rolling-back');
    const described = r.calls.map((c, i) => [c, i]).filter(([c]) => c.tool === 'aws' && c.argv[1] === 'describe-task-definition').map(([, i]) => i);
    const dispatched = idxOf(r, (c) => c.tool === 'gh' && c.argv[0] === 'workflow');
    const waited = idxOf(r, (c) => c.tool === 'gh' && c.argv.some((a) => a.includes('/actions/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml/runs')));
    assert.equal(described.length, 2, 'the task definition is read before and after the redeploy');
    assert.ok(described[0] < dispatched && dispatched < waited && waited < described[1], 'read, dispatch, wait for the run, read again');
    assert.equal(r.calls.some((c) => c.tool === 'aws' && ['register-task-definition', 'update-service'].includes(c.argv[1])), false, 'the script never changes the task definition itself');
    w.put('staging_delivery_host', 'None');   // the owner ran the command
    r = w.run(ROLLBACK);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /rollback: done\./);
  } finally {
    w.cleanup();
  }
  const f = postCutWorld();
  try {
    f.put('staging_delivery_host', 'gitlab');
    f.flag('fail/redeploy.AWS-STAGE-DEPLOY-GATEWAY.yml');
    const r = f.run(ROLLBACK);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stdout, /AWS-STAGE-DEPLOY-GATEWAY\.yml ended failure/);
  } finally {
    f.cleanup();
  }
});

test('B5: closing the rehearsal waits for both staging redeploys and checks the gateway; with DELIVERY_HOST_* still gitlab the rehearsal stays open and the owner command is printed', () => withWorld((w) => {
  w.rm('host/rehearsal.json');
  assert.equal(w.run([CUT, 'rehearse', '--merges-paused']).status, 0);
  for (const repo of REPOS) w.put(`pipelines/${repo}`, 'deploy=1\nverify=1');
  w.put('staging_delivery_host', 'gitlab');
  let r = w.run([CUT, 'rehearse']);
  assert.equal(r.status, 1, r.all);
  assert.match(r.stdout, /AWS-STAGE-DEPLOY-GATEWAY\.yml ran on main and succeeded/);
  assert.match(r.stdout, /AWS-STAGE-DEPLOY-FRONTEND\.yml ran on main and succeeded/);
  assert.match(r.stdout, /aws ecs register-task-definition/);
  assert.match(r.stdout, /rehearse: not closed: staging is not back on the GitHub path yet\. The rehearsal stays open/);
  assert.equal(JSON.parse(w.get('host/rehearsal.json')).state, 'open', 'not recorded as passed');
  assert.equal(/rehearse: PASSED/.test(r.stdout), false);
  w.flag('redeploy_clears_env');
  r = w.run([CUT, 'rehearse']);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /rehearse: PASSED/);
  assert.equal(JSON.parse(w.get('host/rehearsal.json')).state, 'passed');
}));
