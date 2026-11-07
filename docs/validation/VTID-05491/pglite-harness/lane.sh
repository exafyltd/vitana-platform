#!/bin/bash
# Run the VTID-05491 pgTAP file in PGlite (PostgreSQL 18 wasm) with a pgTAP-compatible shim.
#   lane.sh [--twice] [--upto N] [--no-migrations] <test.sql>      (--upto 1|2|3 loads only the first N of 070100/070150/070600)
# Loads: base stand-ins (base_schema.sql), the REAL public.current_tenant_id() (not used by the lane, kept for parity), the fixture,
# then the REAL lane migrations, optionally twice (idempotence), then the test.
# Not the full production schema, no real pgTAP: CI's `supabase test db` stays authoritative.
H=$(cd "$(dirname "$0")" && pwd); R=$(cd "$H/../../../.." && pwd); V=$R/docs/validation/VTID-05491
TWICE=0; MIG=1; UPTO=3
while [[ "$1" == --* ]]; do case "$1" in --twice) TWICE=1;; --no-migrations) MIG=0;; --upto) UPTO=$2; shift;; esac; shift; done
A=(--sql "$H/base_schema.sql" --sql "$V/pgtap/vtid_05491_fixture.sql")
if [ $MIG = 1 ]; then
  FILES=("$R"/supabase/migrations/20261102070100_vtid_05491_*.sql "$R"/supabase/migrations/20261102070150_vtid_05491_*.sql "$R"/supabase/migrations/20261102070600_vtid_05491_*.sql)
  for pass in 1 $([ $TWICE = 1 ] && echo 2); do
    for i in $(seq 0 $((UPTO-1))); do A+=(--sql "${FILES[$i]}"); done
  done
fi
exec node "$H/run.mjs" "${A[@]}" "$1"
