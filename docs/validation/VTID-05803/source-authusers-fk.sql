-- VTID-05803 reconciliation: every foreign key on the SOURCE that references auth.users. Read-only, catalog only.
-- Run: psql "$SOURCE_DATABASE_URL" -X -A -t -F '|' -f source-authusers-fk.sql
-- Output: constraint|table|columns|referenced_columns|on_update|on_delete|deferrable|deferred|definition
SET default_transaction_read_only = on;
SELECT 'constraint', c.relname, string_agg(a.attname, ',' ORDER BY a.attnum), string_agg(ra.attname, ',' ORDER BY ra.attnum),
       CASE k.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END,
       CASE k.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END,
       k.condeferrable::text, k.condeferred::text, k.conname || ' :: ' || pg_get_constraintdef(k.oid)
FROM pg_constraint k
JOIN pg_class c ON c.oid = k.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
JOIN pg_attribute ra ON ra.attrelid = k.confrelid AND ra.attnum = ANY (k.confkey)
WHERE k.contype = 'f' AND n.nspname = 'public' AND k.confrelid = 'auth.users'::regclass
GROUP BY c.relname, k.oid, k.conname, k.confupdtype, k.confdeltype, k.condeferrable, k.condeferred
ORDER BY c.relname, k.conname;
SELECT 'count', count(*)::text, '', '', '', '', '', '', '' FROM pg_constraint WHERE contype = 'f' AND confrelid = 'auth.users'::regclass AND connamespace = 'public'::regnamespace;
