#!/bin/bash
# D1 on the bootstrap key (tenants.id). The VTID-05151 registry reads tenants.tenant_id, so 140100 is not run here.
H=$(cd "$(dirname "$0")" && pwd); R=$(cd "$H/../../../.." && pwd)
node "$H/checks.mjs" "$H/base_schema_id.sql" "$R"/supabase/migrations/20261102140000_vtid_05507_*.sql "$R"/supabase/migrations/20261102140000_vtid_05507_*.sql "$H/id-check.sql" 2>&1
