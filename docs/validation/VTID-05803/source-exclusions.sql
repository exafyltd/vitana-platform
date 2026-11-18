-- VTID-05803: objects in Supabase `public` that cannot or must not be restored on Aurora staging. Read-only.
-- Output: kind|table_or_view|name  (consumed by stage-exec.sh to drop entries from the pg_restore TOC list).
--   fk       every public foreign key EXCEPT public -> public and public -> auth.users. Excluded categories:
--            auth-internal (public -> auth.<other than users>, e.g. auth.sessions) and storage-internal (public -> storage.*)
--            plus any other non-public target. public -> auth.users is KEPT: auth.users exists on Aurora as an
--            empty stub (0001_auth_shim.sql), so those definitions are restored unchanged.
--   trigger  triggers whose function lives outside public (supabase_functions.http_request webhooks = outbound integrations)
--   view     views and matviews that read non-public relations, plus every view built on top of one of them
\set ON_ERROR_STOP 1
SET default_transaction_read_only = on;

SELECT 'fk', c.relname, k.conname
FROM pg_constraint k
JOIN pg_class c ON c.oid = k.conrelid
JOIN pg_class f ON f.oid = k.confrelid
JOIN pg_namespace fn ON fn.oid = f.relnamespace
WHERE k.contype = 'f' AND k.connamespace = 'public'::regnamespace
  AND NOT (fn.nspname = 'public' OR (fn.nspname = 'auth' AND f.relname = 'users'));

SELECT 'trigger', c.relname, t.tgname
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace cn ON cn.oid = c.relnamespace
JOIN pg_proc p ON p.oid = t.tgfoid
JOIN pg_namespace pn ON pn.oid = p.pronamespace
WHERE cn.nspname = 'public' AND NOT t.tgisinternal AND pn.nspname <> 'public';

WITH RECURSIVE
view_deps AS (
  SELECT DISTINCT v.oid AS view_oid, d.refobjid AS ref_oid
  FROM pg_class v
  JOIN pg_namespace vn ON vn.oid = v.relnamespace
  JOIN pg_rewrite r ON r.ev_class = v.oid
  JOIN pg_depend d ON d.objid = r.oid AND d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass
  WHERE vn.nspname = 'public' AND v.relkind IN ('v', 'm') AND d.refobjid <> v.oid
),
bad AS (
  SELECT vd.view_oid
  FROM view_deps vd
  JOIN pg_class rc ON rc.oid = vd.ref_oid
  JOIN pg_namespace rn ON rn.oid = rc.relnamespace
  WHERE rn.nspname NOT IN ('public', 'pg_catalog', 'information_schema')
  UNION
  SELECT vd.view_oid FROM view_deps vd JOIN bad b ON b.view_oid = vd.ref_oid
)
SELECT DISTINCT 'view', c.relname, c.relname
FROM bad b JOIN pg_class c ON c.oid = b.view_oid;
