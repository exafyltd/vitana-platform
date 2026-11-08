-- VTID-05572 read-only check after a rollback (rollback-042100-profiles-tenant-backfill.sql). The first two values must be 0.
SELECT count(*) AS backfill_log_rows_left FROM legacy_archive.mt_profiles_tenant_backfill_log;
SELECT count(*) AS unresolved_rows_left   FROM legacy_archive.mt_profiles_tenant_unresolved;
-- Informational (expected 0 right after a rollback; a later legitimate change shows here and is not an error):
-- profiles whose tenant_id now differs from the snapshot.
SELECT count(*) AS profiles_differing_from_snapshot
  FROM legacy_archive.bak_mt_data_cleanup_profiles b
  JOIN public.profiles p ON p.user_id = b.user_id
 WHERE p.tenant_id IS DISTINCT FROM b.tenant_id_before;
