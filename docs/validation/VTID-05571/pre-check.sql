-- VTID-05571 read-only PRE-check (run by Kiro through RUN-MIGRATION's read-only check, never from this PR).
-- Run after 20261102040000..040200 are applied and BEFORE 20261102040300_vtid_05571_orphan_cleanup_run.sql.
-- SELECT statements only. Pins the plan's premise-2 baseline (2026-10-06: 1,067 memory_facts all owned by ...0099;
-- 305 chat_messages from 2 senders, 236 sent by the bot ...0001; 135 memory_items; 9 user_notifications; 3 rows under the
-- fake 550e8400 tenant) so the numbers can be compared before anything moves.

-- 1. The canonical membership source is present and populated (the remap and the writers read it).
SELECT count(*)                                         AS user_tenants_rows,
       count(*) FILTER (WHERE is_primary)               AS primary_rows,
       count(DISTINCT user_id)                          AS members,
       (SELECT count(*) FROM (SELECT user_id FROM public.user_tenants GROUP BY user_id
                              HAVING count(*) FILTER (WHERE is_primary) = 1) s) AS members_with_exactly_one_primary,
       (SELECT count(*) FROM (SELECT user_id FROM public.user_tenants GROUP BY user_id
                              HAVING count(*) FILTER (WHERE is_primary) = 0) s) AS members_with_no_primary,
       (SELECT count(*) FROM (SELECT user_id FROM public.user_tenants GROUP BY user_id
                              HAVING count(*) FILTER (WHERE is_primary) > 1) s) AS members_with_2plus_primaries
  FROM public.user_tenants;

-- 2. ...0001 as tenant versus ...0001 as owner, per hot table (column split first, plan premise 1).
SELECT 'memory_facts' AS table_name,
       count(*) FILTER (WHERE tenant_id = '00000000-0000-0000-0000-000000000001')                                   AS on_dev_tenant,
       count(*) FILTER (WHERE tenant_id = '00000000-0000-0000-0000-000000000001'
                          AND user_id = '00000000-0000-0000-0000-000000000099')                                     AS dev_user_0099,
       count(*) FILTER (WHERE tenant_id = '00000000-0000-0000-0000-000000000001'
                          AND user_id = '00000000-0000-0000-0000-000000000001')                                     AS bot_owner,
       count(*) FILTER (WHERE tenant_id::text LIKE '550e8400-%')                                                    AS fake_550e8400
  FROM public.memory_facts
UNION ALL
SELECT 'memory_items',
       count(*) FILTER (WHERE tenant_id = '00000000-0000-0000-0000-000000000001'),
       count(*) FILTER (WHERE tenant_id = '00000000-0000-0000-0000-000000000001' AND user_id = '00000000-0000-0000-0000-000000000099'),
       count(*) FILTER (WHERE tenant_id = '00000000-0000-0000-0000-000000000001' AND user_id = '00000000-0000-0000-0000-000000000001'),
       count(*) FILTER (WHERE tenant_id::text LIKE '550e8400-%')
  FROM public.memory_items
UNION ALL
SELECT 'chat_messages (owner = sender_id)',
       count(*) FILTER (WHERE tenant_id = '00000000-0000-0000-0000-000000000001'),
       count(*) FILTER (WHERE tenant_id = '00000000-0000-0000-0000-000000000001' AND sender_id = '00000000-0000-0000-0000-000000000099'),
       count(*) FILTER (WHERE tenant_id = '00000000-0000-0000-0000-000000000001' AND sender_id = '00000000-0000-0000-0000-000000000001'),
       count(*) FILTER (WHERE tenant_id::text LIKE '550e8400-%')
  FROM public.chat_messages
UNION ALL
SELECT 'user_notifications',
       count(*) FILTER (WHERE tenant_id = '00000000-0000-0000-0000-000000000001'),
       count(*) FILTER (WHERE tenant_id = '00000000-0000-0000-0000-000000000001' AND user_id = '00000000-0000-0000-0000-000000000099'),
       count(*) FILTER (WHERE tenant_id = '00000000-0000-0000-0000-000000000001' AND user_id = '00000000-0000-0000-0000-000000000001'),
       count(*) FILTER (WHERE tenant_id::text LIKE '550e8400-%')
  FROM public.user_notifications;

-- 2b. Distinct senders of the ...0001 chat_messages (premise 2: 2 senders, 236 rows from the bot).
SELECT sender_id, count(*) AS rows
  FROM public.chat_messages
 WHERE tenant_id = '00000000-0000-0000-0000-000000000001'
 GROUP BY sender_id ORDER BY rows DESC;

-- 3. Every registry table (d43-d50, availability, boundary/consent, analytics, hot tables; counted even if zero or absent):
--    tenant class x owner class x the decision the move would take. Only rows that are not 'keep' will change.
SELECT table_name, table_present, tenant_class, owner_class, decision, row_count
  FROM public.analyze_orphan_rows()
 ORDER BY table_name, tenant_class, owner_class, decision;
