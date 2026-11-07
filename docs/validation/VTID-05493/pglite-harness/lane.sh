#!/bin/bash
# Run the VTID-05493 pgTAP file in PGlite (PostgreSQL 18 wasm) with a pgTAP-compatible shim.
#   lane.sh [--twice] [--no-migrations] [--only-deactivate] <test.sql>
H=$(cd "$(dirname "$0")" && pwd); R=$(cd "$H/../../../.." && pwd); V=$R/docs/validation/VTID-05493
TWICE=0; MIG=1; ONLY1=0
while [[ "$1" == --* ]]; do case "$1" in --twice) TWICE=1;; --no-migrations) MIG=0;; --only-deactivate) ONLY1=1;; esac; shift; done
A=(--sql "$H/base_schema.sql" --sql "$R/supabase/migrations/20261010180200_vtid_05043_s3_switch_tenant_open_signup_only.sql" --sql "$V/pgtap/vtid_05493_fixture.sql")
if [ $MIG = 1 ]; then
  FILES=("$R"/supabase/migrations/20261102070300_vtid_*_mt_tenant_deactivate.sql)
  [ $ONLY1 = 0 ] && FILES+=("$R"/supabase/migrations/20261102070350_vtid_*_mt_tenant_archive_switch.sql)
  for pass in 1 $([ $TWICE = 1 ] && echo 2); do for f in "${FILES[@]}"; do A+=(--sql "$f"); done; done
fi
exec node "$H/run.mjs" "${A[@]}" "$1"
