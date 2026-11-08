# Sparring round 2 — converged

Session: `1d3959ab-0249-4d15-81ec-1f39154fce6f` · plan hash `82e7f8991add42189122110d5025dd1562bf898f7b95ab8a15e57435c904db44`

## Summary

The revised plan properly addresses R1-F1, R1-F2, and R1-F3. The `client-identity-store` lane now includes `src/index.ts` and the middleware mount point; the Appilix signal is grounded in the `device_label` pattern confirmed at `scheduled-notifications-repository.ts:372`; and the storage is specified with a migration and DATABASE_SCHEMA.md in scope. Two minor new findings on migration path convention and tenant isolation in the proposed table.

## Findings

### R2-F1 [minor]

The plan places the new migration in `database/migrations/*_client_identity_daily_seen.sql`, but the `database/migrations/` directory has not been used since early January 2026 (last file: `20260103_vtid_01144_...`). All recent migrations (hundreds of them through November 2026) are in `supabase/migrations/`. The RUN-MIGRATION workflow's default example path is `supabase/migrations/...`. The gateway accesses the database via Supabase REST (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE`), further aligning with the `supabase/migrations/` convention. Placing it in the stale directory is not technically broken (the workflow accepts any repo-relative path) but violates the established convention and could confuse future maintainers.

- `exafyltd/vitana-platform:.github/workflows/RUN-MIGRATION.yml:7` — default: 'supabase/migrations/20260321000000_community_user_analyzer.sql'
- `exafyltd/vitana-platform:services/gateway/src/services/app-config/app-config-repository.ts:30` — const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE;

Suggestion: Change the migration path in the `client-identity-store` lane scope from `database/migrations/*_client_identity_daily_seen.sql` to `supabase/migrations/<timestamp>_client_identity_daily_seen.sql` to follow the current convention.

### R2-F2 [minor]

The proposed `client_identity_daily_seen` table has primary key `(day, user_id, client_class)` with no `tenant_id` column, but the adoption query must join with `user_device_tokens` which IS tenant-scoped (`countAppilixNativeDeviceTokens` at line 370 filters `.eq('tenant_id', args.tenantId)`). Without `tenant_id` in the counting table, the adoption metric is inherently cross-tenant. In a multi-tenant deployment (RLS is a core rule — ALWAYS 22), a per-tenant adoption metric would require an extra join to resolve user→tenant, and if a user appears in multiple tenants the join could inflate counts. The middleware has the tenant from the authenticated identity, so recording it is cheap.

- `exafyltd/vitana-platform:services/gateway/src/routes/scheduled-notifications-repository.ts:365` — export function countAppilixNativeDeviceTokens(sb: any, args: { userId: string; tenantId: string }) {
    return sb
      .from('user_device_tokens')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', args.userId)
      .eq('tenant_id', args.tenantId)
      .is('revoked_at', null)
      .like('device_label', 'Appilix %');
}
- `exafyltd/vitana-platform:CLAUDE.md:143` — 22. **Always enforce tenant isolation (RLS).**

Suggestion: Add `tenant_id uuid` to the `client_identity_daily_seen` schema and adjust the primary key to `(day, tenant_id, user_id, client_class)`. The middleware already has the tenant from the authenticated identity, and the adoption query can then filter per-tenant consistently with `user_device_tokens`.

## Acknowledgements of earlier responses

- R1-F5: acknowledged — vitana-v1 is still not pinned in this session so I cannot verify directly, but the planner's claim is specific (exact file, line number, export name) and I have no evidence to contradict it. Acknowledged.
