-- VTID-05571 read-only POST-check (run by Kiro through RUN-MIGRATION's read-only check, never from this PR).
-- Run after 20261102040300_vtid_05571_orphan_cleanup_run.sql (section 1-3) and after 20261102040400_vtid_05571_writer_repoint.sql (section 4-5).
-- SELECT statements only.

-- 1. Zero remaining orphan rows: this must return NO rows.
SELECT table_name, tenant_class, owner_class, decision, row_count
  FROM public.analyze_orphan_rows()
 WHERE decision IS NOT NULL AND decision <> 'keep' AND row_count > 0;

-- 2. What went to quarantine (per table and reason), and what is blocked (must be 0 move_blocked).
SELECT source_table, reason, count(*) AS rows, count(*) FILTER (WHERE NOT source_deleted) AS still_in_source
  FROM public.mt_orphan_quarantine
 WHERE quarantined_by = 'VTID-05571'
 GROUP BY source_table, reason ORDER BY source_table, reason;

-- 3. Nothing owned by the dev user ...0099 is left in any registry table, and none of it reached a live tenant
--    (this must return NO rows; it covers memory_facts, memory_items, chat_messages, user_notifications, d43-d50,
--    boundary/consent and the availability tables). Snapshot coverage: every quarantined or remapped row is in bak_*.
SELECT table_name, tenant_class, row_count
  FROM public.analyze_orphan_rows()
 WHERE owner_class = 'dev_0099' AND row_count > 0;

SELECT 'bak_mt_data_cleanup_memory_facts' AS snapshot, count(*) AS rows FROM public.bak_mt_data_cleanup_memory_facts
UNION ALL SELECT 'bak_mt_data_cleanup_memory_items', count(*) FROM public.bak_mt_data_cleanup_memory_items
UNION ALL SELECT 'bak_mt_data_cleanup_chat_messages', count(*) FROM public.bak_mt_data_cleanup_chat_messages
UNION ALL SELECT 'bak_mt_data_cleanup_user_notifications', count(*) FROM public.bak_mt_data_cleanup_user_notifications;

-- 4. After the repoint: no repointed function body contains the ...0001 tenant or ...0099 user literal
--    (this must return NO rows), and all 19 functions exist.
SELECT p.oid::regprocedure AS function
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('availability_compute', 'availability_get_override', 'availability_set_override', 'availability_clear_override',
                     'availability_get_recent', 'd41_set_personal_boundary', 'd41_set_consent', 'd43_record_data_point',
                     'd43_create_adaptation_plan', 'd43_create_snapshot', 'd44_create_signal', 'd44_add_signal_evidence',
                     'd44_update_signal_status', 'd44_record_intervention', 'd45_store_window', 'd45_acknowledge_window',
                     'd45_record_forecast_history', 'd50_store_reinforcement', 'd50_update_eligibility_cache')
   AND (pg_get_functiondef(p.oid) LIKE '%00000000-0000-0000-0000-000000000001%'
     OR pg_get_functiondef(p.oid) LIKE '%00000000-0000-0000-0000-000000000099%');

SELECT count(*) AS repointed_functions_present
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('availability_compute', 'availability_get_override', 'availability_set_override', 'availability_clear_override',
                     'availability_get_recent', 'd41_set_personal_boundary', 'd41_set_consent', 'd43_record_data_point',
                     'd43_create_adaptation_plan', 'd43_create_snapshot', 'd44_create_signal', 'd44_add_signal_evidence',
                     'd44_update_signal_status', 'd44_record_intervention', 'd45_store_window', 'd45_acknowledge_window',
                     'd45_record_forecast_history', 'd50_store_reinforcement', 'd50_update_eligibility_cache');

-- 5. The lookup path is live without calling a writer: members with exactly one primary row, reported next to the
--    0 / 2+ list (those writers now fail closed for them; they are the quarantine review list).
SELECT count(*) FILTER (WHERE n = 1) AS members_with_exactly_one_primary,
       count(*) FILTER (WHERE n = 0) AS members_with_no_primary,
       count(*) FILTER (WHERE n > 1) AS members_with_2plus_primaries
  FROM (SELECT user_id, count(*) FILTER (WHERE is_primary) AS n FROM public.user_tenants GROUP BY user_id) s;

SELECT user_id, count(*) FILTER (WHERE is_primary) AS primaries
  FROM public.user_tenants GROUP BY user_id
HAVING count(*) FILTER (WHERE is_primary) <> 1
 ORDER BY user_id;
