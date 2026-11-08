#!/bin/bash
# Run the VTID-05506 pgTAP file in PGlite (PostgreSQL 18 wasm) with a pgTAP-compatible shim.
#   lane.sh [--twice] [--no-migrations] [--only-provision] <test.sql>
#   (--only-provision loads 20261102141000 but not 141100: the red proof for the by-tenant function)
# Loads: the VTID-05150 fixture, the REAL Lane A M1 (20261014000100) + fixture part 2, the REAL 20261014000300 (isolation
# health), 000400 (brand pack, merge fn), 000500 (provision_tenant), then the two lane migrations (optionally twice).
# Not the full production schema, no real pgTAP: CI's `supabase test db` stays authoritative.
H=$(cd "$(dirname "$0")" && pwd); R=$(cd "$H/../../../.." && pwd); M=$R/supabase/migrations; T=$R/supabase/tests
TWICE=0; MIG=1; UPTO=1
while [[ "$1" == --* ]]; do case "$1" in --twice) TWICE=1;; --no-migrations) MIG=0;; --only-provision) UPTO=0;; esac; shift; done
A=(--sql "$T/vtid_05150_fixture.sql" --sql "$M/20261014000100_vtid_05149_tenants_default_platform_flags.sql" --sql "$T/vtid_05150_fixture_after_a.sql"
   --sql "$M/20261014000300_vtid_05149_ci_tenant_isolation_health.sql" --sql "$M/20261014000400_vtid_05150_tenant_brand_pack.sql"
   --sql "$M/20261014000500_vtid_05150_provision_tenant.sql")
if [ $MIG = 1 ]; then
  for pass in 1 $([ $TWICE = 1 ] && echo 2); do
    for n in $(seq 0 $UPTO); do for f in "$M"/20261102141${n}00_vtid_05506_*.sql; do A+=(--sql "$f"); done; done
  done
fi
exec node "$H/run.mjs" "${A[@]}" "$1"
