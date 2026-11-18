#!/bin/bash
# VTID-05569 harness: base stand-in schema + the real product_analytics_events DDL (pgcrypto line dropped, PGlite has no
# extension), then the lane migration(s), then the test. Usage: h05569.sh <test.sql> [migration...]
WT=${WT:-/projects/sandbox/wt-hot-notnull}; H=$(dirname "$0")
grep -vi "create extension" $WT/supabase/migrations/20260612140000_BOOTSTRAP_product_analytics_events.sql > /tmp/pae05569.sql
T=$1; shift; A=(--sql $H/base_schema.sql --sql /tmp/pae05569.sql)
for m in "$@"; do A+=(--sql $m); done
node $H/run.mjs "${A[@]}" "$T" 2>&1 | grep -v "^# loaded"
