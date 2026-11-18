-- VTID-05803: objects in Supabase `public` that cannot or must not be restored on Aurora staging. Read-only.
-- Output: kind|a|b  (stage-exec.sh drops these entries from the pg_restore TOC list and uses the same list to
-- classify the parity diff as expected).
--   fk        table|constraint   public -> non-public foreign keys (auth.users is not on Aurora; the auth bridge replaces them)
--   trigger   table|trigger      triggers whose function lives outside public (supabase_functions.http_request webhooks)
--   policy    table|policy       policies that read a non-public relation, or name a role Aurora staging does not have
--   view      view|relkind       views and matviews that read non-public relations, and every view built on one of them
--   index     index|table        indexes on those matviews
--   function  dump_signature|identity_signature   functions whose argument or result type is one of those views
\set ON_ERROR_STOP 1
SET default_transaction_read_only = on;
SET search_path = '';

SELECT 'fk', c.relname, k.conname
FROM pg_catalog.pg_constraint k
JOIN pg_catalog.pg_class c ON c.oid = k.conrelid
JOIN pg_catalog.pg_class f ON f.oid = k.confrelid
JOIN pg_catalog.pg_namespace fn ON fn.oid = f.relnamespace
WHERE k.contype = 'f' AND k.connamespace = 'public'::pg_catalog.regnamespace AND fn.nspname <> 'public';

SELECT 'trigger', c.relname, t.tgname
FROM pg_catalog.pg_trigger t
JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
JOIN pg_catalog.pg_namespace cn ON cn.oid = c.relnamespace
JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
WHERE cn.nspname = 'public' AND NOT t.tgisinternal AND pn.nspname <> 'public';

SELECT DISTINCT 'policy', c.relname, pol.polname
FROM pg_catalog.pg_policy pol
JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
JOIN pg_catalog.pg_namespace cn ON cn.oid = c.relnamespace
WHERE cn.nspname = 'public'
  AND (
    EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend d
      JOIN pg_catalog.pg_class rc ON rc.oid = d.refobjid
      JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
      WHERE d.classid = 'pg_catalog.pg_policy'::pg_catalog.regclass AND d.objid = pol.oid
        AND d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND rn.nspname NOT IN ('public', 'pg_catalog', 'information_schema'))
    OR EXISTS (
      SELECT 1 FROM pg_catalog.unnest(pol.polroles) r(oid)
      JOIN pg_catalog.pg_roles ro ON ro.oid = r.oid
      WHERE r.oid <> 0 AND ro.rolname NOT IN ('anon', 'authenticated', 'service_role'))
  );

WITH RECURSIVE
view_deps AS (
  SELECT DISTINCT v.oid AS view_oid, d.refobjid AS ref_oid
  FROM pg_catalog.pg_class v
  JOIN pg_catalog.pg_namespace vn ON vn.oid = v.relnamespace
  JOIN pg_catalog.pg_rewrite r ON r.ev_class = v.oid
  JOIN pg_catalog.pg_depend d ON d.objid = r.oid AND d.classid = 'pg_catalog.pg_rewrite'::pg_catalog.regclass
   AND d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
  WHERE vn.nspname = 'public' AND v.relkind IN ('v', 'm') AND d.refobjid <> v.oid
),
bad AS (
  SELECT vd.view_oid
  FROM view_deps vd
  JOIN pg_catalog.pg_class rc ON rc.oid = vd.ref_oid
  JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
  WHERE rn.nspname NOT IN ('public', 'pg_catalog', 'information_schema')
  UNION
  SELECT vd.view_oid FROM view_deps vd JOIN bad b ON b.view_oid = vd.ref_oid
),
bad_views AS (SELECT DISTINCT view_oid AS oid FROM bad)
SELECT 'view', c.relname, c.relkind::text
FROM bad_views b JOIN pg_catalog.pg_class c ON c.oid = b.oid
UNION ALL
SELECT 'index', ic.relname, c.relname
FROM bad_views b
JOIN pg_catalog.pg_class c ON c.oid = b.oid
JOIN pg_catalog.pg_index i ON i.indrelid = c.oid
JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
UNION ALL
SELECT DISTINCT 'function',
       p.proname || '(' || coalesce((SELECT pg_catalog.string_agg(pg_catalog.format_type(t, NULL), ', ' ORDER BY o)
                                    FROM pg_catalog.unnest(p.proargtypes) WITH ORDINALITY u(t, o)), '') || ')',
       p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')'
FROM bad_views b
JOIN pg_catalog.pg_class c ON c.oid = b.oid
JOIN pg_catalog.pg_depend d ON d.refclassid = 'pg_catalog.pg_type'::pg_catalog.regclass AND d.refobjid = c.reltype
 AND d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
JOIN pg_catalog.pg_proc p ON p.oid = d.objid;
