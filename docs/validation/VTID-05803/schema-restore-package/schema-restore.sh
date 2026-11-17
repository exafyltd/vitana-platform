#!/usr/bin/env bash
# VTID-05803 — schema-only restore into the Aurora STAGING writer. NO member data is copied.
# Runs in a VPC task that provides PGHOST, PGUSER, PGPASSWORD (staging master). Refuses any other target. Stops at the first error.
# Executes the committed SQL in the documented order (sql/), then runs read-only parity probes against source-baseline.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; SQL="$HERE/sql"
: "${PGHOST:?PGHOST required}" "${PGUSER:?PGUSER required}" "${PGPASSWORD:?PGPASSWORD required}"
export PGDATABASE=vitana PGSSLMODE=require
# Gate 1 — target: exactly the staging writer. Production, rehearsal, DR and any other host are refused.
[ "$PGHOST" = "vitana-aurora-staging.cluster-cfk228aiedf3.eu-central-1.rds.amazonaws.com" ] || { echo "REFUSED: target $PGHOST is not the staging writer"; exit 1; }
case "$PGHOST" in *prod*|*rehearsal*|*awsdr*|*pooler.supabase*|*supabase.co*) echo "REFUSED: non-staging name"; exit 1;; esac
echo "gate 1 ok: $PGHOST / database $PGDATABASE"
# Gate 2 — the target must hold no public relations; this run never overwrites.
N=$(psql -X -At -c "select count(*) from information_schema.tables where table_schema='public'")
[ "$N" = "0" ] || { echo "REFUSED: public schema already has $N tables"; exit 1; }
echo "gate 2 ok: public tables = 0"
# Gate 3 — no executable SQL in the package may reference a production host or project.
if grep -v -E '^\s*--' "$SQL"/*.sql | grep -E 'inmkhvwdcuyhnxkgfvsb|aurora-prod|pooler\.supabase' | grep -v 'host-exclusion' >/dev/null; then echo "REFUSED: production reference in package SQL"; exit 1; fi
echo "gate 3 ok: no production reference in executable SQL"
# Gate 4 — integrity of the package.
( cd "$HERE" && sha256sum -c SHA256SUMS >/dev/null ) || { echo "REFUSED: package checksum mismatch"; exit 1; }
echo "gate 4 ok: package checksums"
# Approved staging extensions (schema-only; no data).
for E in vector pg_trgm unaccent fuzzystrmatch "uuid-ossp" pgcrypto pg_stat_statements; do psql -X -q -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS \"$E\""; done
echo "extensions ok"
run() { echo "== $1"; psql -X -q -v ON_ERROR_STOP=1 -f "$SQL/$1" >/dev/null; echo "   ok $1"; }
# Ordered restore (schema objects only)
run auth-helpers-production-definitions.sql
run aurora-auth-users-stub.sql
run aurora-cutover-auth-bridge.sql
run aurora-cutover-schema-sync.sql
run aurora-cutover-vector-preload.sql
run aurora-cutover-recreate-foreign-keys.sql
run aurora-auth-fk-restore.sql
run aurora-cutover-restore-grants.sql
run aurora-restore-rls-parity.sql
run outbox-table-and-helpers.sql
run outbox-replacement-staging-invalid-host.sql
run aurora-cutover-schema-sync-views.sql
# Post-check: no production reference in any function, view, policy, default, constraint, trigger or setting.
psql -X -q -At -f "$SQL/host-exclusion-check.sql" > "$HERE/host-exclusion.out"
awk -F'|' 'NF==2 && $2 ~ /^[0-9]+$/ {s+=$2} END {exit s!=0}' "$HERE/host-exclusion.out" || { echo "REFUSED: production reference after restore"; exit 1; }
echo "production host exclusion: clean"
# Parity against the source baseline (counts only). Every metric must equal the baseline, except the listed
# differences: the auth-scope consequence of the schema-only source (auth.users and its foreign keys are not restored),
# and the row estimate, which must be 0 on staging (no member data is copied).
psql -X -q -At -f "$SQL/parity-probe.sql" > "$HERE/target-counts.out"
python3 "$HERE/parity-compare.py" "$HERE/source-baseline-2026-11-17.txt" "$HERE/target-counts.out" || { echo "PARITY: unexplained mismatch"; exit 1; }
echo "schema-only restore finished; parity probes in target-counts.out"
