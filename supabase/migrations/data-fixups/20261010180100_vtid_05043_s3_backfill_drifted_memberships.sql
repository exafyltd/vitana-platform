-- VTID-05043 (Track S / S3, Migration B of 3) — data fix-up: give every member the gateway
-- can see in `memberships` the matching `user_tenants` row, and clear any active_tenant_id claim
-- that points at a tenant the user is not a member of.
--
-- Requires Migration A (20261010180000_vtid_05043_s3_membership_side_effect_guard.sql):
-- tenants.open_signup and the side-effect guard on the four primary-membership triggers.
--
-- Why: the gateway membership check (VTID-05043 PR3) answers "is this user a member of the
-- tenant in their token?" from user_tenants. Rows that exist only in the legacy `memberships`
-- table would be refused. Counted read-only 2026-10-10: 15 active `memberships` rows have no
-- user_tenants row (maxina 11, alkalma 4). 12 of them belong to user ids that no longer exist in
-- auth.users or app_users (deleted accounts; user_tenants.user_id references app_users, so they
-- cannot be inserted and can never sign in) — they are kept in the snapshot and left alone. The
-- other 3 (alkalma) are real users who already have a primary membership elsewhere, so they get
-- a non-primary row. Bad claims (active_tenant_id without a membership, exafy_admin excluded): 0.
--
-- Side effects: suppressed for this transaction only (set_config(..., true)); every touched
-- user's app_users.welcome_chat_sent is set to true as well, so no later primary insert sends
-- an intro DM for this backfill. The setting is gone after COMMIT.
--
-- Not idempotent by design: the snapshot tables are created with plain CREATE TABLE, so a
-- second run fails loudly instead of overwriting the backup. Snapshots live in the
-- legacy_archive schema (not exposed to clients, VTID-04880) and are kept 30 days.
--
-- Rollback: docs/validation/VTID-05043/rollback-s3-backfill.sql.

-- impact-allow-solo-migration: lands dark; the gateway code that relies on it ships in the
-- separate VTID-05043 PR3, merged only after this is applied.

BEGIN;

SET LOCAL lock_timeout = '3s';

SELECT set_config('vitana.suppress_membership_side_effects', 'on', true);

CREATE SCHEMA IF NOT EXISTS legacy_archive;
REVOKE ALL ON SCHEMA legacy_archive FROM PUBLIC, anon, authenticated;

-- 1. Snapshot: active legacy memberships with no user_tenants row.
CREATE TABLE legacy_archive.bak_s3_drift_20261010 AS
SELECT m.id                                                         AS membership_id,
       m.tenant_id,
       m.user_id,
       m.created_at                                                 AS membership_created_at,
       EXISTS (SELECT 1 FROM public.app_users au WHERE au.user_id = m.user_id) AS has_app_user,
       EXISTS (SELECT 1 FROM auth.users u WHERE u.id = m.user_id)   AS has_auth_user,
       (SELECT au.welcome_chat_sent FROM public.app_users au WHERE au.user_id = m.user_id)
                                                                    AS welcome_chat_sent_before,
       now()                                                        AS captured_at
  FROM public.memberships m
 WHERE m.status = 'active'
   AND NOT EXISTS (SELECT 1 FROM public.user_tenants ut
                    WHERE ut.tenant_id = m.tenant_id AND ut.user_id = m.user_id);

-- 2. Asserts: only open-signup tenants, a bounded count, and no real user left behind.
DO $$
DECLARE n int; closed int; stranded int;
BEGIN
  SELECT count(*) INTO n FROM legacy_archive.bak_s3_drift_20261010;
  IF n > 30 THEN
    RAISE EXCEPTION 'VTID-05043: % drifted memberships (expected <= 30, counted 15) — aborting', n;
  END IF;

  SELECT count(*) INTO closed
    FROM legacy_archive.bak_s3_drift_20261010 b
    JOIN public.tenants t ON t.tenant_id = b.tenant_id
   WHERE NOT t.open_signup;
  IF closed <> 0 THEN
    RAISE EXCEPTION 'VTID-05043: % drifted memberships are in a tenant without open_signup — aborting', closed;
  END IF;

  -- A drifted row whose user exists in auth.users but not in app_users can neither be inserted
  -- (FK) nor be left out (PR3 would refuse that user). None counted live; abort if one appears.
  SELECT count(*) INTO stranded
    FROM legacy_archive.bak_s3_drift_20261010
   WHERE has_auth_user AND NOT has_app_user;
  IF stranded <> 0 THEN
    RAISE EXCEPTION 'VTID-05043: % drifted members exist in auth.users without app_users — aborting', stranded;
  END IF;
END $$;

-- 3. Belt-and-braces: no welcome DM for anyone this backfill touches.
UPDATE public.app_users au
   SET welcome_chat_sent = true
 WHERE au.user_id IN (SELECT b.user_id FROM legacy_archive.bak_s3_drift_20261010 b WHERE b.has_app_user)
   AND au.welcome_chat_sent IS DISTINCT FROM true;

-- 4. The backfill. Primary only for a user who has none yet, and only on their earliest row.
INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary)
SELECT d.tenant_id,
       d.user_id,
       'community',
       (d.rn = 1 AND NOT EXISTS (SELECT 1 FROM public.user_tenants p
                                  WHERE p.user_id = d.user_id AND p.is_primary))
  FROM (SELECT b.*,
               row_number() OVER (PARTITION BY b.user_id ORDER BY b.membership_created_at, b.membership_id) AS rn
          FROM legacy_archive.bak_s3_drift_20261010 b
         WHERE b.has_app_user) d
ON CONFLICT (tenant_id, user_id) DO NOTHING;

-- 5. Claim remediation: active_tenant_id must name a tenant the user belongs to.
CREATE TABLE legacy_archive.bak_s3_claims_20261010 AS
SELECT u.id                                        AS user_id,
       u.raw_app_meta_data->>'active_tenant_id'    AS active_tenant_id_before,
       now()                                       AS captured_at
  FROM auth.users u
 WHERE u.raw_app_meta_data->>'active_tenant_id' IS NOT NULL
   AND NOT coalesce(u.raw_app_meta_data->>'exafy_admin' = 'true', false)
   AND NOT EXISTS (SELECT 1 FROM public.user_tenants ut
                    WHERE ut.user_id = u.id
                      AND ut.tenant_id::text = u.raw_app_meta_data->>'active_tenant_id');

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM legacy_archive.bak_s3_claims_20261010;
  IF n > 50 THEN
    RAISE EXCEPTION 'VTID-05043: % active_tenant_id claims without a membership (expected <= 50, counted 0) — aborting', n;
  END IF;
END $$;

UPDATE auth.users u
   SET raw_app_meta_data = CASE
         WHEN p.tenant_id IS NOT NULL
           THEN coalesce(u.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('active_tenant_id', p.tenant_id)
         ELSE u.raw_app_meta_data - 'active_tenant_id'
       END
  FROM legacy_archive.bak_s3_claims_20261010 b
  LEFT JOIN public.user_tenants p ON p.user_id = b.user_id AND p.is_primary
 WHERE u.id = b.user_id;

-- 6. Post-checks, inside the transaction: nothing left to fix.
DO $$
DECLARE drift int; claims int;
BEGIN
  SELECT count(*) INTO drift
    FROM public.memberships m
   WHERE m.status = 'active'
     AND EXISTS (SELECT 1 FROM public.app_users au WHERE au.user_id = m.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.user_tenants ut
                      WHERE ut.tenant_id = m.tenant_id AND ut.user_id = m.user_id);
  IF drift <> 0 THEN
    RAISE EXCEPTION 'VTID-05043: % drifted memberships remain after the backfill — aborting', drift;
  END IF;

  SELECT count(*) INTO claims
    FROM auth.users u
   WHERE u.raw_app_meta_data->>'active_tenant_id' IS NOT NULL
     AND NOT coalesce(u.raw_app_meta_data->>'exafy_admin' = 'true', false)
     AND NOT EXISTS (SELECT 1 FROM public.user_tenants ut
                      WHERE ut.user_id = u.id
                        AND ut.tenant_id::text = u.raw_app_meta_data->>'active_tenant_id');
  IF claims <> 0 THEN
    RAISE EXCEPTION 'VTID-05043: % active_tenant_id claims without a membership remain — aborting', claims;
  END IF;
END $$;

COMMIT;
