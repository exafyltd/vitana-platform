#!/bin/bash
# Run a VTID-05507 pgTAP file in PGlite (PostgreSQL 18 wasm) with a pgTAP-compatible shim.
#   lane.sh [--twice] [--no-migrations] [--only-domains] <test.sql>
#   (--only-domains loads 20261102140000 but not 140100: the red proof for the host arm)
# Loads: base stand-ins (base_schema.sql), the fixture, the REAL 20261014000600 (VTID-05151 public registry; it asserts maxina and alkalma exist), then the
# two REAL lane migrations, optionally twice (idempotence), then the test.
# Not the full production schema, no real pgTAP: CI's `supabase test db` stays authoritative.
H=$(cd "$(dirname "$0")" && pwd); R=$(cd "$H/../../../.." && pwd); V=$R/docs/validation/VTID-05507; M=$R/supabase/migrations
TWICE=0; MIG=1; UPTO=1
while [[ "$1" == --* ]]; do case "$1" in --twice) TWICE=1;; --no-migrations) MIG=0;; --only-domains) UPTO=0;; esac; shift; done
A=(--sql "$H/base_schema.sql" --sql "$V/pgtap/vtid_05507_fixture.sql" --sql "$M/20261014000600_vtid_05151_public_tenant_registry.sql")
if [ $MIG = 1 ]; then
  for pass in 1 $([ $TWICE = 1 ] && echo 2); do
    for n in $(seq 0 $UPTO); do for f in "$M"/20261102140${n}00_vtid_05507_*.sql; do A+=(--sql "$f"); done; done
  done
fi
exec node "$H/run.mjs" "${A[@]}" "$1"
