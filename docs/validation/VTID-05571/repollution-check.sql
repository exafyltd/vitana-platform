-- VTID-05571 read-only RE-POLLUTION check (R3-F1; run by Kiro through RUN-MIGRATION's read-only check, never from this PR).
-- Run after the cleanup and the writer repoint, and again on any later date. Every number must read 0: no row carries the
-- dead dev tenant ...0001 after the cleanup. SELECT statements only.
-- If a number is above 0, name the source from the row's metadata (metadata.source / orb_session_id) before touching it;
-- the d46/d48/d49 gateway writers are covered by lane engine-tenant-fallbacks' tests, not by this count alone.

-- 1. Per registry table: rows on tenant ...0001, by owner class (bot_0001 is the bot user, dev_0099 the dev user).
SELECT table_name, owner_class, sum(row_count) AS rows_on_dev_tenant
  FROM public.analyze_orphan_rows()
 WHERE tenant_class = 'dev_0001'
 GROUP BY table_name, owner_class
 ORDER BY table_name, owner_class;

-- 2. chat_messages by sender class, rows created after the cleanup ran (the cleanup time is the newest quarantine row).
WITH cleanup AS (SELECT coalesce(max(quarantined_at), '-infinity'::timestamptz) AS at
                   FROM public.mt_orphan_quarantine WHERE quarantined_by = 'VTID-05571')
SELECT CASE WHEN m.sender_id = '00000000-0000-0000-0000-000000000001' THEN 'bot_0001'
            WHEN m.sender_id = '00000000-0000-0000-0000-000000000099' THEN 'dev_0099'
            ELSE 'member' END AS sender_class,
       count(*) AS rows_on_dev_tenant_after_cleanup
  FROM public.chat_messages m, cleanup c
 WHERE m.tenant_id = '00000000-0000-0000-0000-000000000001' AND m.created_at > c.at
 GROUP BY 1;

-- 3. Hot tables, plain count (independent of the helper functions).
SELECT (SELECT count(*) FROM public.memory_facts       WHERE tenant_id = '00000000-0000-0000-0000-000000000001') AS memory_facts,
       (SELECT count(*) FROM public.memory_items       WHERE tenant_id = '00000000-0000-0000-0000-000000000001') AS memory_items,
       (SELECT count(*) FROM public.chat_messages      WHERE tenant_id = '00000000-0000-0000-0000-000000000001') AS chat_messages,
       (SELECT count(*) FROM public.user_notifications WHERE tenant_id = '00000000-0000-0000-0000-000000000001') AS user_notifications;
