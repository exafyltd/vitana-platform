#!/bin/bash
# Run the VTID-05579 pgTAP file in PGlite (PostgreSQL 18 wasm) with a pgTAP-compatible shim.
#   lane.sh [--twice] [--no-migrations] [--upto N] [<test.sql>]
#   --no-migrations = the RED proof (fixture + the two real dependency migrations only, as on origin/main);
#   --upto N loads only the first N lane migrations (054000, 054100, 054200).
# Loads: the fixture (stand-ins for the live tables), the REAL dependency migrations 050000 (VTID-05576, chat_messages.scope)
# and 051000 (VTID-05582, is_network_excluded_account + the network_visible guard), then the lane migrations, optionally twice
# (idempotence), then the test. Not the full production schema, no real pgTAP: CI's `supabase test db` stays authoritative.
H=$(cd "$(dirname "$0")" && pwd); R=$(cd "$H/../../../.." && pwd); V=$R/docs/validation/VTID-05579; M=$R/supabase/migrations
TWICE=0; MIG=1; UPTO=3
while [[ "$1" == --* ]]; do case "$1" in --twice) TWICE=1;; --no-migrations) MIG=0;; --upto) shift; UPTO=$1;; esac; shift; done
T=${1:-$V/pgtap/mt-network-groups-db.pgtap.sql}
A=(--sql "$V/pgtap/vtid_05579_fixture.sql" --sql "$M/20261102050000_vtid_05576_chat_messages_scope.sql" --sql "$M/20261102051000_vtid_05582_network_visible_profile.sql" --sql "$V/pgtap/vtid_05579_fixture_data.sql")
FILES=($(ls "$M"/20261102054*_vtid_05579_*.sql 2>/dev/null | sort))
FILES=("${FILES[@]:0:$UPTO}")
if [ $MIG = 1 ]; then
  for pass in 1 $([ $TWICE = 1 ] && echo 2); do for f in "${FILES[@]}"; do A+=(--sql "$f"); done; done
fi
exec node "$H/run.mjs" "${A[@]}" "$T"
