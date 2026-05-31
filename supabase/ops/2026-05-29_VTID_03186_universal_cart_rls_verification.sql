-- VTID-03186 — Universal Cart Phase 1, Slice A — RLS + schema verification.
--
-- Run AFTER applying 20260605000000_VTID_03186_universal_cart_schema.sql.
-- Runs entirely inside a transaction that is ROLLED BACK at the end, so it
-- leaves no rows behind. RAISEs on first failure with a descriptive message.
--
-- Touches ONLY the new universal_carts / universal_cart_items /
-- universal_cart_events tables. Does NOT read or write any Lovable-side
-- commerce table (cart_items, checkout_sessions, cj_*, vouchers,
-- business_packages, supplements, user_wallets, etc.) — those are out of
-- scope per issue #2371 (VTID-03176).
--
-- Coverage:
--   §1  Structural checks  — tables, columns, constraints, indexes, triggers, policies all present.
--   §2  Cascade & constraint behavior — INSERT, partial-unique, CHECK, ON DELETE CASCADE.
--   §3  RLS — authenticated user A sees own cart, cannot see user B's cart, cannot insert into user B's cart.
--   §4  RLS — authenticated user cannot INSERT into universal_cart_events; can only SELECT events for carts they own.
--
-- Test fixtures: a synthetic merchant + product are inserted at the head of §2
-- so the script tests every assertion regardless of whether the target DB has
-- any real products. All fixture rows (merchants, products, app_users,
-- universal_carts, universal_cart_items, universal_cart_events) are rolled
-- back at the end.
--
-- Invocation (psql, with a service-role connection string):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/ops/2026-05-29_VTID_03186_universal_cart_rls_verification.sql

BEGIN;

-- ============================================================
-- §1  Structural checks
-- ============================================================

DO $check_tables$
DECLARE
  missing TEXT;
BEGIN
  SELECT string_agg(t, ', ' ORDER BY t)
    INTO missing
    FROM unnest(ARRAY['universal_carts','universal_cart_items','universal_cart_events']) AS t
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
   );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '§1 missing tables: %', missing;
  END IF;
END
$check_tables$;

DO $check_rls_enabled$
DECLARE
  unprotected TEXT;
BEGIN
  SELECT string_agg(c.relname::text, ', ' ORDER BY c.relname)
    INTO unprotected
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('universal_carts','universal_cart_items','universal_cart_events')
     AND NOT c.relrowsecurity;
  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION '§1 RLS not enabled on: %', unprotected;
  END IF;
END
$check_rls_enabled$;

DO $check_policies$
DECLARE
  missing TEXT;
BEGIN
  SELECT string_agg(spec, ', ' ORDER BY spec)
    INTO missing
    FROM (VALUES
      ('universal_carts','universal_carts_select_own'),
      ('universal_carts','universal_carts_insert_own'),
      ('universal_carts','universal_carts_update_own'),
      ('universal_carts','universal_carts_delete_own'),
      ('universal_cart_items','universal_cart_items_select_via_cart'),
      ('universal_cart_items','universal_cart_items_insert_via_cart'),
      ('universal_cart_items','universal_cart_items_update_via_cart'),
      ('universal_cart_items','universal_cart_items_delete_via_cart'),
      ('universal_cart_events','universal_cart_events_select_via_cart')
    ) AS expected(tbl, pol),
    LATERAL (SELECT tbl || '.' || pol AS spec) s
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename = expected.tbl
         AND policyname = expected.pol
    );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '§1 missing policies: %', missing;
  END IF;
END
$check_policies$;

DO $check_indexes$
DECLARE
  missing TEXT;
BEGIN
  SELECT string_agg(idx, ', ' ORDER BY idx)
    INTO missing
    FROM unnest(ARRAY[
      'universal_carts_one_active_per_user',
      'universal_carts_user_status_idx',
      'universal_cart_items_cart_active_idx',
      'universal_cart_items_product_idx',
      'universal_cart_events_cart_recent_idx',
      'universal_cart_events_user_recent_idx'
    ]) AS idx
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = idx
   );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '§1 missing indexes: %', missing;
  END IF;
END
$check_indexes$;

DO $check_triggers$
DECLARE
  missing TEXT;
BEGIN
  SELECT string_agg(spec, ', ' ORDER BY spec)
    INTO missing
    FROM (VALUES
      ('universal_carts','universal_carts_updated_at_trigger'),
      ('universal_cart_items','universal_cart_items_updated_at_trigger')
    ) AS expected(tbl, trg),
    LATERAL (SELECT tbl || '.' || trg AS spec) s
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = expected.tbl
         AND t.tgname = expected.trg
    );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '§1 missing triggers: %', missing;
  END IF;
END
$check_triggers$;

-- ============================================================
-- §2  Cascade & constraint behavior  (operating as service_role / superuser)
-- ============================================================

-- Seed two synthetic test users in app_users (rolled back at end).
-- VTID-03205 patch: app_users.email is `TEXT UNIQUE NOT NULL` per the
-- VTID-01101 phase-A bootstrap migration. The original VTID-03186 ops
-- script seeded only user_id, which would raise not_null_violation on
-- email before any of the RLS / cascade assertions run. @example.invalid
-- is RFC 6761 reserved for test use; the VTID-03186 prefix keeps email
-- values unique even on re-run. display_name is nullable per the bootstrap
-- migration but we set it for log readability.
--
-- VTID-03206 patch: production app_users.tenant_id is also NOT NULL. Use an
-- existing tenant id as the synthetic users' tenant; this script still rolls
-- back all inserted app_users / universal_cart rows at the end.
DO $seed_users$
DECLARE
  user_a CONSTANT UUID := '00000000-0000-4000-a000-000000000a01';
  user_b CONSTANT UUID := '00000000-0000-4000-a000-000000000b01';
  app_users_tenant_attnum SMALLINT;
  tenant_ref_col TEXT;
  fixture_tenant_id UUID;
BEGIN
  SELECT attnum INTO app_users_tenant_attnum
    FROM pg_attribute
   WHERE attrelid = 'public.app_users'::regclass
     AND attname = 'tenant_id'
     AND NOT attisdropped;

  SELECT ref_att.attname
    INTO tenant_ref_col
    FROM pg_constraint con
    JOIN unnest(con.conkey) WITH ORDINALITY AS src(attnum, ord) ON true
    JOIN unnest(con.confkey) WITH ORDINALITY AS ref(attnum, ord) ON ref.ord = src.ord
    JOIN pg_attribute ref_att
      ON ref_att.attrelid = con.confrelid
     AND ref_att.attnum = ref.attnum
   WHERE con.conrelid = 'public.app_users'::regclass
     AND con.confrelid = 'public.tenants'::regclass
     AND con.contype = 'f'
     AND src.attnum = app_users_tenant_attnum
   LIMIT 1;

  IF tenant_ref_col IS NULL THEN
    SELECT CASE
      WHEN EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'tenants'
           AND column_name = 'tenant_id'
      ) THEN 'tenant_id'
      ELSE 'id'
    END INTO tenant_ref_col;
  END IF;

  EXECUTE format(
    'SELECT %I FROM public.tenants ORDER BY created_at ASC LIMIT 1',
    tenant_ref_col
  ) INTO fixture_tenant_id;

  IF fixture_tenant_id IS NULL THEN
    RAISE EXCEPTION '§2 seed_users: no public.tenants row available for app_users.tenant_id fixture';
  END IF;

  INSERT INTO public.app_users (user_id, tenant_id, email, display_name)
  VALUES
    (user_a, fixture_tenant_id, 'vtid-03186-user-a@example.invalid', 'VTID-03186 User A'),
    (user_b, fixture_tenant_id, 'vtid-03186-user-b@example.invalid', 'VTID-03186 User B')
  ON CONFLICT (user_id) DO NOTHING;
END
$seed_users$;

-- Seed a synthetic merchant + product so §2.3 / §2.4 / §3.2 always have a
-- valid FK target. Without this, an empty-products staging DB would either
-- silently skip those assertions (false-pass) or fail loudly on the FK to
-- products(id). Fixture rows persist only inside this transaction (rolled
-- back at end).
DO $seed_marketplace_fixture$
DECLARE
  fx_merchant_id CONSTANT UUID := '00000000-0000-4000-c000-000000000c01';
  fx_product_id  CONSTANT UUID := '00000000-0000-4000-c000-000000000c02';
BEGIN
  INSERT INTO public.merchants (id, name, source_network)
    VALUES (fx_merchant_id, '__vtid_03186_test_merchant', 'manual')
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.products (
    id, merchant_id, source_network, source_product_id, title, affiliate_url
  ) VALUES (
    fx_product_id, fx_merchant_id, 'manual', '__vtid_03186_test_product',
    'VTID-03186 Test Product', 'https://example.test/vtid-03186'
  )
  ON CONFLICT (id) DO NOTHING;
END
$seed_marketplace_fixture$;

-- §2.1 partial-unique index: two active universal_carts for same user must fail
DO $partial_unique$
DECLARE
  cart_a UUID;
  caught BOOLEAN := FALSE;
BEGIN
  INSERT INTO public.universal_carts (user_id, status)
    VALUES ('00000000-0000-4000-a000-000000000a01', 'active')
    RETURNING id INTO cart_a;
  BEGIN
    INSERT INTO public.universal_carts (user_id, status)
      VALUES ('00000000-0000-4000-a000-000000000a01', 'active');
  EXCEPTION WHEN unique_violation THEN
    caught := TRUE;
  END;
  IF NOT caught THEN
    RAISE EXCEPTION '§2.1 partial-unique index DID NOT block second active universal_cart for same user';
  END IF;
END
$partial_unique$;

-- §2.2 status CHECK constraint rejects unknown value
DO $status_check$
DECLARE
  caught BOOLEAN := FALSE;
BEGIN
  BEGIN
    INSERT INTO public.universal_carts (user_id, status)
      VALUES ('00000000-0000-4000-a000-000000000b01', 'banana');
  EXCEPTION WHEN check_violation THEN
    caught := TRUE;
  END;
  IF NOT caught THEN
    RAISE EXCEPTION '§2.2 universal_carts.status CHECK constraint did NOT reject "banana"';
  END IF;
END
$status_check$;

-- §2.3 universal_cart_items source_surface CHECK rejects unknown value
DO $source_surface_check$
DECLARE
  cart_id_a UUID;
  fx_product_id CONSTANT UUID := '00000000-0000-4000-c000-000000000c02';
  caught    BOOLEAN := FALSE;
BEGIN
  SELECT id INTO cart_id_a FROM public.universal_carts
   WHERE user_id = '00000000-0000-4000-a000-000000000a01' AND status = 'active' LIMIT 1;
  BEGIN
    INSERT INTO public.universal_cart_items (cart_id, item_type, product_id, source_surface)
      VALUES (cart_id_a, 'supplement', fx_product_id, 'sms');
  EXCEPTION WHEN check_violation THEN
    caught := TRUE;
  END;
  IF NOT caught THEN
    RAISE EXCEPTION '§2.3 universal_cart_items.source_surface CHECK did NOT reject "sms"';
  END IF;
END
$source_surface_check$;

-- §2.4 ON DELETE CASCADE: deleting universal_cart removes its items
DO $cascade_check$
DECLARE
  cart_id_a UUID;
  fx_product_id CONSTANT UUID := '00000000-0000-4000-c000-000000000c02';
  remaining INT;
BEGIN
  SELECT id INTO cart_id_a FROM public.universal_carts
   WHERE user_id = '00000000-0000-4000-a000-000000000a01' AND status = 'active' LIMIT 1;
  INSERT INTO public.universal_cart_items (cart_id, item_type, product_id, source_surface)
    VALUES (cart_id_a, 'supplement', fx_product_id, 'web');
  DELETE FROM public.universal_carts WHERE id = cart_id_a;
  SELECT count(*) INTO remaining FROM public.universal_cart_items WHERE cart_id = cart_id_a;
  IF remaining <> 0 THEN
    RAISE EXCEPTION '§2.4 ON DELETE CASCADE failed: % universal_cart_items survived parent delete', remaining;
  END IF;
END
$cascade_check$;

-- ============================================================
-- §3  RLS  — authenticated user A sees only own universal_cart
-- ============================================================
-- Restore data for RLS phase (parent was deleted in §2.4)
DO $rebuild_carts$
DECLARE
  cart_a UUID;
  cart_b UUID;
BEGIN
  INSERT INTO public.universal_carts (user_id, status)
    VALUES ('00000000-0000-4000-a000-000000000a01', 'active') RETURNING id INTO cart_a;
  INSERT INTO public.universal_carts (user_id, status)
    VALUES ('00000000-0000-4000-a000-000000000b01', 'active') RETURNING id INTO cart_b;
END
$rebuild_carts$;

-- §3.1 user A sees only their own universal_cart
DO $rls_select$
DECLARE
  visible_a INT;
  visible_b INT;
BEGIN
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub','00000000-0000-4000-a000-000000000a01','role','authenticated')::text,
    true);

  SET LOCAL ROLE authenticated;

  SELECT count(*) INTO visible_a
    FROM public.universal_carts WHERE user_id = '00000000-0000-4000-a000-000000000a01';
  SELECT count(*) INTO visible_b
    FROM public.universal_carts WHERE user_id = '00000000-0000-4000-a000-000000000b01';

  IF visible_a <> 1 THEN
    RAISE EXCEPTION '§3.1 user A should see own universal_cart (1), saw %', visible_a;
  END IF;
  IF visible_b <> 0 THEN
    RAISE EXCEPTION '§3.1 RLS LEAK: user A saw % rows of user B''s universal_cart', visible_b;
  END IF;

  RESET ROLE;
END
$rls_select$;

-- §3.2 user A cannot INSERT a universal_cart_item into user B's universal_cart
DO $rls_cross_insert$
DECLARE
  cart_b UUID;
  fx_product_id CONSTANT UUID := '00000000-0000-4000-c000-000000000c02';
  caught BOOLEAN := FALSE;
BEGIN
  -- Resolve cart_b while still service_role (RLS would hide it from user A)
  SELECT id INTO cart_b FROM public.universal_carts
   WHERE user_id = '00000000-0000-4000-a000-000000000b01' AND status = 'active' LIMIT 1;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub','00000000-0000-4000-a000-000000000a01','role','authenticated')::text,
    true);
  SET LOCAL ROLE authenticated;

  BEGIN
    INSERT INTO public.universal_cart_items (cart_id, item_type, product_id, source_surface)
      VALUES (cart_b, 'supplement', fx_product_id, 'web');
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    caught := TRUE;
  END;

  RESET ROLE;

  IF NOT caught THEN
    RAISE EXCEPTION '§3.2 RLS LEAK: user A inserted a universal_cart_item into user B''s universal_cart';
  END IF;
END
$rls_cross_insert$;

-- ============================================================
-- §4  universal_cart_events — authenticated cannot INSERT; SELECT gated by parent cart.
-- ============================================================
DO $events_no_insert$
DECLARE
  cart_a UUID;
  caught BOOLEAN := FALSE;
BEGIN
  SELECT id INTO cart_a FROM public.universal_carts
   WHERE user_id = '00000000-0000-4000-a000-000000000a01' AND status = 'active' LIMIT 1;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub','00000000-0000-4000-a000-000000000a01','role','authenticated')::text,
    true);
  SET LOCAL ROLE authenticated;

  BEGIN
    INSERT INTO public.universal_cart_events (cart_id, user_id, event_type, event_payload)
      VALUES (cart_a, '00000000-0000-4000-a000-000000000a01', 'cart.created', '{}'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN
    caught := TRUE;
  END;

  RESET ROLE;

  IF NOT caught THEN
    RAISE EXCEPTION '§4 RLS LEAK: authenticated user inserted into universal_cart_events (must be service_role only)';
  END IF;
END
$events_no_insert$;

-- §4.2 universal_cart_events SELECT uses parent-cart ownership, not self user_id.
-- We seed two events as service_role: one on user A's cart, one on user B's
-- cart. Switching to authenticated user A, the policy must allow only the
-- event whose parent cart belongs to user A. We also seed a spoofed row
-- (user_id = A) on user B's cart to prove the policy ignores
-- universal_cart_events.user_id and trusts cart_id only.
DO $events_select_via_parent_cart$
DECLARE
  cart_a UUID;
  cart_b UUID;
  visible_via_a INT;
  visible_via_b INT;
BEGIN
  SELECT id INTO cart_a FROM public.universal_carts
   WHERE user_id = '00000000-0000-4000-a000-000000000a01' AND status = 'active' LIMIT 1;
  SELECT id INTO cart_b FROM public.universal_carts
   WHERE user_id = '00000000-0000-4000-a000-000000000b01' AND status = 'active' LIMIT 1;

  -- still service_role: write three rows
  INSERT INTO public.universal_cart_events (cart_id, user_id, event_type, event_payload)
    VALUES (cart_a, '00000000-0000-4000-a000-000000000a01', 'cart.created', '{}'::jsonb);
  INSERT INTO public.universal_cart_events (cart_id, user_id, event_type, event_payload)
    VALUES (cart_b, '00000000-0000-4000-a000-000000000b01', 'cart.created', '{}'::jsonb);
  -- Spoof: row on user B's cart with user_id falsely set to user A.
  -- The OLD policy (USING user_id = auth.uid()) would have leaked this row to A.
  -- The NEW policy (parent-cart ownership) must NOT.
  INSERT INTO public.universal_cart_events (cart_id, user_id, event_type, event_payload)
    VALUES (cart_b, '00000000-0000-4000-a000-000000000a01', 'cart.spoofed', '{}'::jsonb);

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub','00000000-0000-4000-a000-000000000a01','role','authenticated')::text,
    true);
  SET LOCAL ROLE authenticated;

  SELECT count(*) INTO visible_via_a FROM public.universal_cart_events WHERE cart_id = cart_a;
  SELECT count(*) INTO visible_via_b FROM public.universal_cart_events WHERE cart_id = cart_b;

  RESET ROLE;

  IF visible_via_a <> 1 THEN
    RAISE EXCEPTION
      '§4.2 user A should see exactly 1 universal_cart_event on own cart, saw %', visible_via_a;
  END IF;
  IF visible_via_b <> 0 THEN
    RAISE EXCEPTION
      '§4.2 RLS LEAK: user A saw % universal_cart_events on user B''s cart (one was spoofed with user_id=A — the new parent-cart policy must reject it)',
      visible_via_b;
  END IF;
END
$events_select_via_parent_cart$;

-- ============================================================
-- All checks passed. Roll back synthetic data so the DB is unchanged.
-- ============================================================
ROLLBACK;

DO $ok$ BEGIN RAISE NOTICE 'VTID-03186 RLS + schema verification: ALL CHECKS PASSED'; END $ok$;
