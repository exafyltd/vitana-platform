-- Debug migration: verify products table exists + grants + raise a NOTICE
-- with the counts so we can see them in the migration log.
DO $$
DECLARE
  v_exists BOOLEAN;
  v_count BIGINT;
  v_grants TEXT;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'products'
  ) INTO v_exists;
  RAISE NOTICE 'products table exists: %', v_exists;

  IF v_exists THEN
    EXECUTE 'SELECT COUNT(*) FROM public.products' INTO v_count;
    RAISE NOTICE 'products row count: %', v_count;

    SELECT string_agg(grantee || ':' || privilege_type, ', ')
      INTO v_grants
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'products';
    RAISE NOTICE 'products grants: %', v_grants;
  END IF;
END $$;

-- Re-grant explicitly to anon as well (maybe PostgREST requires this to see table)
GRANT SELECT ON public.products TO anon;
GRANT SELECT ON public.merchants TO anon;

-- Super forceful pgrst reload
NOTIFY pgrst, 'reload schema';
NOTIFY pgrst, 'reload config';
