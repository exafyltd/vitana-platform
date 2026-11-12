#!/bin/bash
# Run the VTID-05498 pgTAP file in PGlite (PostgreSQL wasm) with a pgTAP-compatible shim.
#   lane.sh [--twice] [--no-migrations] [--seed-extra] [test.sql]
#   --seed-extra loads seed_extra_docs.sql (unrelated baseline rows) before the migration.
# Not the full production schema, no real pgTAP: CI's `supabase test db` stays authoritative.
H=$(cd "$(dirname "$0")" && pwd); R=$(cd "$H/../../../.." && pwd)
TWICE=0; MIG=1; SEED=0
while [[ "$1" == --* ]]; do case "$1" in --twice) TWICE=1;; --no-migrations) MIG=0;; --seed-extra) SEED=1;; esac; shift; done
T=${1:-$R/supabase/tests/mt/mt_packs_knowledge_docs_tenant_id.sql}
A=(--sql "$H/base_schema.sql")
[ $SEED = 1 ] && A+=(--sql "$H/seed_extra_docs.sql")
if [ $MIG = 1 ]; then
  for pass in 1 $([ $TWICE = 1 ] && echo 2); do A+=(--sql "$R/supabase/migrations/20261102080000_mt_packs_knowledge_docs_tenant_id.sql"); done
fi
exec node "$H/run.mjs" "${A[@]}" "$T"
