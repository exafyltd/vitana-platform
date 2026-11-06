#!/usr/bin/env bash
# mt-guardrails-r2 / local-test-stack: load the synthetic fixtures
# (supabase/tests/fixtures/*.sql, filename order, one transaction per file)
# into the local stack. The fixtures are idempotent: running this twice leaves
# the same rows. Each fixture checks its tables with to_regclass: a missing
# required table (public.tenants, public.user_tenants, auth.users) fails the
# load; a missing optional table is skipped with a NOTICE.
set -euo pipefail

CONTAINER="${MT_STACK_CONTAINER:-mt-local-stack}"
DB_USER="${MT_STACK_DB_USER:-postgres}"
export PGPASSWORD="${POSTGRES_PASSWORD:-postgres}"

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
FIXTURES="$ROOT/supabase/tests/fixtures"

mapfile -t FILES < <(find "$FIXTURES" -mindepth 1 -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | LC_ALL=C sort)
[ "${#FILES[@]}" -gt 0 ] || { echo "seed.sh: no fixtures in $FIXTURES" >&2; exit 2; }

for name in "${FILES[@]}"; do
  echo "seed.sh: loading $name"
  docker exec -i -e PGPASSWORD "$CONTAINER" \
    psql -X -q -h 127.0.0.1 -U "$DB_USER" -d postgres \
      -v ON_ERROR_STOP=1 --single-transaction -f - < "$FIXTURES/$name"
done
echo "seed.sh: ${#FILES[@]} fixture file(s) loaded"
