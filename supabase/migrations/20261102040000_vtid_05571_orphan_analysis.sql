-- VTID-05571 (mt-data-cleanup-r2 / orphan-analysis-and-quarantine, O1): read-only orphan analysis.
--
-- Apply order for this lane (each file in its own RUN-MIGRATION dispatch, only after the owner approves the files and
-- the target database, collaboration.md §7d; nothing is applied from the PR):
--   20261102040000  this file       helpers + analyze_orphan_rows()        (DDL only, no data change)
--   20261102040100  quarantine      mt_orphan_quarantine + bak_* snapshots (DDL only, no data change)
--   20261102040200  move logic      snapshot / batch-move functions        (DDL only, no data change)
--   20261102040300  apply           snapshot, then move, then assert zero  (the data change; rollback file next to it)
--   20261102040400  writer repoint  gate + 19 NULL-fallback writers       (rollback file next to it)
-- Depends on mt-identity-r2 membership-unification (docs/multitenancy/MIGRATION-QUEUE.md rows 14-16): the canonical
-- public.user_tenants store. 20261102040300 refuses to run without it.
--
-- Premise 1 of the plan: the literal 00000000-0000-0000-0000-000000000001 is overloaded. On tenant_id it is the dead
-- dev tenant, on sender_id/user_id it is the Vitana bot user (services/gateway/src/lib/vitana-bot.ts:9), and
-- ...0099 is the dev test user (services/gateway/src/services/orb-memory-bridge.ts:68). Every count below is split
-- by tenant class x owner class so the two meanings are never merged.
--
-- Tenant classes: null | dev_0001 | nonexistent_550e8400 | nonexistent_other | live
-- Owner classes:  no_owner | dev_0099 | bot_0001 | member_none (0 memberships) | member_single (1) | member_multi (2+)
-- Decisions (what the move would do; the analysis never does it):
--   keep                 row is in a live tenant and its owner is not the dev user
--   remap                orphan row whose owner has exactly one user_tenants row: tenant_id -> that tenant
--   dev_user_test_data   owner is ...0099 (never remapped to any live tenant, quarantined)
--   bot_sender_dev_tenant   owner is the bot and tenant_id = ...0001 (R3-F1: never recipient-derived)
--   bot_sender_orphan_tenant owner is the bot and tenant_id is NULL/nonexistent
--   no_owner | no_membership | ambiguous_membership | cross_tenant_dm   quarantine, never defaulted to Maxina
--
-- Everything here is SECURITY DEFINER with search_path = '' and EXECUTE for service_role only.
-- impact-allow-solo-migration: new service-role-only functions; no gateway or worker code reads them yet.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

-- The tables the cleanup covers. owner_col is the column that names the row's owner; peer_col is set only where the
-- row addresses a second user (chat_messages DMs). A table that does not exist (or lacks tenant_id/id/owner_col) is
-- reported as absent and never touched, so one registry serves every database state.
CREATE OR REPLACE FUNCTION public.mt_orphan_registry()
RETURNS TABLE (table_name text, owner_col text, peer_col text)
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $fn$
  SELECT * FROM (VALUES
    ('memory_facts',                    'user_id',   NULL),
    ('memory_items',                    'user_id',   NULL),
    ('chat_messages',                   'sender_id', 'receiver_id'),
    ('user_notifications',              'user_id',   NULL),
    ('product_analytics_events',        NULL,        NULL),
    ('user_personal_boundaries',        'user_id',   NULL),
    ('user_consent_states',             'user_id',   NULL),
    ('boundary_check_audit',            'user_id',   NULL),
    ('d43_longitudinal_data_points',    'user_id',   NULL),
    ('d43_drift_events',                'user_id',   NULL),
    ('d43_adaptation_plans',            'user_id',   NULL),
    ('d43_preference_snapshots',        'user_id',   NULL),
    ('d44_predictive_signals',          'user_id',   NULL),
    ('d44_signal_evidence',             'user_id',   NULL),
    ('d44_intervention_history',        'user_id',   NULL),
    ('d45_predictive_windows',          'user_id',   NULL),
    ('d45_window_feedback',             'user_id',   NULL),
    ('d45_forecast_history',            'user_id',   NULL),
    ('anticipatory_guidance',           'user_id',   NULL),
    ('contextual_opportunities',        'user_id',   NULL),
    ('risk_mitigations',                'user_id',   NULL),
    ('d50_positive_reinforcements',     'user_id',   NULL),
    ('d50_trajectory_eligibility_cache','user_id',   NULL),
    ('availability_assessments',        'user_id',   NULL),
    ('availability_overrides',          'user_id',   NULL),
    ('availability_config',             NULL,        NULL)
  ) AS r(table_name, owner_col, peer_col)
$fn$;

-- Every tenant id that exists. Production carries tenants.tenant_id (most FKs) and the bootstrap id column; both are
-- accepted so a drifted schema cannot make a live tenant look orphaned.
CREATE OR REPLACE FUNCTION public.mt_orphan_live_tenants()
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_cols text[];
  v_sql  text;
BEGIN
  SELECT array_agg(c.column_name::text ORDER BY c.column_name)
    INTO v_cols
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'tenants' AND c.column_name IN ('tenant_id', 'id');
  IF v_cols IS NULL THEN
    RAISE EXCEPTION 'public.tenants has neither tenant_id nor id' USING ERRCODE = 'undefined_column';
  END IF;
  SELECT string_agg(format('SELECT %I::uuid FROM public.tenants', col), ' UNION ') INTO v_sql FROM unnest(v_cols) AS col;
  RETURN QUERY EXECUTE v_sql;
END
$fn$;

-- The classified rows of one registry table as a SELECT text: rid (ctid), pk, tenant_id, owner_id, tclass, oclass,
-- decision, target_tenant. Shared by the analysis (O1) and the move (O4) so both agree row for row.
CREATE OR REPLACE FUNCTION public.mt_orphan_classified_sql(p_table text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_owner   text;
  v_peer    text;
  v_has_id  boolean;
  v_owner_e text;
  v_pk_e    text;
  v_cross_e text;
BEGIN
  SELECT r.owner_col, r.peer_col INTO v_owner, v_peer FROM public.mt_orphan_registry() r WHERE r.table_name = p_table;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mt_orphan_classified_sql: % is not in the orphan registry', p_table USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns c
                  WHERE c.table_schema = 'public' AND c.table_name = p_table AND c.column_name = 'id')
    INTO v_has_id;
  v_owner_e := CASE WHEN v_owner IS NULL THEN 'NULL::uuid' ELSE format('t.%I', v_owner) END;
  v_pk_e    := CASE WHEN v_has_id THEN 't.id::text' ELSE 't.ctid::text' END;
  -- A DM is attributable to the sender's tenant only when the other party is the bot or a member of that tenant.
  -- A NULL peer is not a DM at all (group messages carry receiver_id NULL + group_id, VTID-03089): it is never a
  -- cross-tenant DM, so it follows the sender's single-membership remap. Without the explicit IS NOT NULL the
  -- comparison is NULL, the decision still reads 'remap' and target_tenant becomes NULL (VTID-05571 review finding).
  v_cross_e := CASE WHEN v_peer IS NULL THEN 'false' ELSE format(
    $c$(m.only_tenant IS NOT NULL
        AND t.%1$I IS NOT NULL
        AND t.%1$I <> '00000000-0000-0000-0000-000000000001'::uuid
        AND NOT EXISTS (SELECT 1 FROM public.user_tenants p WHERE p.user_id = t.%1$I AND p.tenant_id = m.only_tenant))$c$,
    v_peer) END;

  RETURN format($q$
    SELECT s.rid, s.pk, s.tenant_id, s.owner_id, s.tclass, s.oclass,
           CASE
             WHEN s.oclass = 'dev_0099' THEN 'dev_user_test_data'
             WHEN s.tclass = 'live' THEN 'keep'
             WHEN s.oclass = 'bot_0001' AND s.tclass = 'dev_0001' THEN 'bot_sender_dev_tenant'
             WHEN s.oclass = 'bot_0001' THEN 'bot_sender_orphan_tenant'
             WHEN s.oclass = 'no_owner' THEN 'no_owner'
             WHEN s.oclass = 'member_none' THEN 'no_membership'
             WHEN s.oclass = 'member_multi' THEN 'ambiguous_membership'
             WHEN s.cross_dm THEN 'cross_tenant_dm'
             ELSE 'remap'
           END AS decision,
           CASE WHEN s.oclass = 'member_single' AND s.tclass <> 'live' AND NOT s.cross_dm THEN s.only_tenant END AS target_tenant
      FROM (
        SELECT t.ctid AS rid, %1$s AS pk, t.tenant_id AS tenant_id, %2$s AS owner_id,
               CASE
                 WHEN t.tenant_id IS NULL THEN 'null'
                 WHEN t.tenant_id = '00000000-0000-0000-0000-000000000001'::uuid THEN 'dev_0001'
                 WHEN t.tenant_id IN (SELECT l.tenant_id FROM live l) THEN 'live'
                 WHEN t.tenant_id::text LIKE '550e8400-%%' THEN 'nonexistent_550e8400'
                 ELSE 'nonexistent_other'
               END AS tclass,
               CASE
                 WHEN %2$s IS NULL THEN 'no_owner'
                 WHEN %2$s = '00000000-0000-0000-0000-000000000099'::uuid THEN 'dev_0099'
                 WHEN %2$s = '00000000-0000-0000-0000-000000000001'::uuid THEN 'bot_0001'
                 WHEN m.n IS NULL THEN 'member_none'
                 WHEN m.n = 1 THEN 'member_single'
                 ELSE 'member_multi'
               END AS oclass,
               m.only_tenant AS only_tenant,
               %3$s AS cross_dm
          FROM public.%4$I t
          LEFT JOIN mem m ON m.user_id = %2$s
      ) s
  $q$, v_pk_e, v_owner_e, v_cross_e, p_table);
END
$fn$;

-- O1: per-table counts split by tenant class x owner class, with the decision the move would take.
-- STABLE: PostgreSQL itself rejects any write from this function. One row per registry table that is absent.
CREATE OR REPLACE FUNCTION public.analyze_orphan_rows()
RETURNS TABLE (table_name text, table_present boolean, tenant_class text, owner_class text, decision text, row_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  r       record;
  v_found integer;
  v_cols  integer;
BEGIN
  FOR r IN SELECT g.table_name AS t, g.owner_col AS o, g.peer_col AS p FROM public.mt_orphan_registry() g LOOP
    SELECT count(*) INTO v_cols
      FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = r.t
       AND c.column_name = ANY (ARRAY['tenant_id'] || COALESCE(ARRAY[r.o], '{}') || COALESCE(ARRAY[r.p], '{}'));
    IF v_cols < 1 + (r.o IS NOT NULL)::int + (r.p IS NOT NULL)::int THEN
      table_name := r.t; table_present := false; tenant_class := NULL; owner_class := NULL; decision := NULL; row_count := 0;
      RETURN NEXT;
      CONTINUE;
    END IF;

    v_found := 0;
    FOR tenant_class, owner_class, decision, row_count IN EXECUTE format($q$
      WITH live AS (SELECT l AS tenant_id FROM public.mt_orphan_live_tenants() l),
           mem AS (SELECT ut.user_id, count(*) AS n, (array_agg(ut.tenant_id))[1] AS only_tenant
                     FROM public.user_tenants ut GROUP BY ut.user_id)
      SELECT c.tclass, c.oclass, c.decision, count(*)
        FROM (%s) c
       GROUP BY c.tclass, c.oclass, c.decision
       ORDER BY c.tclass, c.oclass, c.decision
    $q$, public.mt_orphan_classified_sql(r.t))
    LOOP
      table_name := r.t; table_present := true; v_found := v_found + 1;
      RETURN NEXT;
    END LOOP;
    IF v_found = 0 THEN
      table_name := r.t; table_present := true; tenant_class := NULL; owner_class := NULL; decision := NULL; row_count := 0;
      RETURN NEXT;
    END IF;
  END LOOP;
END
$fn$;

DO $grants$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.mt_orphan_registry()',
    'public.mt_orphan_live_tenants()',
    'public.mt_orphan_classified_sql(text)',
    'public.analyze_orphan_rows()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END
$grants$;

COMMENT ON FUNCTION public.analyze_orphan_rows() IS
  'VTID-05571: read-only orphan analysis per table, tenant class x owner class x decision. Service role only.';

COMMIT;
