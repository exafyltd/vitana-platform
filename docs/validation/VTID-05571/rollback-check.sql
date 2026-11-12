-- VTID-05571 read-only ROLLBACK-check (run by Kiro through RUN-MIGRATION's read-only check, never from this PR).
-- Run after 20261102040300_vtid_05571_orphan_cleanup_rollback.sql was applied for real. SELECT statements only.

-- 1. Every snapshot row is back in its table with its original tenant_id: all four numbers must be 0.
SELECT (SELECT count(*) FROM public.bak_mt_data_cleanup_memory_facts b
         WHERE NOT EXISTS (SELECT 1 FROM public.memory_facts t WHERE t.id = b.id AND t.tenant_id IS NOT DISTINCT FROM b.tenant_id))      AS memory_facts_not_restored,
       (SELECT count(*) FROM public.bak_mt_data_cleanup_memory_items b
         WHERE NOT EXISTS (SELECT 1 FROM public.memory_items t WHERE t.id = b.id AND t.tenant_id IS NOT DISTINCT FROM b.tenant_id))      AS memory_items_not_restored,
       (SELECT count(*) FROM public.bak_mt_data_cleanup_chat_messages b
         WHERE NOT EXISTS (SELECT 1 FROM public.chat_messages t WHERE t.id = b.id AND t.tenant_id IS NOT DISTINCT FROM b.tenant_id))     AS chat_messages_not_restored,
       (SELECT count(*) FROM public.bak_mt_data_cleanup_user_notifications b
         WHERE NOT EXISTS (SELECT 1 FROM public.user_notifications t WHERE t.id = b.id AND t.tenant_id IS NOT DISTINCT FROM b.tenant_id)) AS user_notifications_not_restored;

-- 2. The lane's quarantine rows are gone (must be 0).
SELECT count(*) AS lane_quarantine_rows FROM public.mt_orphan_quarantine WHERE quarantined_by = 'VTID-05571';

-- 3. The state matches pre-check.sql again (compare the numbers).
SELECT table_name, tenant_class, owner_class, decision, row_count
  FROM public.analyze_orphan_rows()
 WHERE row_count > 0 AND tenant_class IS DISTINCT FROM 'live'
 ORDER BY table_name, tenant_class, owner_class, decision;
