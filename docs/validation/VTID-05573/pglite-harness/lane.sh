#!/bin/bash
# Run the VTID-05573 pgTAP file in PGlite (PostgreSQL 18 wasm) with a pgTAP-compatible shim.
#   lane.sh [--twice] [--no-migrations] [--upto N] [<test.sql>]
#   --no-migrations = the RED proof (fixture + the two real dependency migrations only, as on origin/main);
#   --upto N loads only the first N lane migrations (052000, 052100, 052200, 052300).
# Loads: the fixture (stand-ins for the live tables), the REAL dependency migrations 050000 (VTID-05576) and 051000 (VTID-05582),
# then the lane migrations, optionally twice (idempotence), then the test.
# Not the full production schema, no real pgTAP: CI's `supabase test db` stays authoritative.
H=$(cd "$(dirname "$0")" && pwd); R=$(cd "$H/../../../.." && pwd); V=$R/docs/validation/VTID-05573; M=$R/supabase/migrations
TWICE=0; MIG=1; UPTO=4
while [[ "$1" == --* ]]; do case "$1" in --twice) TWICE=1;; --no-migrations) MIG=0;; --upto) shift; UPTO=$1;; esac; shift; done
T=${1:-$R/supabase/tests/mt-network-legacy-migration.pgtap.sql}
A=(--sql "$V/pgtap/vtid_05573_fixture.sql" --sql "$M/20261102050000_vtid_05576_chat_messages_scope.sql" --sql "$M/20261102051000_vtid_05582_network_visible_profile.sql")
FILES=("$M"/20261102052000_vtid_05573_*.sql "$M"/20261102052100_vtid_05573_*.sql "$M"/20261102052200_vtid_05573_*.sql "$M"/20261102052300_vtid_05573_*.sql)
FILES=("${FILES[@]:0:$UPTO}")
if [ $MIG = 1 ]; then
  for pass in 1 $([ $TWICE = 1 ] && echo 2); do for f in "${FILES[@]}"; do A+=(--sql "$f"); done; done
fi
exec node "$H/run.mjs" "${A[@]}" "$T"
