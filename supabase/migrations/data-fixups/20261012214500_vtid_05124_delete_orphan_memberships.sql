-- VTID-05124 (FU8) — data fix-up: delete the legacy `memberships` rows left behind by deleted
-- accounts.
--
-- Why: `public.memberships` has no FK from user_id to auth.users or app_users (only
-- memberships_tenant_id_fkey -> tenants), so deleting an account leaves its rows behind.
-- Counted read-only 2026-10-12: 235 rows, 12 of them with a user_id that has no auth.users,
-- app_users, profiles or user_tenants row (maxina 11, alkalma 1; 11 distinct users; 11 community,
-- 1 reseller; never updated since created). They are the same 12 rows VTID-05043 Migration B
-- snapshotted with has_auth_user = false and left alone. Nothing references memberships(id) and
-- the table has no triggers. The rows are never shown to members (every reader is keyed on the
-- caller, and the directory reads profiles); their only visible effect is inflated admin counts
-- (admin_tenant_analytics total_users/active_users, admin_system_health total/active_memberships).
--
-- How: archive the full rows first, assert the set is what was counted, then delete by the
-- archived ids (never by a re-evaluated predicate), so the rows deleted are exactly the rows
-- archived. One transaction: any failed assert rolls everything back.
--
-- Not idempotent by design: the archive is created with plain CREATE TABLE, so a second run
-- fails loudly instead of overwriting it. legacy_archive is not exposed to clients (VTID-04880);
-- the archive is kept 30 days, like the VTID-05043 snapshots, and dropped with them.
--
-- Rollback: docs/validation/VTID-05124/rollback-orphan-memberships.sql.

-- impact-allow-solo-migration: data clean-up only; no schema change and no code reads the
-- deleted rows.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- 1. Archive: full rows (all 7 columns) of memberships whose user exists in neither auth.users
--    nor app_users.
CREATE TABLE legacy_archive.bak_fu8_orphan_memberships_20261012 AS
SELECT m.*,
       now() AS captured_at
  FROM public.memberships m
 WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = m.user_id)
   AND NOT EXISTS (SELECT 1 FROM public.app_users a WHERE a.user_id = m.user_id);

REVOKE ALL ON legacy_archive.bak_fu8_orphan_memberships_20261012 FROM PUBLIC, anon, authenticated;

-- 2. Asserts: the counted set, no live identity among it, nothing depending on memberships.
DO $$
DECLARE n int; live int; deps int;
BEGIN
  SELECT count(*) INTO n FROM legacy_archive.bak_fu8_orphan_memberships_20261012;
  IF n < 10 OR n > 14 THEN
    RAISE EXCEPTION 'VTID-05124: % orphan memberships (expected 10..14, counted 12) — aborting', n;
  END IF;

  SELECT count(*) INTO live
    FROM legacy_archive.bak_fu8_orphan_memberships_20261012 b
   WHERE EXISTS (SELECT 1 FROM public.user_tenants ut WHERE ut.user_id = b.user_id)
      OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = b.user_id OR p.id = b.user_id);
  IF live <> 0 THEN
    RAISE EXCEPTION 'VTID-05124: % archived memberships belong to a user with user_tenants or profiles rows — aborting', live;
  END IF;

  SELECT count(*) INTO deps
    FROM pg_constraint c
   WHERE c.contype = 'f' AND c.confrelid = 'public.memberships'::regclass;
  IF deps <> 0 THEN
    RAISE EXCEPTION 'VTID-05124: % foreign keys now reference public.memberships — aborting', deps;
  END IF;
END $$;

-- 3. Delete exactly the archived rows, then post-check inside the transaction.
DO $$
DECLARE n int; deleted int; left_over int;
BEGIN
  SELECT count(*) INTO n FROM legacy_archive.bak_fu8_orphan_memberships_20261012;

  DELETE FROM public.memberships m
   USING legacy_archive.bak_fu8_orphan_memberships_20261012 b
   WHERE m.id = b.id;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  IF deleted <> n THEN
    RAISE EXCEPTION 'VTID-05124: deleted % memberships, archived % — aborting', deleted, n;
  END IF;

  SELECT count(*) INTO left_over
    FROM public.memberships m
   WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = m.user_id);
  IF left_over <> 0 THEN
    RAISE EXCEPTION 'VTID-05124: % memberships without an auth.users row remain — aborting', left_over;
  END IF;
END $$;

COMMIT;
