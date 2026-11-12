#!/bin/bash
# Local PGlite run of the VTID-05572 pgTAP file. Usage: EXTRA_MIG="supabase/migrations/..." lane.sh <test.sql> (run from the repo root)
H=$(cd "$(dirname "$0")" && pwd); A=(--sql $H/base_schema.sql)
for f in $EXTRA_MIG; do A+=(--sql "$PWD/$f"); done
exec node $H/run.mjs "${A[@]}" "$1"
