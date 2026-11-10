-- VTID-05571 (mt-data-cleanup-r2 / orphan-analysis-and-quarantine, O4): the move functions. DDL only: this file
-- defines the functions and changes no row. 20261102040300_vtid_05571_orphan_cleanup_run.sql runs them.
-- Apply order and dependency: see 20261102040000_vtid_05571_orphan_analysis.sql.
--
-- Rules, in the order mt_orphan_classified_sql() applies them to an orphan row (tenant_id NULL, ...0001 or not in
-- tenants) and to every row owned by the dev user:
--   1. owner = ...0099 (dev user)                    -> quarantine dev_user_test_data, in any tenant, never remapped
--   2. row already in a live tenant                  -> untouched (a bot-sent chat_messages row with a real tenant stays)
--   3. owner = ...0001 (bot) on tenant ...0001       -> quarantine bot_sender_dev_tenant (R3-F1; never recipient-derived)
--   4. no owner / 0 memberships / 2+ memberships     -> quarantine no_owner / no_membership / ambiguous_membership
--   5. DM whose other party is neither the bot nor a member of the owner's tenant -> quarantine cross_tenant_dm
--   6. otherwise (exactly one user_tenants row)      -> tenant_id := that tenant
-- Never Maxina: no branch writes a fixed tenant id.
--
-- Batching and locks: mt_orphan_cleanup_batch() moves at most p_batch rows (clamped to 1..5000), each row in its own
-- sub-transaction. A row that cannot move (unique or foreign-key conflict on the destination) is copied to the
-- quarantine with reason move_blocked and source_deleted = false, stays in place, and is reported, so one bad row
-- never aborts the run; the apply file then fails loudly if anything orphaned is left. mt_orphan_cleanup_run() sets
-- lock_timeout = 3s and retries a batch that hit lock_not_available up to 5 times, 1s apart. A migration file is one
-- transaction, so the batches of one run share it; at this lane's volume (~1.5k orphan rows) that is one batch per
-- table. Run it off-peak.
-- impact-allow-solo-migration: new service-role-only functions; no gateway or worker code reads them.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION public.mt_orphan_cleanup_batch(p_table text, p_batch integer DEFAULT 2000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_batch     integer := least(greatest(coalesce(p_batch, 2000), 1), 5000);
  v_owner     text;
  v_has_id    boolean;
  v_pk_e      text;
  v_owner_e   text;
  v_bak       text;
  v_rids      tid[];
  v_dec       text[];
  v_tgt       uuid[];
  v_unsnap    bigint;
  i           integer;
  v_remapped  integer := 0;
  v_quar      integer := 0;
  v_blocked   integer := 0;
  v_n         integer;
BEGIN
  SELECT r.owner_col INTO v_owner FROM public.mt_orphan_registry() r WHERE r.table_name = p_table;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mt_orphan_cleanup_batch: % is not in the orphan registry', p_table USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF to_regclass(format('public.%I', p_table)) IS NULL THEN
    RETURN jsonb_build_object('table', p_table, 'present', false, 'remapped', 0, 'quarantined', 0, 'blocked', 0);
  END IF;
  v_bak     := 'bak_mt_data_cleanup_' || p_table;
  v_has_id  := EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = p_table AND c.column_name = 'id');
  v_pk_e    := CASE WHEN v_has_id THEN 't.id::text' ELSE 't.ctid::text' END;
  v_owner_e := CASE WHEN v_owner IS NULL THEN 'NULL::uuid' ELSE format('t.%I', v_owner) END;

  -- The next batch of rows that must change, minus rows already recorded as blocked.
  EXECUTE format($q$
    WITH live AS (SELECT l AS tenant_id FROM public.mt_orphan_live_tenants() l),
         mem AS (SELECT ut.user_id, count(*) AS n, (array_agg(ut.tenant_id))[1] AS only_tenant
                   FROM public.user_tenants ut GROUP BY ut.user_id),
         pick AS (
           SELECT c.rid, c.decision, c.target_tenant, c.pk
             FROM (%1$s) c
            WHERE c.decision <> 'keep'
              AND NOT EXISTS (SELECT 1 FROM public.mt_orphan_quarantine q
                               WHERE q.quarantined_by = 'VTID-05571' AND q.source_table = %2$L
                                 AND q.source_pk = c.pk AND NOT q.source_deleted)
            LIMIT %3$s)
    SELECT array_agg(rid), array_agg(decision), array_agg(target_tenant) FROM pick
  $q$, public.mt_orphan_classified_sql(p_table), p_table, v_batch)
  INTO v_rids, v_dec, v_tgt;

  IF v_rids IS NULL THEN
    RETURN jsonb_build_object('table', p_table, 'present', true, 'remapped', 0, 'quarantined', 0, 'blocked', 0);
  END IF;

  -- Snapshot first (O2): refuse to touch a row that is not in the bak_* table.
  IF v_has_id THEN
    EXECUTE format('SELECT count(*) FROM public.%I t WHERE t.ctid = ANY ($1) AND NOT EXISTS (SELECT 1 FROM public.%I b WHERE b.id = t.id)', p_table, v_bak)
      INTO v_unsnap USING v_rids;
    IF v_unsnap > 0 THEN
      RAISE EXCEPTION 'mt_orphan_cleanup_batch: % rows of % are not in % yet; run mt_orphan_snapshot first', v_unsnap, p_table, v_bak
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;

  FOR i IN 1 .. array_length(v_rids, 1) LOOP
    BEGIN
      IF v_dec[i] = 'remap' THEN
        EXECUTE format('UPDATE public.%I SET tenant_id = $1 WHERE ctid = $2', p_table) USING v_tgt[i], v_rids[i];
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_remapped := v_remapped + v_n;
      ELSE
        EXECUTE format($q$
          INSERT INTO public.mt_orphan_quarantine (source_table, source_pk, original_tenant_id, owner_user_id, reason, payload, source_deleted)
          SELECT %1$L, %2$s, t.tenant_id, %3$s, $2::text, to_jsonb(t.*), true FROM public.%1$I t WHERE t.ctid = $1
          ON CONFLICT (quarantined_by, source_table, source_pk) DO NOTHING
        $q$, p_table, v_pk_e, v_owner_e) USING v_rids[i], v_dec[i];
        EXECUTE format('DELETE FROM public.%I WHERE ctid = $1', p_table) USING v_rids[i];
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_quar := v_quar + v_n;
      END IF;
    EXCEPTION
      WHEN lock_not_available OR deadlock_detected OR query_canceled THEN
        RAISE;
      WHEN OTHERS THEN
        -- The row cannot move (for example a unique or foreign-key conflict). Keep it, record why.
        DECLARE v_state text := SQLSTATE; v_msg text := SQLERRM;
        BEGIN
          EXECUTE format($q$
            INSERT INTO public.mt_orphan_quarantine (source_table, source_pk, original_tenant_id, owner_user_id, reason, payload, source_deleted)
            SELECT %1$L, %2$s, t.tenant_id, %3$s, 'move_blocked',
                   jsonb_build_object('row', to_jsonb(t.*), 'intended', $2::text, 'sqlstate', $3::text, 'message', $4::text), false
              FROM public.%1$I t WHERE t.ctid = $1
            ON CONFLICT (quarantined_by, source_table, source_pk) DO NOTHING
          $q$, p_table, v_pk_e, v_owner_e) USING v_rids[i], v_dec[i], v_state, v_msg;
          v_blocked := v_blocked + 1;
        END;
    END;
  END LOOP;

  RETURN jsonb_build_object('table', p_table, 'present', true,
                            'remapped', v_remapped, 'quarantined', v_quar, 'blocked', v_blocked);
END
$fn$;

-- Runs every present registry table to completion, batch by batch, with lock_timeout and bounded retries.
CREATE OR REPLACE FUNCTION public.mt_orphan_cleanup_run(p_batch integer DEFAULT 2000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  r        record;
  v        jsonb;
  v_tries  integer;
  v_out    jsonb := '[]'::jsonb;
  v_tot    jsonb;
  v_done   integer;
BEGIN
  PERFORM set_config('lock_timeout', '3s', true);
  FOR r IN SELECT g.table_name AS t FROM public.mt_orphan_registry() g LOOP
    IF to_regclass(format('public.%I', r.t)) IS NULL THEN CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = r.t AND c.column_name = 'tenant_id') THEN
      CONTINUE;
    END IF;
    v_tot := jsonb_build_object('table', r.t, 'remapped', 0, 'quarantined', 0, 'blocked', 0);
    v_tries := 0;
    LOOP
      BEGIN
        v := public.mt_orphan_cleanup_batch(r.t, p_batch);
      EXCEPTION WHEN lock_not_available THEN
        v_tries := v_tries + 1;
        IF v_tries >= 5 THEN RAISE; END IF;
        PERFORM pg_sleep(1);
        CONTINUE;
      END;
      v_tries := 0;
      v_done := (v ->> 'remapped')::int + (v ->> 'quarantined')::int + (v ->> 'blocked')::int;
      v_tot := jsonb_build_object('table', r.t,
                 'remapped',    (v_tot ->> 'remapped')::int    + (v ->> 'remapped')::int,
                 'quarantined', (v_tot ->> 'quarantined')::int + (v ->> 'quarantined')::int,
                 'blocked',     (v_tot ->> 'blocked')::int     + (v ->> 'blocked')::int);
      EXIT WHEN v_done = 0;
    END LOOP;
    v_out := v_out || v_tot;
  END LOOP;
  RETURN v_out;
END
$fn$;

DO $grants$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.mt_orphan_cleanup_batch(text, integer)',
    'public.mt_orphan_cleanup_run(integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END
$grants$;

COMMIT;
