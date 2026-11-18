#!/bin/bash
# Run a VTID-05488 pgTAP file in PGlite (PostgreSQL 18 wasm) with a pgTAP-compatible shim.
#   lane.sh [--schema live|id] [--twice] [--no-migrations] [--without-rls] <test.sql>
#   (--without-rls loads 120000..120200 but not 120300: the origin/main policies stay, for the red proof)
# Loads: base stand-ins (base_schema.sql), the REAL public.current_tenant_id() extracted unmodified from
# 20260218000000_fix_maxina_signup_tenant_association.sql, the fixture, then the four REAL lane migrations
# (20261102120000..120300), optionally twice (idempotence), then the test.
# Not the full production schema, no real pgTAP: CI's `supabase test db` stays authoritative.
H=$(cd "$(dirname "$0")" && pwd); R=$(cd "$H/../../../.." && pwd); V=$R/docs/validation/VTID-05488
SCHEMA=live; TWICE=0; MIG=1; UPTO=3
while [[ "$1" == --* ]]; do case "$1" in --schema) SCHEMA=$2; shift;; --twice) TWICE=1;; --no-migrations) MIG=0;; --without-rls) UPTO=2;; esac; shift; done
BASE=$H/base_schema.sql; FIX=$V/pgtap/vtid_05488_fixture.sql
if [ "$SCHEMA" = id ]; then
  BASE=$H/base_schema_id.sql; FIX=$(mktemp -p "$H" fixture-id.XXXX.sql); sed 's/SET tenant_id = /SET id = /' "$V/pgtap/vtid_05488_fixture.sql" > "$FIX"; trap 'rm -f "$FIX"' EXIT
fi
A=(--sql "$BASE" --extract-fn "$R/supabase/migrations/20260218000000_fix_maxina_signup_tenant_association.sql" --sql "$FIX")
if [ $MIG = 1 ]; then
  for pass in 1 $([ $TWICE = 1 ] && echo 2); do
    for n in $(seq 0 $UPTO); do for f in "$R"/supabase/migrations/20261102120${n}00_vtid_05488_*.sql; do A+=(--sql "$f"); done; done
  done
fi
exec node "$H/run.mjs" "${A[@]}" "$1"
