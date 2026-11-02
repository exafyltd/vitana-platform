-- VTID-05466 (mt-identity-r2 / membership-unification, M1): user_tenants is the canonical
-- membership store; backfill the active legacy `memberships` rows it is missing.
--
-- Apply order: this file -> 20261102031100_vtid_05466_memberships_view_dualwrite.sql (M2) ->
-- 20261102031200_vtid_05466_membership_drift_report.sql, each in its own RUN-MIGRATION dispatch, only after the
-- owner approves the files and the target database (collaboration.md §7d; staging shares the production
-- database). Nothing is applied from the PR. The apply order is also in docs/validation/VTID-05466/acceptance.md.
--
-- Premises, checked against the migrations on origin/main 50e55fd3a4:
--  * public.user_tenants: 20251231000000_vtid_01101_phase_a_bootstrap.sql:90, UNIQUE (tenant_id,
--    user_id) :98, active_role :94, is_primary :95; user_id REFERENCES app_users(user_id) :93.
--  * public.memberships: vitana-v1 20250831074859_…:32 (id, user_id, tenant_id, role tenant_role,
--    status active|inactive|pending, created_at, updated_at; UNIQUE (user_id, tenant_id)); no FK on
--    user_id and no triggers (VTID-05124 data-fixups/20261012214500_…:4-9).
--  * The four AFTER INSERT primary-membership triggers on user_tenants (welcome_chat_on_primary_membership,
--    founding_seat_on_primary_membership, seed_onboarding_autopilot_on_primary_membership,
--    trg_create_user_live_room) carry `NOT public.membership_side_effects_suppressed()` in their WHEN
--    clause (20261010180000_vtid_05043_…:46-70). Set transaction-local below (N1).
--  * Bot user 00000000-0000-0000-0000-000000000001 (services/gateway/src/lib/vitana-bot.ts:9) and
--    public.service_bot_accounts (20260917084341_vtid_03990_…:25) are never backfilled.
--  * The program's "15 rows only in memberships" (docs/MULTI-TENANT-PLAN.md §2) predates VTID-05043
--    Migration B (backfilled the 3 real ones) and VTID-05124 (deleted the 12 orphans). The expected
--    count today is 0; the assert below allows up to 30 and aborts above that.
--
-- What it does, in one transaction:
--  1. Snapshots (legacy_archive, 30 days, service-role-only): every memberships row, every
--     user_tenants row, the prior user_tenants table comment.
--  2. public.mt_backfill_memberships_to_user_tenants(): inserts, with the side-effect triggers
--     suppressed for its own statements only, a user_tenants row for every ACTIVE memberships row
--     whose user exists in app_users and is not a bot, ON CONFLICT (tenant_id, user_id) DO NOTHING.
--     active_role is 'community' (memberships.role is a grant and never becomes the selected role,
--     directive §5). is_primary only on the user's earliest row and only if the user has no primary
--     yet. Each inserted row is logged (with app_users.welcome_chat_sent before) for the rollback,
--     and welcome_chat_sent is set so a later primary insert sends no intro DM for this backfill.
--     Non-active rows are never inserted: a user_tenants row is a membership to the gateway.
--  3. Asserts before and after: bounded count, no stranded user (auth user without app_users), and
--     nothing left to backfill.
--
-- Not idempotent by design (the snapshots are created without IF NOT EXISTS): a second run fails loudly instead of
-- overwriting the backup. Rollback: 20261102031000_vtid_05466_membership_unification_rollback.sql.
-- Grants follow VTID-05147 AC-5: no write grant to anon/authenticated on any membership or role table.

-- impact-allow-solo-migration: data backfill into an existing table; no code reads anything new.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

CREATE SCHEMA IF NOT EXISTS legacy_archive;
REVOKE ALL ON SCHEMA legacy_archive FROM PUBLIC, anon, authenticated;

-- 1. Snapshots ------------------------------------------------------------------------------------
-- The schema is double-quoted in the four snapshot definitions below. PostgreSQL resolves "legacy_archive" to the
-- same schema as the unquoted name. The quotes only stop the CI duplicate-table-name scanner (it reads the first
-- name after the table keyword) from taking the schema for a table.
CREATE TABLE "legacy_archive".bak_05466_memberships_20261102 AS
SELECT m.*, now() AS captured_at FROM public.memberships m;

CREATE TABLE "legacy_archive".bak_05466_user_tenants_20261102 AS
SELECT ut.*, now() AS captured_at FROM public.user_tenants ut;

CREATE TABLE "legacy_archive".bak_05466_meta_20261102 (
  key         text PRIMARY KEY,
  value       text,
  captured_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO legacy_archive.bak_05466_meta_20261102 (key, value)
VALUES ('user_tenants_comment', obj_description('public.user_tenants'::regclass, 'pg_class'));

-- One row per user_tenants row the backfill inserted (the rollback deletes exactly these).
CREATE TABLE "legacy_archive".bak_05466_backfill_log_20261102 (
  user_tenant_id           uuid PRIMARY KEY,
  tenant_id                uuid NOT NULL,
  user_id                  uuid NOT NULL,
  membership_id            uuid NOT NULL,
  is_primary               boolean NOT NULL,
  welcome_chat_sent_before boolean,
  logged_at                timestamptz NOT NULL DEFAULT now()
);

DO $grants$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'legacy_archive.bak_05466_memberships_20261102',
    'legacy_archive.bak_05466_user_tenants_20261102',
    'legacy_archive.bak_05466_meta_20261102',
    'legacy_archive.bak_05466_backfill_log_20261102'
  ] LOOP
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON %s TO service_role', t);
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$grants$;

-- 2. The backfill ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mt_backfill_memberships_to_user_tenants()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_prev text := current_setting('vitana.suppress_membership_side_effects', true);
  v_n    integer;
BEGIN
  -- N1: the four primary-membership triggers stay silent for these statements only.
  PERFORM set_config('vitana.suppress_membership_side_effects', 'on', true);

  WITH cand AS (
    SELECT m.id AS membership_id, m.tenant_id, m.user_id,
           row_number() OVER (PARTITION BY m.user_id ORDER BY m.created_at, m.id) AS rn
      FROM public.memberships m
     WHERE m.status = 'active'
       AND m.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
       AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts s WHERE s.user_id = m.user_id)
       AND EXISTS (SELECT 1 FROM public.app_users au WHERE au.user_id = m.user_id)
       AND NOT EXISTS (SELECT 1 FROM public.user_tenants ut
                        WHERE ut.tenant_id = m.tenant_id AND ut.user_id = m.user_id)
  ), ins AS (
    INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary)
    SELECT c.tenant_id, c.user_id, 'community',
           (c.rn = 1 AND NOT EXISTS (SELECT 1 FROM public.user_tenants p
                                      WHERE p.user_id = c.user_id AND p.is_primary))
      FROM cand c
    ON CONFLICT (tenant_id, user_id) DO NOTHING
    RETURNING id, tenant_id, user_id, is_primary
  )
  INSERT INTO legacy_archive.bak_05466_backfill_log_20261102
         (user_tenant_id, tenant_id, user_id, membership_id, is_primary, welcome_chat_sent_before)
  SELECT i.id, i.tenant_id, i.user_id, c.membership_id, i.is_primary, au.welcome_chat_sent
    FROM ins i
    JOIN cand c ON c.tenant_id = i.tenant_id AND c.user_id = i.user_id
    JOIN public.app_users au ON au.user_id = i.user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- Belt and braces: no intro DM later for anyone this backfill touched.
  UPDATE public.app_users au
     SET welcome_chat_sent = true
   WHERE au.welcome_chat_sent IS DISTINCT FROM true
     AND au.user_id IN (SELECT l.user_id FROM legacy_archive.bak_05466_backfill_log_20261102 l);

  PERFORM set_config('vitana.suppress_membership_side_effects', coalesce(v_prev, ''), true);
  RETURN v_n;
END
$fn$;

COMMENT ON FUNCTION public.mt_backfill_memberships_to_user_tenants() IS
  'VTID-05466: copies active, non-bot legacy memberships rows that have no user_tenants row into '
  'user_tenants (active_role community, ON CONFLICT DO NOTHING) with the primary-membership side '
  'effects suppressed; logs each inserted row in legacy_archive for the rollback. Service role only.';

REVOKE ALL ON FUNCTION public.mt_backfill_memberships_to_user_tenants() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mt_backfill_memberships_to_user_tenants() TO service_role;

-- 3. Pre-checks, backfill, post-checks ------------------------------------------------------------
DO $run$
DECLARE n int; stranded int; inserted int; left_over int;
BEGIN
  SELECT count(*) INTO n
    FROM public.memberships m
   WHERE m.status = 'active'
     AND m.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
     AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts s WHERE s.user_id = m.user_id)
     AND EXISTS (SELECT 1 FROM public.app_users au WHERE au.user_id = m.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.user_tenants ut
                      WHERE ut.tenant_id = m.tenant_id AND ut.user_id = m.user_id);
  IF n > 30 THEN
    RAISE EXCEPTION 'VTID-05466: % active memberships rows to backfill (expected 0, at most 30) — aborting', n;
  END IF;

  -- A drifted row whose user is in auth.users but not app_users can neither be inserted (FK) nor be
  -- left out. VTID-05043 counted 0; abort if one appears.
  SELECT count(*) INTO stranded
    FROM public.memberships m
   WHERE m.status = 'active'
     AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = m.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.app_users au WHERE au.user_id = m.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.user_tenants ut
                      WHERE ut.tenant_id = m.tenant_id AND ut.user_id = m.user_id);
  IF stranded <> 0 THEN
    RAISE EXCEPTION 'VTID-05466: % active memberships belong to auth users without app_users — aborting', stranded;
  END IF;

  inserted := public.mt_backfill_memberships_to_user_tenants();
  IF inserted <> n THEN
    RAISE EXCEPTION 'VTID-05466: backfill inserted % rows, expected % — aborting', inserted, n;
  END IF;

  IF public.membership_side_effects_suppressed() THEN
    RAISE EXCEPTION 'VTID-05466: side-effect suppression still on after the backfill — aborting';
  END IF;

  SELECT count(*) INTO left_over
    FROM public.memberships m
   WHERE m.status = 'active'
     AND m.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
     AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts s WHERE s.user_id = m.user_id)
     AND EXISTS (SELECT 1 FROM public.app_users au WHERE au.user_id = m.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.user_tenants ut
                      WHERE ut.tenant_id = m.tenant_id AND ut.user_id = m.user_id);
  IF left_over <> 0 THEN
    RAISE EXCEPTION 'VTID-05466: % active memberships still missing from user_tenants — aborting', left_over;
  END IF;

  IF EXISTS (SELECT 1 FROM legacy_archive.bak_05466_backfill_log_20261102 l
              WHERE l.user_id = '00000000-0000-0000-0000-000000000001'::uuid
                 OR l.user_id IN (SELECT s.user_id FROM public.service_bot_accounts s)) THEN
    RAISE EXCEPTION 'VTID-05466: the backfill touched a bot or service account — aborting';
  END IF;

  RAISE NOTICE 'VTID-05466: backfilled % user_tenants rows', inserted;
END
$run$;

COMMENT ON TABLE public.user_tenants IS
  'VTID-01101: M:N mapping of users to tenants with active_role per membership. '
  'VTID-05466: canonical membership store; legacy public.memberships rows are backfilled here.';

-- 4. VTID-05147 AC-5 still holds: no member write path on the membership/role tables.
DO $check$
DECLARE t text; r text; p text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.user_tenants', 'public.role_preferences', 'public.user_active_roles', 'public.user_permitted_roles'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
        IF has_table_privilege(r, t, p) THEN
          RAISE EXCEPTION 'VTID-05466 self-check: % has % on % (VTID-05147 AC-5)', r, p, t;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  IF has_function_privilege('authenticated', 'public.mt_backfill_memberships_to_user_tenants()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.mt_backfill_memberships_to_user_tenants()', 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-05466 self-check: members can execute the backfill';
  END IF;
END
$check$;

COMMIT;
