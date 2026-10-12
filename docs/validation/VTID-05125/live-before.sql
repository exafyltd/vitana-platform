-- VTID-05125 live before-state — READ-ONLY (catalog SELECTs only), project
-- inmkhvwdcuyhnxkgfvsb. Captured 2026-10-12 22:42:20 UTC by the implementer.
-- Rollout step 2 re-runs Q1 + Q2 immediately before the RUN-MIGRATION
-- dispatch and records the result here; dispatch only if it still matches:
-- exactly 4 rows, migrate_x = true, service_x = true, auth_x = anon_x = false.

-- Q1. The four memory functions (every overload).
SELECT p.oid::regprocedure AS fn, p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
  has_function_privilege('migrate', p.oid, 'EXECUTE')       AS migrate_x,
  has_function_privilege('service_role', p.oid, 'EXECUTE')  AS service_x,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
  has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_x,
  now() AS captured_at
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
WHERE p.proname IN ('write_fact','get_current_facts','recall_at_time_range','memory_facts_semantic_search')
ORDER BY 1;

-- Result 2026-10-12 22:42:20 UTC (4 rows):
-- fn                                                                    | prosecdef | owner    | acl                                                      | migrate_x | service_x | auth_x | anon_x
-- get_current_facts(uuid,uuid,text,text[])                              | t         | postgres | {postgres=X/postgres,service_role=X/postgres,migrate=X/postgres} | t | t | f | f
-- write_fact(uuid,uuid,text,text,text,text,text,uuid,numeric,uuid)      | t         | postgres | {postgres=X/postgres,service_role=X/postgres,migrate=X/postgres} | t | t | f | f
-- memory_facts_semantic_search(vector,integer,uuid,uuid,text,numeric)   | t         | postgres | {postgres=X/postgres,service_role=X/postgres,migrate=X/postgres} | t | t | f | f
-- recall_at_time_range(uuid,timestamp with time zone,timestamp with time zone,text) | t | postgres | {postgres=X/postgres,service_role=X/postgres,migrate=X/postgres} | t | t | f | f

-- Q2. The migrate role and its membership graph.
SELECT r.rolname, r.rolcanlogin, r.rolreplication, r.rolbypassrls, r.rolsuper,
  (SELECT array_agg(g.rolname::text) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid) AS member_of,
  (SELECT array_agg(u.rolname::text) FROM pg_auth_members m JOIN pg_roles u ON u.oid = m.member WHERE m.roleid = r.oid) AS members
FROM pg_roles r WHERE r.rolname = 'migrate';

-- Result 2026-10-12:
-- rolname | rolcanlogin | rolreplication | rolbypassrls | rolsuper | member_of | members
-- migrate | t           | t              | t            | f        | NULL      | {postgres}
