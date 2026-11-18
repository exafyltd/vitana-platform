-- Definition-level parity for every public-schema foreign key that references auth.users.
-- Read-only. One row per constraint: name|table|definition|confupdtype|confdeltype|confmatchtype|convalidated|condeferrable|condeferred
\pset tuples_only on
\pset format unaligned
\pset fieldsep '|'
SELECT c.conname, n.nspname||'.'||t.relname, pg_get_constraintdef(c.oid), c.confupdtype, c.confdeltype, c.confmatchtype, c.convalidated, c.condeferrable, c.condeferred
FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
WHERE c.contype='f' AND c.confrelid=to_regclass('auth.users') AND n.nspname='public'
ORDER BY 1;
