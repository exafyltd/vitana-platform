#!/bin/bash
# VTID-05570 harness copy: base stand-in schema + the lane migrations in LANE_MIGRATIONS (repo-relative), then the test.
# Usage: LANE_MIGRATIONS="<files>" lane.sh <test.sql>   (run from the lane worktree)
R=$(git rev-parse --show-toplevel); H=$(cd "$(dirname "$0")" && pwd); A=(--sql "$H/base_schema.sql")
for f in $LANE_MIGRATIONS; do A+=(--sql "$R/$f"); done
exec node "$H/run.mjs" "${A[@]}" "$1"
