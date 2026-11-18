-- VTID-05569 (mt-data-cleanup-r2 / hot-tables-not-null-expand-contract) - pgTAP: the NOT NULL tenant_id assertion (task H5).
-- Runs with `supabase test db` (pg_prove) after every migration including 20261102043000_vtid_05569_hot_tables_tenant_not_null_assert.sql.
-- The assertion is a DO block, not a function, so every case below runs a copy of that block through lives_ok / throws_ok.
-- The copy must stay identical to the block in the migration file (docs/validation/VTID-05569/commands.log shows the diff check).
-- One transaction, rolled back at the end; the fixtures (a dropped NOT NULL, rows on a non-existent tenant) never survive it.
--
-- Covers: the assertion passes on the real schema; it RAISEs (not_null_violation) when tenant_id on chat_messages,
-- user_notifications or product_analytics_events is nullable; it RAISEs (foreign_key_violation) when a row of any of the three
-- holds a tenant that does not exist; the fixtures are removed and the assertion passes again.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(11);

-- 1. real schema: the assertion applies cleanly
SELECT lives_ok($q$
DO $assert$
DECLARE
  v_t        text;
  v_nullable text;
  v_cols     text[];
  v_tenants  text;
  v_orphans  bigint;
BEGIN
  -- Every tenant id that exists. Production carries tenants.tenant_id (most FKs) and the bootstrap id column; read both.
  SELECT array_agg(c.column_name::text ORDER BY c.column_name) INTO v_cols
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'tenants' AND c.column_name IN ('tenant_id', 'id');
  IF v_cols IS NULL THEN
    RAISE EXCEPTION 'VTID-05569: public.tenants has neither tenant_id nor id' USING ERRCODE = 'undefined_column';
  END IF;
  SELECT string_agg(format('SELECT %I::uuid FROM public.tenants', col), ' UNION ') INTO v_tenants FROM unnest(v_cols) AS col;

  FOREACH v_t IN ARRAY ARRAY['chat_messages', 'user_notifications', 'product_analytics_events'] LOOP
    SELECT c.is_nullable INTO v_nullable
      FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = v_t AND c.column_name = 'tenant_id';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'VTID-05569: public.%.tenant_id does not exist', v_t USING ERRCODE = 'undefined_column';
    END IF;
    IF v_nullable <> 'NO' THEN
      RAISE EXCEPTION 'VTID-05569: public.%.tenant_id is nullable; re-plan the expand/contract (spec section 4.7), do not improvise', v_t
        USING ERRCODE = 'not_null_violation';
    END IF;

    EXECUTE format(
      'SELECT count(*) FROM public.%I x WHERE NOT EXISTS (SELECT 1 FROM (%s) t(id) WHERE t.id = x.tenant_id)', v_t, v_tenants)
      INTO v_orphans;
    IF v_orphans > 0 THEN
      RAISE EXCEPTION 'VTID-05569: public.% holds % row(s) whose tenant_id is not an existing tenant; run the orphan quarantine (VTID-05571) first', v_t, v_orphans
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RAISE NOTICE 'VTID-05569: public.%.tenant_id is NOT NULL and has no orphan rows', v_t;
  END LOOP;
END
$assert$;
$q$, 'assertion passes on the real schema');

-- 2-4. the three columns are NOT NULL per information_schema
SELECT is((SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'chat_messages' AND column_name = 'tenant_id'),
          'NO', 'chat_messages.tenant_id is NOT NULL');
SELECT is((SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user_notifications' AND column_name = 'tenant_id'),
          'NO', 'user_notifications.tenant_id is NOT NULL');
SELECT is((SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'product_analytics_events' AND column_name = 'tenant_id'),
          'NO', 'product_analytics_events.tenant_id is NOT NULL');

-- 5-7. fixture: a nullable tenant_id RAISEs, one table at a time (the test restores NOT NULL after each case)
ALTER TABLE public.chat_messages ALTER COLUMN tenant_id DROP NOT NULL;
SELECT throws_ok($q$
DO $assert$
DECLARE
  v_t        text;
  v_nullable text;
  v_cols     text[];
  v_tenants  text;
  v_orphans  bigint;
BEGIN
  -- Every tenant id that exists. Production carries tenants.tenant_id (most FKs) and the bootstrap id column; read both.
  SELECT array_agg(c.column_name::text ORDER BY c.column_name) INTO v_cols
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'tenants' AND c.column_name IN ('tenant_id', 'id');
  IF v_cols IS NULL THEN
    RAISE EXCEPTION 'VTID-05569: public.tenants has neither tenant_id nor id' USING ERRCODE = 'undefined_column';
  END IF;
  SELECT string_agg(format('SELECT %I::uuid FROM public.tenants', col), ' UNION ') INTO v_tenants FROM unnest(v_cols) AS col;

  FOREACH v_t IN ARRAY ARRAY['chat_messages', 'user_notifications', 'product_analytics_events'] LOOP
    SELECT c.is_nullable INTO v_nullable
      FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = v_t AND c.column_name = 'tenant_id';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'VTID-05569: public.%.tenant_id does not exist', v_t USING ERRCODE = 'undefined_column';
    END IF;
    IF v_nullable <> 'NO' THEN
      RAISE EXCEPTION 'VTID-05569: public.%.tenant_id is nullable; re-plan the expand/contract (spec section 4.7), do not improvise', v_t
        USING ERRCODE = 'not_null_violation';
    END IF;

    EXECUTE format(
      'SELECT count(*) FROM public.%I x WHERE NOT EXISTS (SELECT 1 FROM (%s) t(id) WHERE t.id = x.tenant_id)', v_t, v_tenants)
      INTO v_orphans;
    IF v_orphans > 0 THEN
      RAISE EXCEPTION 'VTID-05569: public.% holds % row(s) whose tenant_id is not an existing tenant; run the orphan quarantine (VTID-05571) first', v_t, v_orphans
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RAISE NOTICE 'VTID-05569: public.%.tenant_id is NOT NULL and has no orphan rows', v_t;
  END LOOP;
END
$assert$;
$q$, '23502', NULL, 'nullable chat_messages.tenant_id raises');
ALTER TABLE public.chat_messages ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE public.user_notifications ALTER COLUMN tenant_id DROP NOT NULL;
SELECT throws_ok($q$
DO $assert$
DECLARE
  v_t        text;
  v_nullable text;
  v_cols     text[];
  v_tenants  text;
  v_orphans  bigint;
BEGIN
  -- Every tenant id that exists. Production carries tenants.tenant_id (most FKs) and the bootstrap id column; read both.
  SELECT array_agg(c.column_name::text ORDER BY c.column_name) INTO v_cols
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'tenants' AND c.column_name IN ('tenant_id', 'id');
  IF v_cols IS NULL THEN
    RAISE EXCEPTION 'VTID-05569: public.tenants has neither tenant_id nor id' USING ERRCODE = 'undefined_column';
  END IF;
  SELECT string_agg(format('SELECT %I::uuid FROM public.tenants', col), ' UNION ') INTO v_tenants FROM unnest(v_cols) AS col;

  FOREACH v_t IN ARRAY ARRAY['chat_messages', 'user_notifications', 'product_analytics_events'] LOOP
    SELECT c.is_nullable INTO v_nullable
      FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = v_t AND c.column_name = 'tenant_id';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'VTID-05569: public.%.tenant_id does not exist', v_t USING ERRCODE = 'undefined_column';
    END IF;
    IF v_nullable <> 'NO' THEN
      RAISE EXCEPTION 'VTID-05569: public.%.tenant_id is nullable; re-plan the expand/contract (spec section 4.7), do not improvise', v_t
        USING ERRCODE = 'not_null_violation';
    END IF;

    EXECUTE format(
      'SELECT count(*) FROM public.%I x WHERE NOT EXISTS (SELECT 1 FROM (%s) t(id) WHERE t.id = x.tenant_id)', v_t, v_tenants)
      INTO v_orphans;
    IF v_orphans > 0 THEN
      RAISE EXCEPTION 'VTID-05569: public.% holds % row(s) whose tenant_id is not an existing tenant; run the orphan quarantine (VTID-05571) first', v_t, v_orphans
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RAISE NOTICE 'VTID-05569: public.%.tenant_id is NOT NULL and has no orphan rows', v_t;
  END LOOP;
END
$assert$;
$q$, '23502', NULL, 'nullable user_notifications.tenant_id raises');
ALTER TABLE public.user_notifications ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE public.product_analytics_events ALTER COLUMN tenant_id DROP NOT NULL;
SELECT throws_ok($q$
DO $assert$
DECLARE
  v_t        text;
  v_nullable text;
  v_cols     text[];
  v_tenants  text;
  v_orphans  bigint;
BEGIN
  -- Every tenant id that exists. Production carries tenants.tenant_id (most FKs) and the bootstrap id column; read both.
  SELECT array_agg(c.column_name::text ORDER BY c.column_name) INTO v_cols
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'tenants' AND c.column_name IN ('tenant_id', 'id');
  IF v_cols IS NULL THEN
    RAISE EXCEPTION 'VTID-05569: public.tenants has neither tenant_id nor id' USING ERRCODE = 'undefined_column';
  END IF;
  SELECT string_agg(format('SELECT %I::uuid FROM public.tenants', col), ' UNION ') INTO v_tenants FROM unnest(v_cols) AS col;

  FOREACH v_t IN ARRAY ARRAY['chat_messages', 'user_notifications', 'product_analytics_events'] LOOP
    SELECT c.is_nullable INTO v_nullable
      FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = v_t AND c.column_name = 'tenant_id';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'VTID-05569: public.%.tenant_id does not exist', v_t USING ERRCODE = 'undefined_column';
    END IF;
    IF v_nullable <> 'NO' THEN
      RAISE EXCEPTION 'VTID-05569: public.%.tenant_id is nullable; re-plan the expand/contract (spec section 4.7), do not improvise', v_t
        USING ERRCODE = 'not_null_violation';
    END IF;

    EXECUTE format(
      'SELECT count(*) FROM public.%I x WHERE NOT EXISTS (SELECT 1 FROM (%s) t(id) WHERE t.id = x.tenant_id)', v_t, v_tenants)
      INTO v_orphans;
    IF v_orphans > 0 THEN
      RAISE EXCEPTION 'VTID-05569: public.% holds % row(s) whose tenant_id is not an existing tenant; run the orphan quarantine (VTID-05571) first', v_t, v_orphans
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RAISE NOTICE 'VTID-05569: public.%.tenant_id is NOT NULL and has no orphan rows', v_t;
  END LOOP;
END
$assert$;
$q$, '23502', NULL, 'nullable product_analytics_events.tenant_id raises');
ALTER TABLE public.product_analytics_events ALTER COLUMN tenant_id SET NOT NULL;

-- 8-10. fixture: a row on a tenant that does not exist RAISEs, one table at a time
CREATE TEMP TABLE t05569_ids (k text PRIMARY KEY, v uuid NOT NULL);
INSERT INTO t05569_ids VALUES
  ('FAKE', '05569000-0000-4000-8000-0000000000f0'),
  ('U1',   '05569000-0000-4000-8000-000000000001'),
  ('U2',   '05569000-0000-4000-8000-000000000002');
CREATE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT v FROM t05569_ids WHERE k = p $$;

INSERT INTO public.chat_messages (tenant_id, sender_id, receiver_id, content)
VALUES (pg_temp.id('FAKE'), pg_temp.id('U1'), pg_temp.id('U2'), 'vtid-05569 orphan');
SELECT throws_ok($q$
DO $assert$
DECLARE
  v_t        text;
  v_nullable text;
  v_cols     text[];
  v_tenants  text;
  v_orphans  bigint;
BEGIN
  -- Every tenant id that exists. Production carries tenants.tenant_id (most FKs) and the bootstrap id column; read both.
  SELECT array_agg(c.column_name::text ORDER BY c.column_name) INTO v_cols
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'tenants' AND c.column_name IN ('tenant_id', 'id');
  IF v_cols IS NULL THEN
    RAISE EXCEPTION 'VTID-05569: public.tenants has neither tenant_id nor id' USING ERRCODE = 'undefined_column';
  END IF;
  SELECT string_agg(format('SELECT %I::uuid FROM public.tenants', col), ' UNION ') INTO v_tenants FROM unnest(v_cols) AS col;

  FOREACH v_t IN ARRAY ARRAY['chat_messages', 'user_notifications', 'product_analytics_events'] LOOP
    SELECT c.is_nullable INTO v_nullable
      FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = v_t AND c.column_name = 'tenant_id';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'VTID-05569: public.%.tenant_id does not exist', v_t USING ERRCODE = 'undefined_column';
    END IF;
    IF v_nullable <> 'NO' THEN
      RAISE EXCEPTION 'VTID-05569: public.%.tenant_id is nullable; re-plan the expand/contract (spec section 4.7), do not improvise', v_t
        USING ERRCODE = 'not_null_violation';
    END IF;

    EXECUTE format(
      'SELECT count(*) FROM public.%I x WHERE NOT EXISTS (SELECT 1 FROM (%s) t(id) WHERE t.id = x.tenant_id)', v_t, v_tenants)
      INTO v_orphans;
    IF v_orphans > 0 THEN
      RAISE EXCEPTION 'VTID-05569: public.% holds % row(s) whose tenant_id is not an existing tenant; run the orphan quarantine (VTID-05571) first', v_t, v_orphans
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RAISE NOTICE 'VTID-05569: public.%.tenant_id is NOT NULL and has no orphan rows', v_t;
  END LOOP;
END
$assert$;
$q$, '23503', NULL, 'chat_messages row on a non-existent tenant raises');
DELETE FROM public.chat_messages WHERE tenant_id = pg_temp.id('FAKE');

INSERT INTO public.user_notifications (user_id, tenant_id, type, title)
VALUES (pg_temp.id('U1'), pg_temp.id('FAKE'), 'test', 'vtid-05569 orphan');
SELECT throws_ok($q$
DO $assert$
DECLARE
  v_t        text;
  v_nullable text;
  v_cols     text[];
  v_tenants  text;
  v_orphans  bigint;
BEGIN
  -- Every tenant id that exists. Production carries tenants.tenant_id (most FKs) and the bootstrap id column; read both.
  SELECT array_agg(c.column_name::text ORDER BY c.column_name) INTO v_cols
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'tenants' AND c.column_name IN ('tenant_id', 'id');
  IF v_cols IS NULL THEN
    RAISE EXCEPTION 'VTID-05569: public.tenants has neither tenant_id nor id' USING ERRCODE = 'undefined_column';
  END IF;
  SELECT string_agg(format('SELECT %I::uuid FROM public.tenants', col), ' UNION ') INTO v_tenants FROM unnest(v_cols) AS col;

  FOREACH v_t IN ARRAY ARRAY['chat_messages', 'user_notifications', 'product_analytics_events'] LOOP
    SELECT c.is_nullable INTO v_nullable
      FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = v_t AND c.column_name = 'tenant_id';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'VTID-05569: public.%.tenant_id does not exist', v_t USING ERRCODE = 'undefined_column';
    END IF;
    IF v_nullable <> 'NO' THEN
      RAISE EXCEPTION 'VTID-05569: public.%.tenant_id is nullable; re-plan the expand/contract (spec section 4.7), do not improvise', v_t
        USING ERRCODE = 'not_null_violation';
    END IF;

    EXECUTE format(
      'SELECT count(*) FROM public.%I x WHERE NOT EXISTS (SELECT 1 FROM (%s) t(id) WHERE t.id = x.tenant_id)', v_t, v_tenants)
      INTO v_orphans;
    IF v_orphans > 0 THEN
      RAISE EXCEPTION 'VTID-05569: public.% holds % row(s) whose tenant_id is not an existing tenant; run the orphan quarantine (VTID-05571) first', v_t, v_orphans
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RAISE NOTICE 'VTID-05569: public.%.tenant_id is NOT NULL and has no orphan rows', v_t;
  END LOOP;
END
$assert$;
$q$, '23503', NULL, 'user_notifications row on a non-existent tenant raises');
DELETE FROM public.user_notifications WHERE tenant_id = pg_temp.id('FAKE');

INSERT INTO public.product_analytics_events (event_id, event_name, event_type, tenant_id, session_id, screen_route, source, occurred_at)
VALUES ('vtid-05569-orphan', 'vtid_05569', 'feature', pg_temp.id('FAKE'), 's', '/', 'web', now());
SELECT throws_ok($q$
DO $assert$
DECLARE
  v_t        text;
  v_nullable text;
  v_cols     text[];
  v_tenants  text;
  v_orphans  bigint;
BEGIN
  -- Every tenant id that exists. Production carries tenants.tenant_id (most FKs) and the bootstrap id column; read both.
  SELECT array_agg(c.column_name::text ORDER BY c.column_name) INTO v_cols
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'tenants' AND c.column_name IN ('tenant_id', 'id');
  IF v_cols IS NULL THEN
    RAISE EXCEPTION 'VTID-05569: public.tenants has neither tenant_id nor id' USING ERRCODE = 'undefined_column';
  END IF;
  SELECT string_agg(format('SELECT %I::uuid FROM public.tenants', col), ' UNION ') INTO v_tenants FROM unnest(v_cols) AS col;

  FOREACH v_t IN ARRAY ARRAY['chat_messages', 'user_notifications', 'product_analytics_events'] LOOP
    SELECT c.is_nullable INTO v_nullable
      FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = v_t AND c.column_name = 'tenant_id';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'VTID-05569: public.%.tenant_id does not exist', v_t USING ERRCODE = 'undefined_column';
    END IF;
    IF v_nullable <> 'NO' THEN
      RAISE EXCEPTION 'VTID-05569: public.%.tenant_id is nullable; re-plan the expand/contract (spec section 4.7), do not improvise', v_t
        USING ERRCODE = 'not_null_violation';
    END IF;

    EXECUTE format(
      'SELECT count(*) FROM public.%I x WHERE NOT EXISTS (SELECT 1 FROM (%s) t(id) WHERE t.id = x.tenant_id)', v_t, v_tenants)
      INTO v_orphans;
    IF v_orphans > 0 THEN
      RAISE EXCEPTION 'VTID-05569: public.% holds % row(s) whose tenant_id is not an existing tenant; run the orphan quarantine (VTID-05571) first', v_t, v_orphans
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RAISE NOTICE 'VTID-05569: public.%.tenant_id is NOT NULL and has no orphan rows', v_t;
  END LOOP;
END
$assert$;
$q$, '23503', NULL, 'product_analytics_events row on a non-existent tenant raises');
DELETE FROM public.product_analytics_events WHERE tenant_id = pg_temp.id('FAKE');

-- 11. the fixtures are gone again: the assertion passes once more
SELECT lives_ok($q$
DO $assert$
DECLARE
  v_t        text;
  v_nullable text;
  v_cols     text[];
  v_tenants  text;
  v_orphans  bigint;
BEGIN
  -- Every tenant id that exists. Production carries tenants.tenant_id (most FKs) and the bootstrap id column; read both.
  SELECT array_agg(c.column_name::text ORDER BY c.column_name) INTO v_cols
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'tenants' AND c.column_name IN ('tenant_id', 'id');
  IF v_cols IS NULL THEN
    RAISE EXCEPTION 'VTID-05569: public.tenants has neither tenant_id nor id' USING ERRCODE = 'undefined_column';
  END IF;
  SELECT string_agg(format('SELECT %I::uuid FROM public.tenants', col), ' UNION ') INTO v_tenants FROM unnest(v_cols) AS col;

  FOREACH v_t IN ARRAY ARRAY['chat_messages', 'user_notifications', 'product_analytics_events'] LOOP
    SELECT c.is_nullable INTO v_nullable
      FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = v_t AND c.column_name = 'tenant_id';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'VTID-05569: public.%.tenant_id does not exist', v_t USING ERRCODE = 'undefined_column';
    END IF;
    IF v_nullable <> 'NO' THEN
      RAISE EXCEPTION 'VTID-05569: public.%.tenant_id is nullable; re-plan the expand/contract (spec section 4.7), do not improvise', v_t
        USING ERRCODE = 'not_null_violation';
    END IF;

    EXECUTE format(
      'SELECT count(*) FROM public.%I x WHERE NOT EXISTS (SELECT 1 FROM (%s) t(id) WHERE t.id = x.tenant_id)', v_t, v_tenants)
      INTO v_orphans;
    IF v_orphans > 0 THEN
      RAISE EXCEPTION 'VTID-05569: public.% holds % row(s) whose tenant_id is not an existing tenant; run the orphan quarantine (VTID-05571) first', v_t, v_orphans
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RAISE NOTICE 'VTID-05569: public.%.tenant_id is NOT NULL and has no orphan rows', v_t;
  END LOOP;
END
$assert$;
$q$, 'assertion passes again after the fixtures are removed');

SELECT * FROM finish();
ROLLBACK;
