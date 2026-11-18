-- VTID-05570 (mt-data-cleanup-r2 / memory-facts-supersede-merge, M1 + M2): the merge and restore functions. DDL only;
-- no row of any table is read or changed when this file is applied. The data change is 20261102041200_..._run.sql,
-- the pre-approved rollback is 20261102041100_..._rollback.sql. Apply order: after the VTID-05571 rows (21-25).
--
-- Why: after the orphan lane reassigns memory_facts to real tenants, a (tenant, user, fact_key, entity) can hold
-- more than one current fact (superseded_by IS NULL). The Vitana assistant's memory should read one current fact per
-- key. The group key is the one write_fact uses (a 'self' and a 'disclosed' fact of the same key are distinct).
--  * public.mt_memfacts_merge(): per group with more than one current fact, the newest extracted_at (id breaks a
--    tie) stays current; every older one gets superseded_by = winner and superseded_at = now(), the same columns
--    write_fact sets. Nothing is deleted; rows that are already superseded are never touched. Before the first
--    change the group's current rows are copied into bak_mt_data_cleanup_memory_facts_merge (created on demand, so
--    no file declares it; first capture wins). Idempotent: a second run finds no group and changes nothing.
--  * public.mt_memfacts_restore(): sets superseded_by / superseded_at of every snapshotted row back to the
--    snapshot values and RAISEs unless they all match. A no-op while no snapshot exists. The snapshot is kept
--    (30-day retention, then dropped by a later owner-approved step).
-- Both are SECURITY DEFINER, service_role only. They are self-contained and touch only memory_facts and the snapshot.
-- impact-allow-solo-migration: new service-role-only functions; no gateway or worker code calls them.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION public.mt_memfacts_merge()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_bak     constant text := 'bak_mt_data_cleanup_memory_facts_merge';
  v_groups  bigint;
  v_snap    bigint;
  v_sup     bigint;
BEGIN
  -- Snapshot table: on demand, same columns as memory_facts plus backed_up_at; service_role only.
  EXECUTE format('CREATE TABLE IF NOT EXISTS public.%I (LIKE public.memory_facts)', v_bak);
  EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS backed_up_at timestamptz NOT NULL DEFAULT now()', v_bak);
  EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON public.%I (id)', v_bak || '_id_uq', v_bak);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_bak);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', v_bak);
  EXECUTE format('GRANT ALL ON public.%I TO service_role', v_bak);

  -- No concurrent writer between the snapshot and the update.
  LOCK TABLE public.memory_facts IN SHARE ROW EXCLUSIVE MODE;

  -- Snapshot (first capture wins): every current row of every group that has more than one.
  EXECUTE format($q$
    INSERT INTO public.%I
    SELECT m.*, now()
      FROM public.memory_facts m
     WHERE m.superseded_by IS NULL
       AND EXISTS (SELECT 1 FROM public.memory_facts o
                    WHERE o.superseded_by IS NULL AND o.id <> m.id
                      AND o.tenant_id = m.tenant_id AND o.user_id = m.user_id
                      AND o.fact_key = m.fact_key AND o.entity = m.entity)
    ON CONFLICT (id) DO NOTHING
  $q$, v_bak);
  GET DIAGNOSTICS v_snap = ROW_COUNT;

  -- Supersede the older current rows of each group by the newest one.
  WITH ranked AS (
    SELECT id,
           first_value(id) OVER w AS winner_id,
           row_number()    OVER w AS rn
      FROM public.memory_facts
     WHERE superseded_by IS NULL
    WINDOW w AS (PARTITION BY tenant_id, user_id, fact_key, entity ORDER BY extracted_at DESC, id DESC)
  ), losers AS (
    SELECT id, winner_id FROM ranked WHERE rn > 1
  ), upd AS (
    UPDATE public.memory_facts m
       SET superseded_by = l.winner_id, superseded_at = now()
      FROM losers l
     WHERE m.id = l.id
    RETURNING m.tenant_id, m.user_id, m.fact_key, m.entity
  )
  SELECT count(*), (SELECT count(*) FROM (SELECT DISTINCT tenant_id, user_id, fact_key, entity FROM upd) g)
    INTO v_sup, v_groups FROM upd;

  RETURN jsonb_build_object('groups', v_groups, 'superseded', v_sup, 'snapshotted', v_snap);
END
$fn$;

CREATE OR REPLACE FUNCTION public.mt_memfacts_restore()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_bak      constant text := 'bak_mt_data_cleanup_memory_facts_merge';
  v_restored bigint := 0;
  v_left     bigint;
BEGIN
  IF to_regclass('public.' || v_bak) IS NULL THEN
    RETURN jsonb_build_object('restored', 0, 'snapshot', false);
  END IF;

  LOCK TABLE public.memory_facts IN SHARE ROW EXCLUSIVE MODE;

  EXECUTE format($q$
    UPDATE public.memory_facts m
       SET superseded_by = b.superseded_by, superseded_at = b.superseded_at
      FROM public.%I b
     WHERE m.id = b.id
       AND (m.superseded_by IS DISTINCT FROM b.superseded_by OR m.superseded_at IS DISTINCT FROM b.superseded_at)
  $q$, v_bak);
  GET DIAGNOSTICS v_restored = ROW_COUNT;

  EXECUTE format($q$
    SELECT count(*) FROM public.memory_facts m JOIN public.%I b ON b.id = m.id
     WHERE m.superseded_by IS DISTINCT FROM b.superseded_by OR m.superseded_at IS DISTINCT FROM b.superseded_at
  $q$, v_bak) INTO v_left;
  IF v_left > 0 THEN
    RAISE EXCEPTION 'VTID-05570 restore: % snapshot rows do not match their snapshot state', v_left;
  END IF;

  RETURN jsonb_build_object('restored', v_restored, 'snapshot', true);
END
$fn$;

REVOKE ALL ON FUNCTION public.mt_memfacts_merge()   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mt_memfacts_restore() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mt_memfacts_merge()   TO service_role;
GRANT EXECUTE ON FUNCTION public.mt_memfacts_restore() TO service_role;

COMMENT ON FUNCTION public.mt_memfacts_merge() IS
  'VTID-05570: supersede-merge duplicate current memory_facts per (tenant,user,fact_key,entity); snapshot first; no delete. Service role only.';
COMMENT ON FUNCTION public.mt_memfacts_restore() IS
  'VTID-05570: restore superseded_by/superseded_at of snapshotted memory_facts rows; no-op without a snapshot. Service role only.';

COMMIT;
