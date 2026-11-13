-- VTID-05571 apply, revised 2026-11-13 (owner decision: every row moves with a copy kept; referencing orphans move before
-- their parents; a live reference is recorded, never deleted). Replaces the apply in 20261102040300 for this run.
-- Changes against 20261102040200 (DDL, already applied): new reason cascade_child_of_orphan; children that a parent's
-- ON DELETE CASCADE would remove are copied first; a row whose delete hits a foreign key is deferred and retried in
-- later passes; only rows still blocked after no progress are recorded as move_blocked (with the constraint name).
-- Still copy first, delete last. The completion check asserts zero orphan rows left.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '600s';

DO $chk$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.mt_orphan_quarantine'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) ILIKE '%reason%' LOOP
    EXECUTE format('ALTER TABLE public.mt_orphan_quarantine DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE public.mt_orphan_quarantine ADD CONSTRAINT mt_orphan_quarantine_reason_check CHECK (reason IN (
    'dev_user_test_data', 'bot_sender_dev_tenant', 'bot_sender_orphan_tenant', 'no_owner',
    'no_membership', 'ambiguous_membership', 'cross_tenant_dm', 'move_blocked', 'cascade_child_of_orphan'));
END
$chk$;

-- Copies the rows that a cascade would delete with their parent, before the parent is deleted.
CREATE OR REPLACE FUNCTION public.mt_orphan_copy_cascade_children()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_mi  text[];
  v_cm  text[];
  v_n   bigint := 0;
  v_k   bigint;
BEGIN
  EXECUTE format($q$
    WITH live AS (SELECT l AS tenant_id FROM public.mt_orphan_live_tenants() l),
         mem AS (SELECT ut.user_id, count(*) AS n, (array_agg(ut.tenant_id))[1] AS only_tenant
                   FROM public.user_tenants ut GROUP BY ut.user_id)
    SELECT coalesce(array_agg(c.pk::text), ARRAY[]::text[]) FROM (%1$s) c WHERE c.decision <> 'keep'
  $q$, public.mt_orphan_classified_sql('memory_items')) INTO v_mi;

  EXECUTE format($q$
    WITH live AS (SELECT l AS tenant_id FROM public.mt_orphan_live_tenants() l),
         mem AS (SELECT ut.user_id, count(*) AS n, (array_agg(ut.tenant_id))[1] AS only_tenant
                   FROM public.user_tenants ut GROUP BY ut.user_id)
    SELECT coalesce(array_agg(c.pk::text), ARRAY[]::text[]) FROM (%1$s) c WHERE c.decision <> 'keep'
  $q$, public.mt_orphan_classified_sql('chat_messages')) INTO v_cm;

  -- memory_confidence_history.memory_item_id -> memory_items.id ON DELETE CASCADE
  INSERT INTO public.mt_orphan_quarantine (source_table, source_pk, original_tenant_id, owner_user_id, reason, payload, source_deleted)
  SELECT 'memory_confidence_history', coalesce(to_jsonb(ch) ->> 'id', ch.ctid::text), NULL, NULL,
         'cascade_child_of_orphan', to_jsonb(ch), true
    FROM public.memory_confidence_history ch
   WHERE ch.memory_item_id::text = ANY (v_mi)
  ON CONFLICT (quarantined_by, source_table, source_pk) DO NOTHING;
  GET DIAGNOSTICS v_k = ROW_COUNT;
  v_n := v_n + v_k;

  -- chat_message_replies.message_id and parent_message_id -> chat_messages.id ON DELETE CASCADE
  INSERT INTO public.mt_orphan_quarantine (source_table, source_pk, original_tenant_id, owner_user_id, reason, payload, source_deleted)
  SELECT 'chat_message_replies', coalesce(to_jsonb(ch) ->> 'id', ch.ctid::text), NULL, NULL,
         'cascade_child_of_orphan', to_jsonb(ch), true
    FROM public.chat_message_replies ch
   WHERE ch.message_id::text = ANY (v_cm) OR ch.parent_message_id::text = ANY (v_cm)
  ON CONFLICT (quarantined_by, source_table, source_pk) DO NOTHING;
  GET DIAGNOSTICS v_k = ROW_COUNT;
  v_n := v_n + v_k;

  RETURN v_n;
END
$fn$;

-- One pass over one table. A row whose delete hits a foreign key is deferred (p_final = false) or, in the final pass
-- (p_final = true), recorded as move_blocked with the constraint named in the message.
CREATE OR REPLACE FUNCTION public.mt_orphan_cleanup_batch_v2(p_table text, p_batch integer, p_final boolean)
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
  v_deferred  integer := 0;
  v_n         integer;
BEGIN
  SELECT r.owner_col INTO v_owner FROM public.mt_orphan_registry() r WHERE r.table_name = p_table;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mt_orphan_cleanup_batch_v2: % is not in the orphan registry', p_table USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF to_regclass(format('public.%I', p_table)) IS NULL THEN
    RETURN jsonb_build_object('table', p_table, 'present', false, 'remapped', 0, 'quarantined', 0, 'blocked', 0, 'deferred', 0);
  END IF;
  v_bak     := 'bak_mt_data_cleanup_' || p_table;
  v_has_id  := EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = p_table AND c.column_name = 'id');
  v_pk_e    := CASE WHEN v_has_id THEN 't.id::text' ELSE 't.ctid::text' END;
  v_owner_e := CASE WHEN v_owner IS NULL THEN 'NULL::uuid' ELSE format('t.%I', v_owner) END;

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
    RETURN jsonb_build_object('table', p_table, 'present', true, 'remapped', 0, 'quarantined', 0, 'blocked', 0, 'deferred', 0);
  END IF;

  IF v_has_id THEN
    EXECUTE format('SELECT count(*) FROM public.%I t WHERE t.ctid = ANY ($1) AND NOT EXISTS (SELECT 1 FROM public.%I b WHERE b.id = t.id)', p_table, v_bak)
      INTO v_unsnap USING v_rids;
    IF v_unsnap > 0 THEN
      RAISE EXCEPTION 'mt_orphan_cleanup_batch_v2: % rows of % are not in % yet; run mt_orphan_snapshot first', v_unsnap, p_table, v_bak
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
        IF SQLSTATE = '23503' AND NOT p_final THEN
          -- A referencing row still exists. The sub-transaction is rolled back; retry in a later pass.
          v_deferred := v_deferred + 1;
        ELSE
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
        END IF;
    END;
  END LOOP;

  RETURN jsonb_build_object('table', p_table, 'present', true,
                            'remapped', v_remapped, 'quarantined', v_quar, 'blocked', v_blocked, 'deferred', v_deferred);
END
$fn$;

-- Passes over every present table until a pass moves nothing; then records what is left as blocked.
CREATE OR REPLACE FUNCTION public.mt_orphan_cleanup_run_v2(p_batch integer DEFAULT 2000)
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
  v_moved  integer;
BEGIN
  PERFORM set_config('lock_timeout', '3s', true);
  FOR r IN SELECT g.table_name AS t FROM public.mt_orphan_registry() g LOOP
    IF to_regclass(format('public.%I', r.t)) IS NULL THEN CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = r.t AND c.column_name = 'tenant_id') THEN
      CONTINUE;
    END IF;
    v_tot := jsonb_build_object('table', r.t, 'remapped', 0, 'quarantined', 0, 'blocked', 0, 'deferred', 0, 'passes', 0);

    -- Phase 1: passes that move every row they can. Rows deferred by a foreign key are retried next pass.
    LOOP
      v_tries := 0;
      LOOP
        BEGIN
          v := public.mt_orphan_cleanup_batch_v2(r.t, p_batch, false);
          EXIT;
        EXCEPTION WHEN lock_not_available THEN
          v_tries := v_tries + 1;
          IF v_tries >= 5 THEN RAISE; END IF;
          PERFORM pg_sleep(1);
        END;
      END LOOP;
      v_moved := (v ->> 'remapped')::int + (v ->> 'quarantined')::int;
      v_tot := jsonb_build_object('table', r.t,
                 'remapped',    (v_tot ->> 'remapped')::int    + (v ->> 'remapped')::int,
                 'quarantined', (v_tot ->> 'quarantined')::int + (v ->> 'quarantined')::int,
                 'blocked',     (v_tot ->> 'blocked')::int     + (v ->> 'blocked')::int,
                 'deferred',    (v ->> 'deferred')::int,
                 'passes',      (v_tot ->> 'passes')::int + 1);
      EXIT WHEN v_moved = 0;
    END LOOP;

    -- Phase 2: no progress. Whatever is still deferred has a reference that is not going away: record it.
    LOOP
      v := public.mt_orphan_cleanup_batch_v2(r.t, p_batch, true);
      v_moved := (v ->> 'remapped')::int + (v ->> 'quarantined')::int + (v ->> 'blocked')::int;
      v_tot := jsonb_build_object('table', r.t,
                 'remapped',    (v_tot ->> 'remapped')::int    + (v ->> 'remapped')::int,
                 'quarantined', (v_tot ->> 'quarantined')::int + (v ->> 'quarantined')::int,
                 'blocked',     (v_tot ->> 'blocked')::int     + (v ->> 'blocked')::int,
                 'deferred',    0,
                 'passes',      (v_tot ->> 'passes')::int);
      EXIT WHEN v_moved = 0;
    END LOOP;
    v_out := v_out || v_tot;
  END LOOP;
  RETURN v_out;
END
$fn$;

REVOKE ALL ON FUNCTION public.mt_orphan_copy_cascade_children() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mt_orphan_copy_cascade_children() TO service_role;
REVOKE ALL ON FUNCTION public.mt_orphan_cleanup_batch_v2(text, integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mt_orphan_cleanup_batch_v2(text, integer, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.mt_orphan_cleanup_run_v2(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mt_orphan_cleanup_run_v2(integer) TO service_role;

-- Apply: snapshot every row that will move (O2), copy the cascade children, move, then assert zero orphan rows left.
DO $apply$
DECLARE
  v_members  bigint;
  v_snap     jsonb;
  v_casc     bigint;
  v_run      jsonb;
  v_left     bigint;
  v_blocked  bigint;
BEGIN
  IF to_regclass('public.user_tenants') IS NULL THEN
    RAISE EXCEPTION 'VTID-05571: public.user_tenants is missing; apply mt-identity-r2 membership-unification first';
  END IF;
  SELECT count(*) INTO v_members FROM public.user_tenants;
  IF v_members = 0 AND EXISTS (SELECT 1 FROM public.analyze_orphan_rows() a WHERE a.decision = 'no_membership' AND a.row_count > 0) THEN
    RAISE EXCEPTION 'VTID-05571: public.user_tenants is empty but orphan rows have owners; apply mt-identity-r2 membership-unification (backfill) first';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('table', s.table_name, 'captured', s.captured)), '[]'::jsonb)
    INTO v_snap FROM public.mt_orphan_snapshot_all() s;
  RAISE NOTICE 'VTID-05571 snapshot: %', v_snap;

  v_casc := public.mt_orphan_copy_cascade_children();
  RAISE NOTICE 'VTID-05571 cascade children copied first: %', v_casc;

  v_run := public.mt_orphan_cleanup_run_v2(2000);
  RAISE NOTICE 'VTID-05571 move: %', v_run;

  SELECT coalesce(sum(a.row_count), 0) INTO v_left
    FROM public.analyze_orphan_rows() a
   WHERE a.decision IS NOT NULL AND a.decision <> 'keep';
  IF v_left > 0 THEN
    SELECT count(*) INTO v_blocked FROM public.mt_orphan_quarantine q
     WHERE q.quarantined_by = 'VTID-05571' AND q.reason = 'move_blocked' AND NOT q.source_deleted;
    RAISE EXCEPTION 'VTID-05571: % orphan rows remain after the move (% blocked, see mt_orphan_quarantine reason move_blocked); rolling back', v_left, v_blocked;
  END IF;
END
$apply$;

COMMIT;
