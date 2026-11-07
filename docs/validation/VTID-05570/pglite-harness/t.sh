#!/bin/bash
# t.sh <test.sql> : runs the VTID-05570 pgTAP file with the three lane migrations (set EXTRA_NONE=1 to load none = origin/main).
H=$(cd "$(dirname "$0")" && pwd)
if [ -z "$EXTRA_NONE" ]; then export LANE_MIGRATIONS="supabase/migrations/20261102041000_vtid_05570_memfacts_merge_functions.sql supabase/migrations/20261102041100_vtid_05570_memfacts_merge_rollback.sql"; fi
"$H/lane.sh" "$1" 2>&1 | grep -v "^# loaded"
