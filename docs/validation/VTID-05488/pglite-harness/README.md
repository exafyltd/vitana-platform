Local evidence harness (not part of the product): PGlite (PostgreSQL 18 wasm, /projects/sandbox/.tools/pglite) plus a
pgTAP-compatible shim (`shim.sql`, copied from VTID-05571 and extended with has_table / has_function).

    pglite-harness/lane.sh [--schema live|id] [--twice] [--no-migrations] [--without-rls] pgtap/vtid_05488_supplier_tenant_relationships.test.sql
    pglite-harness/checks.sh     # live-before, migrations, post-apply-checks, rollbacks, rollback-check, re-apply

What it loads: `base_schema.sql` (stand-ins for tenants, user_tenants, tenant_settings, merchants, products,
partner_tenant, partner_organizations, with the REAL foundation policies), the REAL `public.current_tenant_id()` taken
unmodified out of `20260218000000_fix_maxina_signup_tenant_association.sql`, `pgtap/vtid_05488_fixture.sql`, then the
four REAL lane migrations. `base_schema_id.sql` models the bootstrap key (`tenants.id`) instead of the live key
(`tenants.tenant_id`); the migrations resolve whichever exists.
Limits: not the full production schema; no real pgTAP. CI's `supabase test db` remains authoritative.
