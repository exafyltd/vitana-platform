-- VTID-05023 (Aurora rehearsal, precondition for VTID-05465/05466): the
-- UNIQUE (tenant_id, user_id) that 20251231000001 declares inline is absent on the
-- live copy (only the PK on id). Add it idempotently, and refuse loudly if
-- duplicates exist rather than dropping rows.
DO $u$
DECLARE dup int;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indrelid = 'public.user_tenants'::regclass AND i.indisunique
       AND i.indnkeyatts = 2
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
             WHERE a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey::int2[]))
           = ARRAY['tenant_id', 'user_id']
  ) THEN
    RETURN;
  END IF;
  SELECT count(*) INTO dup FROM (
    SELECT tenant_id, user_id FROM public.user_tenants GROUP BY 1, 2 HAVING count(*) > 1
  ) d;
  IF dup > 0 THEN
    RAISE EXCEPTION 'VTID-05023: % duplicate (tenant_id, user_id) pairs in public.user_tenants; resolve before adding the unique key', dup;
  END IF;
  ALTER TABLE public.user_tenants ADD CONSTRAINT user_tenants_tenant_id_user_id_key UNIQUE (tenant_id, user_id);
END
$u$;
