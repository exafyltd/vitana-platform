#!/bin/bash
# Run the VTID-05582 pgTAP file in PGlite (PostgreSQL 18 wasm) with a pgTAP-compatible shim.
#   lane.sh [--twice] [--no-migrations] [--only-columns] [<test.sql>]
#   --no-migrations = the RED proof (fixture only, as on origin/main); --only-columns loads 051000 but not 051100.
# Loads: the fixture (stand-ins for the v1 tables), then the REAL lane migrations, optionally twice (idempotence), then the test.
# Not the full production schema, no real pgTAP: CI's `supabase test db` stays authoritative.
H=$(cd "$(dirname "$0")" && pwd); R=$(cd "$H/../../../.." && pwd); V=$R/docs/validation/VTID-05582; M=$R/supabase/migrations
TWICE=0; MIG=1; UPTO=1
while [[ "$1" == --* ]]; do case "$1" in --twice) TWICE=1;; --no-migrations) MIG=0;; --only-columns) UPTO=0;; esac; shift; done
T=${1:-$R/supabase/tests/mt-network-visibility-db.pgtap.sql}
A=(--sql "$V/pgtap/vtid_05582_fixture.sql")
FILES=("$M"/20261102051000_vtid_05582_*.sql); [ $UPTO = 1 ] && FILES+=("$M"/20261102051100_vtid_05582_*.sql)
if [ $MIG = 1 ]; then
  for pass in 1 $([ $TWICE = 1 ] && echo 2); do for f in "${FILES[@]}"; do A+=(--sql "$f"); done; done
fi
exec node "$H/run.mjs" "${A[@]}" "$T"
