#!/bin/bash
# Run the VTID-05576 pgTAP file in PGlite (PostgreSQL 18 wasm) with a pgTAP-compatible shim.
#   lane.sh [--twice] [--no-migrations] [--upto N] [<test.sql>]
#   --no-migrations = the RED proof (fixture only, as on origin/main); --upto N loads only the first N lane migrations.
# Loads: the fixture (stand-ins for the live tables), then the REAL lane migrations, optionally twice (idempotence), then the test.
# Not the full production schema, no real pgTAP: CI's `supabase test db` stays authoritative.
H=$(cd "$(dirname "$0")" && pwd); R=$(cd "$H/../../../.." && pwd); V=$R/docs/validation/VTID-05576; M=$R/supabase/migrations
TWICE=0; MIG=1; UPTO=3
while [[ "$1" == --* ]]; do case "$1" in --twice) TWICE=1;; --no-migrations) MIG=0;; --upto) shift; UPTO=$1;; esac; shift; done
T=${1:-$V/pgtap/mt-network-messaging-send-db.pgtap.sql}
A=(--sql "$V/pgtap/vtid_05576_fixture.sql")
FILES=("$M"/20261102050000_vtid_05576_*.sql "$M"/20261102050100_vtid_05576_*.sql "$M"/20261102050200_vtid_05576_*.sql)
FILES=("${FILES[@]:0:$UPTO}")
if [ $MIG = 1 ]; then
  for pass in 1 $([ $TWICE = 1 ] && echo 2); do for f in "${FILES[@]}"; do A+=(--sql "$f"); done; done
fi
exec node "$H/run.mjs" "${A[@]}" "$T"
