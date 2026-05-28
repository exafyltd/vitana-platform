-- VTID-03165 — Universal Cart Phase 1, Slice A — RLS + schema verification.
--
-- Run AFTER applying 20260604000000_VTID_03165_universal_cart_schema.sql.
-- Runs entirely inside a transaction that is ROLLED BACK at the end, so it
-- leaves no rows behind. RAISEs on first failure with a descriptive message.
--
-- Coverage:
--   §1  Structural checks  — tables, columns, constraints, indexes, triggers, policies all present.
--   §2  Cascade & constraint behavior — INSERT, partial-unique, CHECK, ON DELETE CASCADE.
--   §3  RLS — authenticated user A sees own cart, cannot see user B's cart, cannot insert into user B's cart.
--   §4  RLS — authenticated user cannot INSERT into cart_events (service_role only).
--
-- Invocation (psql, with a service-role connection string):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/ops/2026-05-28_VTID_03165_universal_cart_rls_verification.sql

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
    FROM unnest(ARRAY['carts','cart_items','cart_events']) AS t
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
     AND c.relname IN ('carts','cart_items','cart_events')
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
      ('carts','carts_select_own'),
      ('carts','carts_insert_own'),
      ('carts','carts_update_own'),
      ('carts','carts_delete_own'),
      ('cart_items','cart_items_select_via_cart'),
      ('cart_items','cart_items_insert_via_cart'),
      ('cart_items','cart_items_update_via_cart'),
      ('cart_items','cart_items_delete_via_cart'),
      ('cart_events','cart_events_select_own')
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
      'carts_one_active_per_user',
      'carts_user_status_idx',
      'cart_items_cart_active_idx',
      'cart_items_product_idx',
      'cart_events_cart_recent_idx',
      'cart_events_user_recent_idx'
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
      ('carts','carts_updated_at_trigger'),
      ('cart_items','cart_items_updated_at_trigger')
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

-- Seed two synthetic test users in app_users (rolled back at COMMIT step)
DO $seed_users$
DECLARE
  user_a CONSTANT UUID := '00000000-0000-4000-a000-000000000a01';
  user_b CONSTANT UUID := '00000000-0000-4000-a000-000000000b01';
BEGIN
  INSERT INTO public.app_users (user_id) VALUES (user_a) ON CONFLICT DO NOTHING;
  INSERT INTO public.app_users (user_id) VALUES (user_b) ON CONFLICT DO NOTHING;
END
$seed_users$;

-- §2.1 partial-unique index: two active carts for same user must fail
DO $partial_unique$
DECLARE
  cart_a UUID;
  caught BOOLEAN := FALSE;
BEGIN
  INSERT INTO public.carts (user_id, status)
    VALUES ('00000000-0000-4000-a000-000000000a01', 'active')
    RETURNING id INTO cart_a;
  BEGIN
    INSERT INTO public.carts (user_id, status)
      VALUES ('00000000-0000-4000-a000-000000000a01', 'active');
  EXCEPTION WHEN unique_violation THEN
    caught := TRUE;
  END;
  IF NOT caught THEN
    RAISE EXCEPTION '§2.1 partial-unique index DID NOT block second active cart for same user';
  END IF;
END
$partial_unique$;

-- §2.2 status CHECK constraint rejects unknown value
DO $status_check$
DECLARE
  caught BOOLEAN := FALSE;
BEGIN
  BEGIN
    INSERT INTO public.carts (user_id, status)
      VALUES ('00000000-0000-4000-a000-000000000b01', 'banana');
  EXCEPTION WHEN check_violation THEN
    caught := TRUE;
  END;
  IF NOT caught THEN
    RAISE EXCEPTION '§2.2 carts.status CHECK constraint did NOT reject "banana"';
  END IF;
END
$status_check$;

-- §2.3 cart_items source_surface CHECK rejects unknown value
DO $source_surface_check$
DECLARE
  cart_id_a UUID;
  prod_id   UUID;
  caught    BOOLEAN := FALSE;
BEGIN
  SELECT id INTO cart_id_a FROM public.carts
   WHERE user_id = '00000000-0000-4000-a000-000000000a01' AND status = 'active' LIMIT 1;
  SELECT id INTO prod_id FROM public.products LIMIT 1;
  IF prod_id IS NULL THEN
    RAISE NOTICE '§2.3 skipped: no products in DB to test against';
    RETURN;
  END IF;
  BEGIN
    INSERT INTO public.cart_items (cart_id, item_type, product_id, source_surface)
      VALUES (cart_id_a, 'supplement', prod_id, 'sms');
  EXCEPTION WHEN check_violation THEN
    caught := TRUE;
  END;
  IF NOT caught THEN
    RAISE EXCEPTION '§2.3 cart_items.source_surface CHECK did NOT reject "sms"';
  END IF;
END
$source_surface_check$;

-- §2.4 ON DELETE CASCADE: deleting cart removes its items
DO $cascade_check$
DECLARE
  cart_id_a UUID;
  prod_id   UUID;
  remaining INT;
BEGIN
  SELECT id INTO cart_id_a FROM public.carts
   WHERE user_id = '00000000-0000-4000-a000-000000000a01' AND status = 'active' LIMIT 1;
  SELECT id INTO prod_id FROM public.products LIMIT 1;
  IF prod_id IS NULL THEN
    RAISE NOTICE '§2.4 skipped: no products in DB to test against';
    RETURN;
  END IF;
  INSERT INTO public.cart_items (cart_id, item_type, product_id, source_surface)
    VALUES (cart_id_a, 'supplement', prod_id, 'web');
  DELETE FROM public.carts WHERE id = cart_id_a;
  SELECT count(*) INTO remaining FROM public.cart_items WHERE cart_id = cart_id_a;
  IF remaining <> 0 THEN
    RAISE EXCEPTION '§2.4 ON DELETE CASCADE failed: % cart_items survived parent delete', remaining;
  END IF;
END
$cascade_check$;

-- ============================================================
-- §3  RLS  — authenticated user A sees only own cart
-- ============================================================
-- Restore data for RLS phase (parent was deleted in §2.4)
DO $rebuild_carts$
DECLARE
  cart_a UUID;
  cart_b UUID;
BEGIN
  INSERT INTO public.carts (user_id, status)
    VALUES ('00000000-0000-4000-a000-000000000a01', 'active') RETURNING id INTO cart_a;
  INSERT INTO public.carts (user_id, status)
    VALUES ('00000000-0000-4000-a000-000000000b01', 'active') RETURNING id INTO cart_b;
END
$rebuild_carts$;

-- §3.1 user A sees only their own cart
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
    FROM public.carts WHERE user_id = '00000000-0000-4000-a000-000000000a01';
  SELECT count(*) INTO visible_b
    FROM public.carts WHERE user_id = '00000000-0000-4000-a000-000000000b01';

  IF visible_a <> 1 THEN
    RAISE EXCEPTION '§3.1 user A should see own cart (1), saw %', visible_a;
  END IF;
  IF visible_b <> 0 THEN
    RAISE EXCEPTION '§3.1 RLS LEAK: user A saw % rows of user B''s cart', visible_b;
  END IF;

  RESET ROLE;
END
$rls_select$;

-- §3.2 user A cannot INSERT a cart_item into user B's cart
DO $rls_cross_insert$
DECLARE
  cart_b UUID;
  prod_id UUID;
  caught BOOLEAN := FALSE;
BEGIN
  SELECT id INTO cart_b FROM public.carts
   WHERE user_id = '00000000-0000-4000-a000-000000000b01' AND status = 'active' LIMIT 1;
  SELECT id INTO prod_id FROM public.products LIMIT 1;
  IF prod_id IS NULL THEN
    RAISE NOTICE '§3.2 skipped: no products in DB';
    RETURN;
  END IF;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub','00000000-0000-4000-a000-000000000a01','role','authenticated')::text,
    true);
  SET LOCAL ROLE authenticated;

  BEGIN
    INSERT INTO public.cart_items (cart_id, item_type, product_id, source_surface)
      VALUES (cart_b, 'supplement', prod_id, 'web');
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    caught := TRUE;
  END;

  RESET ROLE;

  IF NOT caught THEN
    RAISE EXCEPTION '§3.2 RLS LEAK: user A inserted a cart_item into user B''s cart';
  END IF;
END
$rls_cross_insert$;

-- ============================================================
-- §4  cart_events  — authenticated cannot INSERT, only SELECT own.
-- ============================================================
DO $events_no_insert$
DECLARE
  cart_a UUID;
  caught BOOLEAN := FALSE;
BEGIN
  SELECT id INTO cart_a FROM public.carts
   WHERE user_id = '00000000-0000-4000-a000-000000000a01' AND status = 'active' LIMIT 1;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub','00000000-0000-4000-a000-000000000a01','role','authenticated')::text,
    true);
  SET LOCAL ROLE authenticated;

  BEGIN
    INSERT INTO public.cart_events (cart_id, user_id, event_type, event_payload)
      VALUES (cart_a, '00000000-0000-4000-a000-000000000a01', 'cart.created', '{}'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN
    caught := TRUE;
  END;

  RESET ROLE;

  IF NOT caught THEN
    RAISE EXCEPTION '§4 RLS LEAK: authenticated user inserted into cart_events (must be service_role only)';
  END IF;
END
$events_no_insert$;

-- ============================================================
-- All checks passed. Roll back synthetic data so the DB is unchanged.
-- ============================================================
ROLLBACK;

DO $ok$ BEGIN RAISE NOTICE 'VTID-03165 RLS + schema verification: ALL CHECKS PASSED'; END $ok$;
