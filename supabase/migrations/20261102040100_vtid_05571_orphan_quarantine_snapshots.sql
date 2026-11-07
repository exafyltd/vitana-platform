-- VTID-05571 (mt-data-cleanup-r2 / orphan-analysis-and-quarantine, O2 + O3): quarantine table and bak_* snapshots.
-- DDL and two functions only; no row of any existing table is read into or changed by this file. Apply order and
-- the dependency on mt-identity-r2 membership-unification: see 20261102040000_vtid_05571_orphan_analysis.sql.
--
--  * public.mt_orphan_quarantine: where orphan rows go instead of a live tenant (dev user ...0099, the bot user on the
--    dead dev tenant, owners with 0 or 2+ memberships, unattributable DMs). RLS on, service_role only, no policy for
--    anon/authenticated: it is excluded from every member-facing surface (rules 43-45). The original row is kept
--    whole in payload so nothing is lost; the lane never deletes anything that is not first copied here AND
--    snapshotted in bak_*.
--  * public.bak_mt_data_cleanup_<table>: a copy of every row the move will remap or quarantine, columns identical to
--    the source plus backed_up_at. Created and filled by mt_orphan_snapshot() before any move. RLS on, service_role
--    only. Retained 30 days (collaboration §4.7 / plan), then dropped by a later owner-approved step.
-- The four tables that exist in every environment are declared literally so MIGRATION-DRIFT-CHECK sees them; the
-- d43-d50 / availability tables are created on demand (they are absent from some databases).
-- impact-allow-solo-migration: new service-role-only tables and functions; no gateway or worker code reads them.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE IF NOT EXISTS public.mt_orphan_quarantine (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_table       text        NOT NULL,
  source_pk          text        NOT NULL,
  original_tenant_id uuid        NULL,
  owner_user_id      uuid        NULL,
  reason             text        NOT NULL CHECK (reason IN (
                       'dev_user_test_data', 'bot_sender_dev_tenant', 'bot_sender_orphan_tenant', 'no_owner',
                       'no_membership', 'ambiguous_membership', 'cross_tenant_dm', 'move_blocked')),
  payload            jsonb       NOT NULL,
  source_deleted     boolean     NOT NULL DEFAULT true,
  quarantined_by     text        NOT NULL DEFAULT 'VTID-05571',
  quarantined_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS mt_orphan_quarantine_source_uq
  ON public.mt_orphan_quarantine (quarantined_by, source_table, source_pk);
CREATE INDEX IF NOT EXISTS mt_orphan_quarantine_reason_idx
  ON public.mt_orphan_quarantine (quarantined_by, reason);

COMMENT ON TABLE public.mt_orphan_quarantine IS
  'VTID-05571: orphan rows removed from tenant tables for manual review (never remapped to a live tenant). Service role only; hidden from members.';

CREATE TABLE IF NOT EXISTS public.bak_mt_data_cleanup_memory_facts      (LIKE public.memory_facts);
CREATE TABLE IF NOT EXISTS public.bak_mt_data_cleanup_memory_items      (LIKE public.memory_items);
CREATE TABLE IF NOT EXISTS public.bak_mt_data_cleanup_chat_messages     (LIKE public.chat_messages);
CREATE TABLE IF NOT EXISTS public.bak_mt_data_cleanup_user_notifications (LIKE public.user_notifications);

-- Creates (if absent) and secures the snapshot table of one source table. Idempotent.
CREATE OR REPLACE FUNCTION public.mt_orphan_ensure_snapshot_table(p_table text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_bak text := 'bak_mt_data_cleanup_' || p_table;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.mt_orphan_registry() r WHERE r.table_name = p_table) THEN
    RAISE EXCEPTION 'mt_orphan_ensure_snapshot_table: % is not in the orphan registry', p_table USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF to_regclass(format('public.%I', p_table)) IS NULL THEN
    RAISE EXCEPTION 'mt_orphan_ensure_snapshot_table: public.% does not exist', p_table USING ERRCODE = 'undefined_table';
  END IF;
  EXECUTE format('CREATE TABLE IF NOT EXISTS public.%I (LIKE public.%I)', v_bak, p_table);
  EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS backed_up_at timestamptz NOT NULL DEFAULT now()', v_bak);
  EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON public.%I (id)', v_bak || '_id_uq', v_bak);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', v_bak);
  EXECUTE format('GRANT ALL ON public.%I TO service_role', v_bak);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_bak);
  EXECUTE format('COMMENT ON TABLE public.%I IS %L', v_bak,
                 'VTID-05571: pre-move copy of orphan rows of ' || p_table || '. Service role only. Retain 30 days.');
  RETURN v_bak;
END
$fn$;

-- O2: copy every row the move would remap or quarantine into the snapshot (rows already captured are kept as first
-- captured, so a second run never overwrites the original state). Returns the number of rows newly captured.
CREATE OR REPLACE FUNCTION public.mt_orphan_snapshot(p_table text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_bak  text;
  v_cols text;
  v_n    bigint;
BEGIN
  v_bak := public.mt_orphan_ensure_snapshot_table(p_table);
  SELECT string_agg(format('%I', c.column_name), ', ' ORDER BY c.ordinal_position)
    INTO v_cols
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = p_table AND c.is_generated = 'NEVER';
  IF v_cols IS NULL OR v_cols !~ '(^|, )"?id"?(,|$)' THEN
    RAISE EXCEPTION 'mt_orphan_snapshot: public.% has no id column to key the snapshot on', p_table USING ERRCODE = 'undefined_column';
  END IF;

  EXECUTE format($q$
    WITH live AS (SELECT l AS tenant_id FROM public.mt_orphan_live_tenants() l),
         mem AS (SELECT ut.user_id, count(*) AS n, (array_agg(ut.tenant_id))[1] AS only_tenant
                   FROM public.user_tenants ut GROUP BY ut.user_id),
         pick AS (SELECT c.rid FROM (%1$s) c WHERE c.decision <> 'keep')
    INSERT INTO public.%2$I (%3$s)
    SELECT %4$s FROM public.%5$I t JOIN pick ON pick.rid = t.ctid
     WHERE NOT EXISTS (SELECT 1 FROM public.%2$I b WHERE b.id = t.id)
  $q$, public.mt_orphan_classified_sql(p_table), v_bak, v_cols,
       (SELECT string_agg(format('t.%I', c.column_name), ', ' ORDER BY c.ordinal_position)
          FROM information_schema.columns c
         WHERE c.table_schema = 'public' AND c.table_name = p_table AND c.is_generated = 'NEVER'),
       p_table);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;

-- Snapshots every registry table that is present, with the columns the classification needs.
CREATE OR REPLACE FUNCTION public.mt_orphan_snapshot_all()
RETURNS TABLE (table_name text, captured bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE r record;
BEGIN
  FOR r IN SELECT g.table_name AS t, g.owner_col AS o, g.peer_col AS p FROM public.mt_orphan_registry() g LOOP
    IF (SELECT count(*) FROM information_schema.columns c
         WHERE c.table_schema = 'public' AND c.table_name = r.t
           AND c.column_name = ANY (ARRAY['tenant_id', 'id'] || COALESCE(ARRAY[r.o], '{}') || COALESCE(ARRAY[r.p], '{}')))
       < 2 + (r.o IS NOT NULL)::int + (r.p IS NOT NULL)::int THEN
      CONTINUE;
    END IF;
    table_name := r.t;
    captured := public.mt_orphan_snapshot(r.t);
    RETURN NEXT;
  END LOOP;
END
$fn$;

-- O5 (called by 20261102040300_vtid_05571_orphan_cleanup_rollback.sql): restore every touched table from its snapshot
-- and clear this lane's quarantine rows. Re-inserts rows that were quarantined, puts remapped rows back on their
-- original tenant_id, then verifies row for row and RAISEs if anything is not back. The bak_* tables are kept.
CREATE OR REPLACE FUNCTION public.mt_orphan_restore()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  r       record;
  v_bak   text;
  v_cols  text;
  v_scols text;
  v_n     bigint;
  v_bad   bigint;
  v_out   jsonb := '[]'::jsonb;
BEGIN
  FOR r IN SELECT g.table_name AS t FROM public.mt_orphan_registry() g LOOP
    v_bak := 'bak_mt_data_cleanup_' || r.t;
    IF to_regclass(format('public.%I', r.t)) IS NULL OR to_regclass(format('public.%I', v_bak)) IS NULL THEN
      CONTINUE;
    END IF;
    SELECT string_agg(format('%I', c.column_name), ', ' ORDER BY c.ordinal_position),
           string_agg(format('b.%I', c.column_name), ', ' ORDER BY c.ordinal_position)
      INTO v_cols, v_scols
      FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = r.t AND c.is_generated = 'NEVER';

    EXECUTE format($q$
      INSERT INTO public.%1$I (%2$s)
      SELECT %3$s FROM public.%4$I b
      ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
    $q$, r.t, v_cols, v_scols, v_bak);
    GET DIAGNOSTICS v_n = ROW_COUNT;

    EXECUTE format($q$
      SELECT count(*) FROM public.%1$I b
       WHERE NOT EXISTS (SELECT 1 FROM public.%2$I t WHERE t.id = b.id AND t.tenant_id IS NOT DISTINCT FROM b.tenant_id)
    $q$, v_bak, r.t) INTO v_bad;
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'VTID-05571 restore: % snapshot rows of % are not back with their original tenant_id', v_bad, r.t;
    END IF;
    v_out := v_out || jsonb_build_object('table', r.t, 'restored', v_n);
  END LOOP;

  DELETE FROM public.mt_orphan_quarantine WHERE quarantined_by = 'VTID-05571';
  RETURN v_out;
END
$fn$;

DO $grants$
DECLARE t text; f text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'mt_orphan_quarantine',
    'bak_mt_data_cleanup_memory_facts',
    'bak_mt_data_cleanup_memory_items',
    'bak_mt_data_cleanup_chat_messages',
    'bak_mt_data_cleanup_user_notifications'
  ] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['memory_facts', 'memory_items', 'chat_messages', 'user_notifications'] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS backed_up_at timestamptz NOT NULL DEFAULT now()', 'bak_mt_data_cleanup_' || t);
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON public.%I (id)', 'bak_mt_data_cleanup_' || t || '_id_uq', 'bak_mt_data_cleanup_' || t);
    EXECUTE format('COMMENT ON TABLE public.%I IS %L', 'bak_mt_data_cleanup_' || t,
                   'VTID-05571: pre-move copy of orphan rows of ' || t || '. Service role only. Retain 30 days.');
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'public.mt_orphan_ensure_snapshot_table(text)',
    'public.mt_orphan_snapshot(text)',
    'public.mt_orphan_snapshot_all()',
    'public.mt_orphan_restore()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END
$grants$;

COMMIT;
