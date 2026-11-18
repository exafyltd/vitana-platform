#!/usr/bin/env bash
# VTID-05803 staging migration: the stages around the DMS full load. Same execution path as schema-restore.sh
# (psql on the staging writer from the package task, STAGING_PGURI from the task's secrets, never printed).
#
#   STAGE=pre-load    after schema-restore.sh, BEFORE the DMS full load:
#                       scripts/aws/staging-db-vector-preload.sql  save and drop the public FKs, the views on vector
#                       columns and the vector indexes; vector columns as text. Public->auth FKs are kept out (R2).
#   (DMS)             the existing task vitana-fullload-final-catchup loads staging
#   STAGE=post-load   AFTER the DMS full load, in this order:
#                       1. scripts/aws/staging-db-vector-postload.sql  text back to vector, incomplete values kept
#                       2. scripts/aws/staging-db-restore-saved.sql    indexes, FKs (NOT VALID) and views back; R2 asserted
#                     then the embedding backfill (aurora-cutover-embedding-backfill.py --cluster vitana-aurora-staging)
#   STAGE=report      read-only: scripts/aws/staging-db-vector-report.sql, written to load-report.out
# Each SQL file runs in ONE transaction (psql --single-transaction, ON_ERROR_STOP): all or nothing, idempotent.
# The SQL is the same file the Data API path (scripts/aws/staging-db-migration.sh) applies.
# Exit: 0 ok; 1 refused (nothing written); 2 a file failed and was rolled back.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
WRITER="vitana-aurora-staging.cluster-cfk228aiedf3.eu-central-1.rds.amazonaws.com"
die()  { echo "REFUSED: $*" >&2; exit 1; }
redact() { R_URI="${STAGING_PGURI:-}" R_PW="${PW:-}" awk '{ u=ENVIRON["R_URI"]; p=ENVIRON["R_PW"]
  if (u != "") while ((i = index($0, u)) > 0) $0 = substr($0, 1, i-1) "<STAGING_PGURI>" substr($0, i+length(u))
  if (p != "") while ((i = index($0, p)) > 0) $0 = substr($0, 1, i-1) "<PW>" substr($0, i+length(p))
  print }'; }

STAGE="${STAGE:-}"
case "$STAGE" in
  pre-load)  FILES=(staging-db-vector-preload.sql) ;;
  post-load) FILES=(staging-db-vector-postload.sql staging-db-restore-saved.sql) ;;
  report)    FILES=() ;;
  *) die "STAGE must be pre-load, post-load or report (got '${STAGE}')" ;;
esac

# Inputs and target: the gate of schema-restore.sh (host from the URI only, the exact staging writer, database vitana).
[ -n "${STAGING_PGURI:-}" ] || die "STAGING_PGURI is not set"
command -v psql >/dev/null || die "psql not on PATH"
unset PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE PGDATABASE PGPORT
case "$STAGING_PGURI" in postgresql://*|postgres://*) ;; *) die "STAGING_PGURI must be a postgresql:// URI";; esac
REST="${STAGING_PGURI#*://}"; AUTH="${REST%%[/?]*}"; TAIL="${REST:${#AUTH}}"
PW=""; case "$AUTH" in *@*) UI="${AUTH%@*}"; case "$UI" in *:*) PW="${UI#*:}";; esac;; esac
HP="${AUTH##*@}"; HOST="$(printf '%s' "${HP%%:*}" | tr 'A-Z' 'a-z')"
P="${TAIL%%\?*}"; DB="${P#/}"; QS=""; case "$TAIL" in *\?*) QS="${TAIL#*\?}";; esac
case "$HP" in *,*) die "multi-host URI";; esac
case "&$QS" in *"&host="*|*"&hostaddr="*|*"&service="*|*"&dbname="*) die "URI overrides host/hostaddr/service/dbname";; esac
case "&$QS" in *"&sslmode=disable"*|*"&sslmode=allow"*|*"&sslmode=prefer"*) die "sslmode weaker than require";; esac
case "$HOST" in *prod*|*rehearsal*|*awsdr*|*supabase*|*pooler*) die "non-staging host name";; esac
[ "$HOST" = "$WRITER" ] || die "host is not the staging writer"
[ "$DB" = "vitana" ] || die "database is not 'vitana'"
export PGSSLMODE="${PGSSLMODE:-require}"; [ "$PGSSLMODE" = disable ] && die "PGSSLMODE=disable"
echo "LOAD_STAGES: $STAGE on the staging writer / vitana"

pq() { local e rc=0; e="$(mktemp)"; psql -X -d "$STAGING_PGURI" "$@" 2>"$e" || rc=$?; redact <"$e" >&2; rm -f "$e"; return $rc; }

n=0
for f in "${FILES[@]}"; do
  n=$((n+1))
  echo "STEP $STAGE $n/${#FILES[@]} $f"
  pq -q -v ON_ERROR_STOP=1 --single-transaction -f "$REPO/scripts/aws/$f" \
    || { echo "FAILED: $STAGE $n/${#FILES[@]} $f rolled back; earlier files stay applied (all are idempotent)" >&2; exit 2; }
  echo "OK $f"
done

if [ "$STAGE" != report ]; then echo "LOAD_STAGES: $STAGE done"; exit 0; fi
OUT="$HERE/load-report.out"; : > "$OUT"
awk -v dir="$(mktemp -d)" 'BEGIN{n=1} /^-- ;;$/{n++; next} /^--/{next} {f=dir "/q" n ".sql"; print > f} END{print dir}' \
  "$REPO/scripts/aws/staging-db-vector-report.sql" > "$OUT.dir"
QD="$(tail -1 "$OUT.dir")"; rm -f "$OUT.dir"
for q in "$QD"/q*.sql; do
  echo "----- $(basename "$q" .sql)" | tee -a "$OUT"
  pq -q -A -F '|' -v ON_ERROR_STOP=1 -c "BEGIN READ ONLY" -f "$q" -c "ROLLBACK" | tee -a "$OUT" \
    || { echo "FAILED: report query $(basename "$q")" >&2; exit 2; }
done
rm -rf "$QD"
echo "LOAD_STAGES: report written to load-report.out"
