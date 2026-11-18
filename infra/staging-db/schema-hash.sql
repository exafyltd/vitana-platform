-- staging-db:schema-hash (VTID-05782, plan autonomous-to-staging-r2 design.md §5.1). ONE statement, read-only.
-- The same text runs on the PGlite build (scripts/ci/staging-db/build-schema.mjs) and on vitana-aurora-staging through
-- the RDS Data API (scripts/aws/staging-db-load.sh), so both sides hash the same object list.
-- Object list: every non-system schema, relation (table, partitioned table, view, materialized view, sequence, foreign
-- table), column (name, type, NOT NULL), constraint (name, type), index (name), function (name, identity arguments,
-- kind), RLS policy (name, command) and user trigger. Extension members are left out (their set depends on the
-- extension version, not on the migrations). Default expressions, constraint/index definitions and policy bodies are
-- left out on purpose: their deparsed text differs between Postgres versions (PGlite vs Aurora PostgreSQL 16).
WITH ext AS (
  SELECT objid FROM pg_depend WHERE deptype = 'e'
), sch AS (
  SELECT n.oid, n.nspname FROM pg_namespace n
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
    AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
    AND n.oid NOT IN (SELECT objid FROM ext)
), objs AS (
  SELECT 'schema ' || s.nspname AS d FROM sch s
  UNION ALL
  SELECT 'rel ' || s.nspname || '.' || c.relname || ' ' || c.relkind::text
    FROM pg_class c JOIN sch s ON s.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') AND c.oid NOT IN (SELECT objid FROM ext)
  UNION ALL
  SELECT 'col ' || s.nspname || '.' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
         || CASE WHEN a.attnotnull THEN ' notnull' ELSE '' END
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN sch s ON s.oid = c.relnamespace
   WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND c.oid NOT IN (SELECT objid FROM ext)
  UNION ALL
  SELECT 'con ' || s.nspname || '.' || c.relname || '.' || k.conname || ' ' || k.contype::text
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN sch s ON s.oid = c.relnamespace
   WHERE c.oid NOT IN (SELECT objid FROM ext)
  UNION ALL
  SELECT 'idx ' || s.nspname || '.' || i.relname
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN sch s ON s.oid = i.relnamespace
   WHERE x.indrelid NOT IN (SELECT objid FROM ext)
  UNION ALL
  SELECT 'fn ' || s.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || p.prokind::text
    FROM pg_proc p JOIN sch s ON s.oid = p.pronamespace
   WHERE p.oid NOT IN (SELECT objid FROM ext)
  UNION ALL
  SELECT 'pol ' || pl.schemaname || '.' || pl.tablename || '.' || pl.policyname || ' ' || pl.cmd
    FROM pg_policies pl WHERE pl.schemaname IN (SELECT nspname FROM sch)
  UNION ALL
  SELECT 'trg ' || s.nspname || '.' || c.relname || '.' || t.tgname
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN sch s ON s.oid = c.relnamespace
   WHERE NOT t.tgisinternal
)
SELECT encode(sha256(convert_to(coalesce(string_agg(d, E'\n' ORDER BY d COLLATE "C"), ''), 'UTF8')), 'hex') AS schema_hash,
       count(*)::text AS objects
  FROM objs
