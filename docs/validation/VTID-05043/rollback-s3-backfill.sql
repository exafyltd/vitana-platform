-- VTID-05043 rollback for Migration B (data-fixups/20261010180100_vtid_05043_s3_backfill_drifted_memberships.sql).
-- Uses the snapshot tables B left in legacy_archive (kept 30 days):
--   * deletes exactly the user_tenants rows B inserted (same (tenant, user) as a snapshot row and
--     created in B's transaction: created_at = captured_at). DELETE fires no insert trigger.
--   * restores app_users.welcome_chat_sent and auth.users active_tenant_id to their captured values.
-- Run after rollback-s3-switch-tenant.sql, before rollback-s3-guard.sql.

BEGIN;

SET LOCAL lock_timeout = '3s';

DELETE FROM public.user_tenants ut
 USING legacy_archive.bak_s3_drift_20261010 b
 WHERE ut.tenant_id = b.tenant_id
   AND ut.user_id = b.user_id
   AND ut.created_at = b.captured_at;

UPDATE public.app_users au
   SET welcome_chat_sent = b.welcome_chat_sent_before
  FROM (SELECT DISTINCT user_id, welcome_chat_sent_before
          FROM legacy_archive.bak_s3_drift_20261010
         WHERE has_app_user) b
 WHERE au.user_id = b.user_id
   AND au.welcome_chat_sent IS DISTINCT FROM b.welcome_chat_sent_before;

UPDATE auth.users u
   SET raw_app_meta_data = coalesce(u.raw_app_meta_data, '{}'::jsonb)
                           || jsonb_build_object('active_tenant_id', b.active_tenant_id_before)
  FROM legacy_archive.bak_s3_claims_20261010 b
 WHERE u.id = b.user_id;

COMMIT;
