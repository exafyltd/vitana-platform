Local evidence harness (not part of the product): PGlite (PostgreSQL 18 wasm, /projects/sandbox/.tools/pglite) plus a
pgTAP-compatible shim (`shim.sql`, copied from VTID-05488). service_role is created BYPASSRLS, as in Supabase.

    pglite-harness/lane.sh [--twice] [--no-migrations] [--only-domains] pgtap/vtid_05507_tenant_domains.test.sql
    pglite-harness/checks.sh     # live-before, migrations, post-apply-checks, rollbacks, rollback-check, re-apply

What it loads: `base_schema.sql` (stand-ins for tenants, tenant_settings, reserved_tenant_slugs), the REAL
`20261014000600_vtid_05151_public_tenant_registry.sql`, `pgtap/vtid_05507_fixture.sql`, then the two REAL lane
migrations. Limits: not the full production schema; no real pgTAP. CI's `supabase test db` remains authoritative.
`base_schema_id.sql` models the bootstrap key (`tenants.id`); only 20261102140000 can run on it (the VTID-05151 registry
reads `tenants.tenant_id`), see `id-check.sh`.
