#!/usr/bin/env bash
# VTID-05784 (plan autonomous-to-staging-r2 §3.5, lane staging-migrations-auto; r1 plan §3.4): the steps of
# STAGING-MIGRATE.yml around scripts/aws/staging-db-apply-migration.sh. Staging cluster only (staging-db-common.sh
# sdb_check_cluster refuses anything else, the production cluster included, before any AWS call).
#
#   files --base <sha> --head <sha> [--repo <dir>]
#       The migration files ADDED between base and head (supabase/migrations/*.sql), in timestamp (file name) order,
#       one per line. No AWS call. Modified or deleted migration files are never re-applied (reported on stderr; the
#       drift check finds what they changed). Files in supabase/tests/local-stack/replay-skip.json are not applied:
#       the schema bundle the drift check compares against leaves them out too. base must be an ancestor of head.
#   snapshot --cluster <c> --id <c>-premig-<suffix>
#       Pre-apply cluster snapshot (rds:CreateDBClusterSnapshot, tag vitana-env=staging), waits until available.
#   compat --cluster <c>
#       Compatibility probe: every database object the STAGING-VERIFY gateway smoke reads
#       (scripts/ci/staging-db/build-schema.mjs SMOKE_OBJECTS) is still there and queryable. Runs through
#       staging-db-apply-migration.sh --read-only: one transaction, always rolled back.
#   quarantine-check --gh-repo <owner/name> --run-id <this run> [--acknowledge <run id>]
#       Machine quarantine: refuses (exit 1) while the newest earlier STAGING-MIGRATE run on main whose apply job ran
#       has that job failed, unless --acknowledge names exactly that run (a dispatch after the failure was handled).
#       Reads the GitHub API through gh (actions: read). No AWS call.
# Exit: 0 ok; 1 refused or failed; 2 usage.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck source=staging-db-common.sh
. "$HERE/staging-db-common.sh"
APPLY_JOB_NAME="Apply to the isolated staging database"
WORKFLOW_FILE="STAGING-MIGRATE.yml"

cmd="${1:-}"; [ $# -gt 0 ] && shift
BASE=""; HEAD=""; REPO="$REPO_ROOT"; CLUSTER=""; SNAP_ID=""; GH_REPO=""; RUN_ID=""; ACK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:-}"; shift 2 ;;
    --head) HEAD="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --gh-repo) GH_REPO="${2:-}"; shift 2 ;;
    --cluster) CLUSTER="${2:-}"; shift 2 ;;
    --id) SNAP_ID="${2:-}"; shift 2 ;;
    --run-id) RUN_ID="${2:-}"; shift 2 ;;
    --acknowledge) ACK="${2:-}"; shift 2 ;;
    *) sdb_usage "unknown argument: $1" ;;
  esac
done

files() {
  local sha_re='^[0-9a-f]{40}$'
  printf '%s' "$BASE" | grep -Eq "$sha_re" || sdb_usage "--base must be a full commit SHA"
  printf '%s' "$HEAD" | grep -Eq "$sha_re" || sdb_usage "--head must be a full commit SHA"
  [ "$BASE" != "0000000000000000000000000000000000000000" ] || sdb_die "no base commit (new branch push); dispatch with base_sha"
  git -C "$REPO" merge-base --is-ancestor "$BASE" "$HEAD" || sdb_die "base $BASE is not an ancestor of head $HEAD"
  local skips="$REPO/supabase/tests/local-stack/replay-skip.json" list
  list=$(git -C "$REPO" diff --name-status --no-renames "$BASE" "$HEAD" -- 'supabase/migrations/' | awk -F'\t' '
    $2 !~ /^supabase\/migrations\/[^\/]+\.sql$/ { next }
    $1 == "A" { print "A\t" $2; next }
    { print $1 "\t" $2 }')
  local st f name
  while IFS=$'\t' read -r st f; do
    [ -n "$f" ] || continue
    name="${f##*/}"
    if [ "$st" != A ]; then
      echo "not applied ($st, an existing migration is never re-applied; the drift check covers it): $f" >&2; continue
    fi
    if [ -f "$skips" ] && jq -e --arg n "$name" '.skips | any(.file == $n)' "$skips" > /dev/null; then
      echo "not applied (listed in replay-skip.json, left out of the staging schema bundle too): $f" >&2; continue
    fi
    printf '%s\t%s\n' "$name" "$f"
  done <<< "$list" | sort -t$'\t' -k1,1 | cut -f2
}

snapshot() {
  sdb_check_cluster "$CLUSTER"
  [ -n "$SNAP_ID" ] || sdb_usage "--id is required"
  printf '%s' "$SNAP_ID" | grep -Eq "^${CLUSTER}-premig-[a-z0-9]+(-[a-z0-9]+)*$" || sdb_die "snapshot id '$SNAP_ID' must be ${CLUSTER}-premig-<suffix>"
  [ "${#SNAP_ID}" -le 63 ] || sdb_die "snapshot id '$SNAP_ID' is longer than 63 characters"
  sdb_check_account
  aws rds create-db-cluster-snapshot --region "$SDB_REGION" --db-cluster-identifier "$CLUSTER" \
    --db-cluster-snapshot-identifier "$SNAP_ID" --tags Key=vitana-env,Value=staging > /dev/null \
    || sdb_die "create-db-cluster-snapshot $SNAP_ID failed; nothing was applied"
  aws rds wait db-cluster-snapshot-available --region "$SDB_REGION" --db-cluster-snapshot-identifier "$SNAP_ID" \
    || sdb_die "snapshot $SNAP_ID did not become available; nothing was applied"
  echo "$SNAP_ID"
}

compat() {
  sdb_check_cluster "$CLUSTER"
  local work probe
  work="$(mktemp -d)"; probe="$work/compat-probe.sql"
  node --input-type=module -e "
    import { SMOKE_OBJECTS } from '$REPO_ROOT/scripts/ci/staging-db/build-schema.mjs';
    const q = (s) => \"'\" + s.replace(/'/g, \"''\") + \"'\";
    const out = ['-- staging-db:compat-probe (VTID-05784): read-only, run in a transaction that is rolled back'];
    for (const o of SMOKE_OBJECTS) {
      if (o.kind === 'table') out.push('SELECT * FROM \"' + o.schema + '\".\"' + o.name + '\" LIMIT 0;');
      else out.push('DO \$p\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = ' + q(o.schema) + ' AND p.proname = ' + q(o.name) + ') THEN RAISE EXCEPTION ' + q('compat: missing ' + o.kind + ' ' + o.schema + '.' + o.name) + '; END IF; END \$p\$;');
    }
    process.stdout.write(out.join('\n') + '\n');
  " > "$probe" || { rm -rf "$work"; sdb_die "cannot build the compatibility probe"; }
  echo "Compatibility probe ($(grep -c ';$' "$probe") check(s)):"
  sed 's/^/  /' "$probe"
  if ! bash "$HERE/staging-db-apply-migration.sh" --cluster "$CLUSTER" --file "$probe" --read-only; then
    rm -rf "$work"; sdb_die "compatibility probe failed: an object the gateway reads is missing or not queryable"
  fi
  rm -rf "$work"
  echo "Compatibility probe passed"
}

quarantine_check() {
  [ -n "$GH_REPO" ] || sdb_usage "--gh-repo <owner/name> is required"
  printf '%s' "$RUN_ID" | grep -Eq '^[0-9]+$' || sdb_usage "--run-id must be a run id"
  [ -z "$ACK" ] || printf '%s' "$ACK" | grep -Eq '^[0-9]+$' || sdb_usage "--acknowledge must be a run id"
  local runs id concl
  runs=$(gh api "repos/$GH_REPO/actions/workflows/$WORKFLOW_FILE/runs?branch=main&status=completed&per_page=30" \
    --jq '.workflow_runs[] | select(.event == "push" or .event == "workflow_dispatch") | .id') \
    || sdb_die "cannot read earlier $WORKFLOW_FILE runs (fail closed)"
  for id in $runs; do
    [ "$id" != "$RUN_ID" ] || continue
    concl=$(gh api "repos/$GH_REPO/actions/runs/$id/jobs?per_page=100" \
      --jq "[.jobs[] | select(.name == \"$APPLY_JOB_NAME\") | .conclusion][0] // \"\"") \
      || sdb_die "cannot read the jobs of run $id (fail closed)"
    case "$concl" in
      success) echo "Not quarantined: the last apply (run $id) succeeded"; return 0 ;;
      failure|cancelled|timed_out)
        if [ "$ACK" = "$id" ]; then echo "Quarantine of run $id acknowledged by this dispatch"; return 0; fi
        sdb_die "quarantined: the apply of run $id ended '$concl'. Handle it (artifact staging-migrate-quarantine), then dispatch $WORKFLOW_FILE with acknowledge_quarantine_run=$id"
        ;;
      *) ;;  # apply skipped or absent in that run (disabled, nothing to apply): look further back
    esac
  done
  echo "Not quarantined: no earlier apply found"
}

case "$cmd" in
  files) files ;;
  snapshot) snapshot ;;
  compat) compat ;;
  quarantine-check) quarantine_check ;;
  *) sdb_usage "usage: $0 files|snapshot|compat|quarantine-check ..." ;;
esac
