#!/bin/bash
# Run the VTID-05595 pgTAP file in PGlite (PostgreSQL 18 wasm) with a pgTAP-compatible shim.
#   lane.sh [--schema live|id] [--twice] [--no-migrations] [--only-column] <test.sql>
#   (--only-column loads 130000 but not 130100: the red proof for the resolver/backfill; --no-migrations loads neither)
# Loads: base stand-ins (base_schema.sql), then the REAL lane migrations 20261102130000 and 130100, optionally twice
# (idempotence), then the test. Not the full production schema and not real pgTAP: CI's `supabase test db` stays authoritative.
H=$(cd "$(dirname "$0")" && pwd); R=$(cd "$H/../../../.." && pwd)
SCHEMA=live; TWICE=0; MIG=1; UPTO=1
while [[ "$1" == --* ]]; do case "$1" in --schema) SCHEMA=$2; shift;; --twice) TWICE=1;; --no-migrations) MIG=0;; --only-column) UPTO=0;; esac; shift; done
BASE=$H/base_schema.sql; [ "$SCHEMA" = id ] && BASE=$H/base_schema_id.sql
A=(--sql "$BASE")
if [ $MIG = 1 ]; then
  for pass in 1 $([ $TWICE = 1 ] && echo 2); do
    for n in $(seq 0 $UPTO); do for f in "$R"/supabase/migrations/20261102130${n}00_vtid_05595_*.sql; do A+=(--sql "$f"); done; done
  done
fi
exec node "$H/run.mjs" "${A[@]}" "$1"
