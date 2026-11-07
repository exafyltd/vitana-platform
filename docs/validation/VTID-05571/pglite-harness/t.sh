#!/bin/bash
cd /projects/sandbox/vitana-platform
export LANE_MIGRATIONS="supabase/migrations/20261102040000_vtid_05571_orphan_analysis.sql supabase/migrations/20261102040100_vtid_05571_orphan_quarantine_snapshots.sql supabase/migrations/20261102040200_vtid_05571_orphan_move_logic.sql $EXTRA_MIG"
/projects/sandbox/.tools/pgtap-shim/lane.sh "$1" 2>&1 | grep -v "^# loaded"
