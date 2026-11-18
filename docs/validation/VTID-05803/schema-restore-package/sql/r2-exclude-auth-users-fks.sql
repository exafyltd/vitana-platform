-- VTID-05803, owner decision R2 (VTID-05023): foreign keys from public into auth.users are NOT kept on Aurora staging.
-- auth.users on Aurora is an empty stub (no member rows), so any such FK would make every member-row insert fail.
-- Runs inside the restore transaction, after the dump. Prints one line per dropped constraint and the total.
DO $r2$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN SELECT c.conname, c.conrelid::regclass AS tbl FROM pg_constraint c JOIN pg_namespace ns ON ns.oid = c.connamespace
           WHERE c.contype = 'f' AND ns.nspname = 'public' AND c.confrelid = to_regclass('auth.users') ORDER BY 2::text, 1
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    RAISE NOTICE 'R2 excluded fk %.%', r.tbl, r.conname;
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'R2 excluded fks total %', n;
END $r2$;
