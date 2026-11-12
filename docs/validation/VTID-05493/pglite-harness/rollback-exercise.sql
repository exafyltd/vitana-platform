-- Harness only: use the lane functions on the fixture so the rollbacks have something to restore.
SELECT public.deactivate_tenant('t-a')->>'changed' AS deactivated_t_a, public.archive_tenant('t-c')->>'changed' AS archived_t_c;
SELECT slug, is_active, archived_at IS NOT NULL AS archived FROM public.tenants ORDER BY slug;
