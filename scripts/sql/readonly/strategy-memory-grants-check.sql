-- VTID-05693 (strategy-execution-wave1/security-evidence): live grants and RLS check, READ-ONLY.
--
-- Catalog SELECTs only. No statement writes, locks, sets a session value or calls a side-effect function; the test
-- scripts/sql/readonly/strategy-memory-grants-check.test.mjs fails the build if that ever changes.
-- Who runs it: an authorised operator, through a read-only connection (see
-- docs/programs/strategy-execution/security-live-evidence.md). Agents and CI never run it against a live database.
-- Where the output goes: docs/validation/VTID-05693/live-output.md (added by the operator's PR).
--
-- Every role name is resolved with to_regrole() first, and every table with to_regclass(), so a missing role or table
-- shows as a NULL / false row instead of an error. Expected values are written above each query.

-- Q0. Context: which database, which user, read-only or not, when.
--     Expect transaction_read_only = on (the operator connects read-only).
SELECT current_database()                       AS database,
       current_user                             AS run_as,
       current_setting('transaction_read_only') AS transaction_read_only,
       current_setting('server_version')        AS server_version,
       now()                                    AS captured_at;

-- Q1. The four roles. Expect four rows, role_exists = true for each. Reference (VTID-05125 live-before.sql, 2026-10-12):
--     migrate had rolbypassrls = true, so table RLS does not constrain it.
WITH roles(rolname) AS (
  VALUES ('anon'), ('authenticated'), ('service_role'), ('migrate')
)
SELECT r.rolname,
       to_regrole(r.rolname) IS NOT NULL AS role_exists,
       pr.rolsuper,
       pr.rolbypassrls,
       pr.rolcanlogin
FROM roles r
LEFT JOIN pg_roles pr ON pr.oid = to_regrole(r.rolname)::oid
ORDER BY r.rolname;

-- Q2. Every overload of the four memory functions x the four roles.
--     Expect: anon, authenticated, migrate -> can_execute = false; service_role -> can_execute = true;
--     public_execute = false; security_definer as recorded on 2026-10-12 (true). A function with no overload shows one
--     row per role with overload = NULL.
WITH fns(proname) AS (
  VALUES ('write_fact'), ('get_current_facts'), ('recall_at_time_range'), ('memory_facts_semantic_search')
),
roles(rolname) AS (
  VALUES ('anon'), ('authenticated'), ('service_role'), ('migrate')
),
overloads AS (
  SELECT f.proname AS expected_function, p.oid AS fn_oid, p.prosecdef, p.proowner, p.proacl
  FROM fns f
  LEFT JOIN pg_proc p
    ON p.proname = f.proname
   AND p.pronamespace = 'public'::regnamespace
)
SELECT o.expected_function,
       o.fn_oid::regprocedure::text           AS overload,
       o.prosecdef                            AS security_definer,
       pg_get_userbyid(o.proowner)            AS owner,
       o.proacl::text                         AS proacl,
       CASE WHEN o.fn_oid IS NULL THEN NULL
            ELSE EXISTS (
              SELECT 1
              FROM aclexplode(coalesce(o.proacl, acldefault('f', o.proowner))) a
              WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
            )
       END                                    AS public_execute,
       r.rolname,
       to_regrole(r.rolname) IS NOT NULL      AS role_exists,
       CASE WHEN o.fn_oid IS NULL OR to_regrole(r.rolname) IS NULL THEN NULL
            ELSE has_function_privilege(to_regrole(r.rolname)::oid, o.fn_oid, 'EXECUTE')
       END                                    AS can_execute
FROM overloads o
CROSS JOIN roles r
ORDER BY o.expected_function, overload, r.rolname;

-- Q3. One row: the memory-function verdict. Expect memory_functions_ok = true, functions_found = 4,
--     overloads_found = 4 (the 2026-10-12 read showed one overload each).
WITH fns(proname) AS (
  VALUES ('write_fact'), ('get_current_facts'), ('recall_at_time_range'), ('memory_facts_semantic_search')
),
p AS (
  SELECT pp.oid, pp.proname
  FROM pg_proc pp
  WHERE pp.pronamespace = 'public'::regnamespace
    AND pp.proname IN (SELECT proname FROM fns)
)
SELECT count(DISTINCT p.proname)                                       AS functions_found,
       count(*)                                                        AS overloads_found,
       to_regrole('anon') IS NOT NULL
         AND to_regrole('authenticated') IS NOT NULL
         AND to_regrole('service_role') IS NOT NULL                    AS required_roles_exist,
       to_regrole('migrate') IS NOT NULL                               AS migrate_role_exists,
       count(DISTINCT p.proname) = 4
         AND coalesce(bool_and(
               CASE WHEN to_regrole('anon') IS NULL THEN true
                    ELSE NOT has_function_privilege(to_regrole('anon')::oid, p.oid, 'EXECUTE') END
           AND CASE WHEN to_regrole('authenticated') IS NULL THEN true
                    ELSE NOT has_function_privilege(to_regrole('authenticated')::oid, p.oid, 'EXECUTE') END
           AND CASE WHEN to_regrole('migrate') IS NULL THEN true
                    ELSE NOT has_function_privilege(to_regrole('migrate')::oid, p.oid, 'EXECUTE') END
           AND CASE WHEN to_regrole('service_role') IS NULL THEN false
                    ELSE has_function_privilege(to_regrole('service_role')::oid, p.oid, 'EXECUTE') END
         ), false)                                                     AS memory_functions_ok
FROM p;

-- Q4. Row-level security on the memory and tenant tables.
--     Expect table_exists = true and relrowsecurity = true for every member-data table; record relforcerowsecurity and
--     policy_count as found (no expected value is asserted for them here).
WITH tbls(relname) AS (
  VALUES ('memory_items'), ('memory_facts'), ('memory_diary_entries'), ('relationship_edges'), ('vtid_ledger'),
         ('oasis_events'), ('user_tenants'), ('tenants'), ('app_users')
)
SELECT t.relname,
       to_regclass('public.' || quote_ident(t.relname)) IS NOT NULL AS table_exists,
       c.relrowsecurity,
       c.relforcerowsecurity,
       pg_get_userbyid(c.relowner)                                  AS owner,
       (SELECT count(*)
        FROM pg_policies pol
        WHERE pol.schemaname = 'public' AND pol.tablename = t.relname) AS policy_count
FROM tbls t
LEFT JOIN pg_class c ON c.oid = to_regclass('public.' || quote_ident(t.relname))::oid
ORDER BY t.relname;

-- Q5. Every policy on those tables, verbatim from pg_policies.
SELECT pol.tablename,
       pol.policyname,
       pol.permissive,
       pol.roles::text AS roles,
       pol.cmd,
       pol.qual,
       pol.with_check
FROM pg_policies pol
WHERE pol.schemaname = 'public'
  AND pol.tablename IN ('memory_items', 'memory_facts', 'memory_diary_entries', 'relationship_edges', 'vtid_ledger',
                        'oasis_events', 'user_tenants', 'tenants', 'app_users')
ORDER BY pol.tablename, pol.policyname;

-- Q6. Table privileges of the four roles on those tables (what RLS then filters). Recorded as found.
WITH tbls(relname) AS (
  VALUES ('memory_items'), ('memory_facts'), ('memory_diary_entries'), ('relationship_edges'), ('vtid_ledger'),
         ('oasis_events'), ('user_tenants'), ('tenants'), ('app_users')
),
roles(rolname) AS (
  VALUES ('anon'), ('authenticated'), ('service_role'), ('migrate')
),
pairs AS (
  SELECT t.relname, to_regclass('public.' || quote_ident(t.relname))::oid AS tbl_oid,
         r.rolname, to_regrole(r.rolname)::oid AS role_oid
  FROM tbls t CROSS JOIN roles r
)
SELECT relname,
       rolname,
       CASE WHEN tbl_oid IS NULL OR role_oid IS NULL THEN NULL
            ELSE has_table_privilege(role_oid, tbl_oid, 'SELECT') END AS can_select,
       CASE WHEN tbl_oid IS NULL OR role_oid IS NULL THEN NULL
            ELSE has_table_privilege(role_oid, tbl_oid, 'INSERT') END AS can_insert,
       CASE WHEN tbl_oid IS NULL OR role_oid IS NULL THEN NULL
            ELSE has_table_privilege(role_oid, tbl_oid, 'UPDATE') END AS can_update,
       CASE WHEN tbl_oid IS NULL OR role_oid IS NULL THEN NULL
            ELSE has_table_privilege(role_oid, tbl_oid, 'DELETE') END AS can_delete
FROM pairs
ORDER BY relname, rolname;
