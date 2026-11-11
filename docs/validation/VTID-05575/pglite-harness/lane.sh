#!/bin/bash
# Run the VTID-05575 pgTAP file in PGlite (PostgreSQL wasm) with a pgTAP-compatible shim.
#   lane.sh [--twice] [--no-migrations] [--only=N] [<test.sql>]
#   --no-migrations = the RED proof (fixture + dependency only, as on origin/main); --only=N loads the first N lane migrations.
# Loads: the fixture (stand-ins for the v1 tables), the REAL VTID-05582 migration 20261102051000 (network_visible and
# is_network_excluded_account, merged and a stated dependency), the four REAL intent matchers from VTID-04888, then the REAL
# lane migrations 20261102053000/053100/053200, optionally twice (idempotence), then the test.
# Not the full production schema, no real pgTAP and no pgvector: CI's `supabase test db` stays authoritative.
H=$(cd "$(dirname "$0")" && pwd); R=$(cd "$H/../../../.." && pwd); V=$R/docs/validation/VTID-05575; M=$R/supabase/migrations
TWICE=0; MIG=1; ONLY=3
while [[ "$1" == --* ]]; do case "$1" in --twice) TWICE=1;; --no-migrations) MIG=0;; --only=*) ONLY=${1#--only=};; esac; shift; done
T=${1:-$R/supabase/tests/mt-network-matching-scope.pgtap.sql}
A=(--sql "$V/pgtap/vtid_05575_fixture.sql" --sql "$M/20261102051000_vtid_05582_network_visible_profile.sql" --extract-matchers "$M/20261005120000_vtid_04888_rule45_intents_profiles.sql")
FILES=(); for v in 053000 053100 053200; do FILES+=("$M"/20261102${v}_vtid_05575_*.sql); done
FILES=("${FILES[@]:0:$ONLY}")
if [ $MIG = 1 ]; then
  for pass in 1 $([ $TWICE = 1 ] && echo 2); do for f in "${FILES[@]}"; do A+=(--sql "$f"); done; done
fi
exec node "$H/run.mjs" "${A[@]}" "$T"
