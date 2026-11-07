#!/bin/bash
# Run the VTID-05495 pgTAP file in PGlite (PostgreSQL 18 wasm) with a pgTAP-compatible shim.
#   lane.sh [--twice] [--no-migrations] [test.sql]   (default test: supabase/tests/mt/mt_packs_tenant_content_overrides.sql)
# Not the full production schema, no real pgTAP: CI's `supabase test db` stays authoritative.
H=$(cd "$(dirname "$0")" && pwd); R=$(cd "$H/../../../.." && pwd)
TWICE=0; MIG=1
while [[ "$1" == --* ]]; do case "$1" in --twice) TWICE=1;; --no-migrations) MIG=0;; esac; shift; done
T=${1:-$R/supabase/tests/mt/mt_packs_tenant_content_overrides.sql}
A=(--sql "$H/base_schema.sql")
if [ $MIG = 1 ]; then
  for pass in 1 $([ $TWICE = 1 ] && echo 2); do A+=(--sql "$R/supabase/migrations/20261101100000_mt_packs_tenant_content_overrides.sql"); done
fi
exec node "$H/run.mjs" "${A[@]}" "$T"
