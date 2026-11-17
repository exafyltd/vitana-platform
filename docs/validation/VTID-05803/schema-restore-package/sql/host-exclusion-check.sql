-- Production-host exclusion. Any non-zero count fails the restore (restore-core.sh step 7). Matches the production
-- PROJECT REFERENCE and the production pooler host wherever a definition, default, policy, view, constraint, trigger or
-- setting can store text. Run on the TARGET after the outbox replacement. Output: name|count.
\pset tuples_only on
\pset format unaligned
\pset fieldsep '|'
SELECT 'function_definitions', count(*) FROM (
  SELECT pg_get_functiondef(oid) AS d FROM pg_proc
   WHERE prokind IN ('f','p')
     AND pronamespace IN (SELECT oid FROM pg_namespace WHERE nspname IN ('public','governance','legacy_archive','auth','storage','extensions'))
) f WHERE f.d ILIKE '%inmkhvwdcuyhnxkgfvsb%' OR f.d ILIKE '%pooler.supabase.com%'
UNION ALL
SELECT 'view_definitions', count(*) FROM pg_views
 WHERE schemaname IN ('public','governance','legacy_archive')
   AND (definition ILIKE '%inmkhvwdcuyhnxkgfvsb%' OR definition ILIKE '%pooler.supabase.com%')
UNION ALL
SELECT 'policy_expressions', count(*) FROM pg_policies
 WHERE schemaname IN ('public','governance','legacy_archive')
   AND (concat(qual, with_check) ILIKE '%inmkhvwdcuyhnxkgfvsb%' OR concat(qual, with_check) ILIKE '%pooler.supabase.com%')
UNION ALL
SELECT 'column_defaults', count(*) FROM pg_attrdef d JOIN pg_class c ON c.oid = d.adrelid
 WHERE c.relnamespace IN (SELECT oid FROM pg_namespace WHERE nspname IN ('public','governance','legacy_archive'))
   AND (pg_get_expr(d.adbin, d.adrelid) ILIKE '%inmkhvwdcuyhnxkgfvsb%' OR pg_get_expr(d.adbin, d.adrelid) ILIKE '%pooler.supabase.com%')
UNION ALL
SELECT 'constraint_definitions', count(*) FROM pg_constraint
 WHERE connamespace IN (SELECT oid FROM pg_namespace WHERE nspname IN ('public','governance','legacy_archive'))
   AND (pg_get_constraintdef(oid) ILIKE '%inmkhvwdcuyhnxkgfvsb%' OR pg_get_constraintdef(oid) ILIKE '%pooler.supabase.com%')
UNION ALL
SELECT 'trigger_definitions', count(*) FROM pg_trigger
 WHERE NOT tgisinternal
   AND (pg_get_triggerdef(oid) ILIKE '%inmkhvwdcuyhnxkgfvsb%' OR pg_get_triggerdef(oid) ILIKE '%pooler.supabase.com%')
UNION ALL
SELECT 'database_and_role_settings', count(*) FROM pg_db_role_setting
 WHERE array_to_string(setconfig, ' ') ILIKE '%inmkhvwdcuyhnxkgfvsb%' OR array_to_string(setconfig, ' ') ILIKE '%pooler.supabase.com%'
ORDER BY 1;
