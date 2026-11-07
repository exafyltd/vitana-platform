-- VTID-05573 (mt-network-r2/legacy-messages-migration-db) step 1 of 4: freeze + snapshot the legacy messenger tables.
--
-- The legacy messenger tables (vitana-v1 20250917143525 / 20250917153624, same Supabase project) are retired by this lane:
--   messages (12 rows), message_threads (5), global_message_threads (60), global_messages (379)
-- and their participant tables thread_participants / global_thread_participants, which the migration needs to rebuild group
-- membership. Row counts are the figures of docs/MULTI-TENANT-PLAN.md section 4.11; the live-before.sql read-only check prints
-- the real ones before apply.
--
-- This file, in one transaction:
--   1. LOCKS each table that exists (SHARE ROW EXCLUSIVE: readers continue, writers wait) so the copy is consistent.
--   2. Copies it whole into public.bak_<table> (LIKE ... INCLUDING DEFAULTS, same columns, same values). RLS on, all client
--      privileges revoked: only service_role/owner can read a snapshot (the rows are member messages: rules 43-45, tenant
--      isolation). Retention note on the table: 30 days, then dropped by a later owner-approved step.
--   3. FREEZES all six tables, the four legacy tables and the two participant tables (the migration rebuilds group membership
--      from the participant snapshots, so a participant write after the snapshot would be lost): INSERT/UPDATE/DELETE/TRUNCATE
--      revoked from PUBLIC and every API role including service_role (the owner role keeps them for the rollback). The two
--      participant tables are not dropped, so they stay frozen (read-only) afterwards.
-- Idempotent: an existing bak_* table is never overwritten, so a re-run after the data moved cannot replace the snapshot. A
-- re-run REFUSES (RAISE, nothing changes) when a live table holds a row that is absent from, or differs from, its existing
-- snapshot: that is the stale-snapshot case (rollback-052000 unfroze the tables, writes happened, 052000 was applied again).
-- Drop the stale bak_* table deliberately and apply again to take a fresh snapshot.
-- PRECONDITION to apply 052000: every reader and writer of the six tables is retired (see acceptance.md "Apply preconditions"),
-- because the freeze makes their writes fail from the moment this file is applied.
-- The snapshot tables are created by dynamic SQL on purpose, like VTID-05571's on-demand snapshots: they exist only where the
-- source table exists (a stack without the vitana-v1 schema gets none), and MIGRATION-DRIFT-CHECK reads literal CREATE TABLE.
-- Rollback: docs/validation/VTID-05573/rollback-052000-snapshot-freeze.sql (unfreezes; keeps the snapshots).
-- Order: 052000 -> 052100 -> 052200 -> 052300, one RUN-MIGRATION dispatch per file, after the owner approves the files and the
-- target database (collaboration.md 7d). Needs 20261102050000 (VTID-05576) and 20261102051000 (VTID-05582) applied first.

-- impact-allow-solo-migration: creates service-role-only snapshot copies and revokes writes on tables being retired; no code reads or writes them after the messaging lanes.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '300s';

DO $mig$
DECLARE
  v_table text;
  v_bak   text;
  v_all   text[] := ARRAY['messages', 'message_threads', 'global_message_threads', 'global_messages',
                          'thread_participants', 'global_thread_participants'];
  v_frozen text[] := v_all;
  v_stale  bigint;
  v_acl    text;
BEGIN
  FOREACH v_table IN ARRAY v_all LOOP
    IF to_regclass('public.' || v_table) IS NULL THEN
      CONTINUE;
    END IF;
    v_bak := 'bak_' || v_table;
    EXECUTE format('LOCK TABLE public.%I IN SHARE ROW EXCLUSIVE MODE', v_table);
    IF to_regclass('public.' || v_bak) IS NULL THEN
      EXECUTE format('CREATE TABLE public.%I (LIKE public.%I INCLUDING DEFAULTS)', v_bak, v_table);
      EXECUTE format('INSERT INTO public.%I SELECT * FROM public.%I', v_bak, v_table);
      -- The table's grants as they were before the freeze, kept in the comment so rollback-052000 restores them exactly.
      SELECT coalesce(c.relacl::text, 'NULL') INTO v_acl FROM pg_class c WHERE c.oid = to_regclass('public.' || v_table);
      EXECUTE format('COMMENT ON TABLE public.%I IS %L', v_bak,
        'VTID-05573: whole copy of public.' || v_table || ' taken ' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')
        || ' before the legacy messenger migration; retain until ' || to_char((now() + interval '30 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD')
        || ', then drop. Service role only; hidden from members. pre-freeze-acl=' || v_acl);
    ELSE
      EXECUTE format('SELECT count(*) FROM public.%I l WHERE NOT EXISTS (SELECT 1 FROM public.%I b WHERE b.id = l.id AND to_jsonb(b) = to_jsonb(l))',
                     v_table, v_bak) INTO v_stale;
      IF v_stale > 0 THEN
        RAISE EXCEPTION 'VTID-05573: snapshot % already exists and % live row(s) of % are absent from it or differ from it (stale snapshot); drop the stale snapshot deliberately before applying again',
          v_bak, v_stale, v_table USING ERRCODE = 'P0001';
      END IF;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_bak);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', v_bak);
    EXECUTE format('GRANT SELECT ON public.%I TO service_role', v_bak);
    IF v_table = ANY (v_frozen) THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.%I FROM PUBLIC, anon, authenticated, service_role', v_table);
    END IF;
  END LOOP;
END
$mig$;

COMMIT;
