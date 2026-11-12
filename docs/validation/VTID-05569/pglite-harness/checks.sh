#!/bin/bash
# VTID-05569 read-only checks in PGlite: pre-check, forward migration, post-check, rollback file, rollback-check.
R=${WT:-/projects/sandbox/wt-hot-notnull}; V=$R/docs/validation/VTID-05569; H=$(dirname "$0"); M=$R/supabase/migrations
grep -vi "create extension" $M/20260612140000_BOOTSTRAP_product_analytics_events.sql > /tmp/pae05569.sql
node $H/runchk.mjs $H/base_schema.sql /tmp/pae05569.sql $V/pre-check.sql $M/20261102043000_vtid_05569_hot_tables_tenant_not_null_assert.sql $V/post-check.sql $M/20261102043100_vtid_05569_hot_tables_tenant_not_null_assert_rollback.sql $V/rollback-check.sql 2>&1
