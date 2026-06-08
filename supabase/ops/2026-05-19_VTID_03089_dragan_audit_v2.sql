-- =============================================================================
-- VTID-03089 — Dragan audit v2 (broader search incl. vitana_id)
-- =============================================================================

-- a) Any account where display_name / email / vitana_id contains "dragan".
SELECT '─── Dragan accounts (broad) ───' AS section;
SELECT
  u.user_id,
  u.display_name,
  u.email,
  u.vitana_id,
  u.welcome_chat_sent,
  u.created_at AT TIME ZONE 'Europe/Berlin' AS created_cet,
  (SELECT tenant_id FROM public.user_tenants WHERE user_id = u.user_id AND is_primary = true LIMIT 1) AS primary_tenant
FROM public.app_users u
WHERE LOWER(COALESCE(u.display_name, '')) LIKE '%dragan%'
   OR LOWER(COALESCE(u.email, '')) LIKE '%dragan%'
   OR LOWER(COALESCE(u.vitana_id, '')) LIKE '%dragan%'
ORDER BY u.created_at;

-- b) For each Dragan account, count backfill_run='2026-05-19' messages received.
SELECT '─── Dragan inbox counts ───' AS section;
SELECT
  u.user_id,
  u.display_name,
  u.vitana_id,
  (SELECT COUNT(*) FROM public.chat_messages cm
     WHERE cm.receiver_id = u.user_id
       AND cm.metadata->>'backfill_run' = '2026-05-19'
  ) AS backfill_msgs_received,
  (SELECT COUNT(DISTINCT cm.sender_id) FROM public.chat_messages cm
     WHERE cm.receiver_id = u.user_id
       AND cm.metadata->>'backfill_run' = '2026-05-19'
  ) AS distinct_backfill_senders,
  (SELECT COUNT(*) FROM public.chat_messages cm
     WHERE cm.receiver_id = u.user_id
       AND cm.metadata->>'source' = 'welcome_chat'
  ) AS welcome_chat_total
FROM public.app_users u
WHERE LOWER(COALESCE(u.display_name, '')) LIKE '%dragan%'
   OR LOWER(COALESCE(u.email, '')) LIKE '%dragan%'
   OR LOWER(COALESCE(u.vitana_id, '')) LIKE '%dragan%';

-- c) For each Dragan, show the sender_vitana_id column values for the
--    backfill rows they received (NULL = backfill SQL didn't denormalize).
SELECT '─── Sample backfill rows for first Dragan (Dragan Alexander) ───' AS section;
SELECT cm.sender_id, cm.sender_vitana_id, cm.receiver_id, cm.receiver_vitana_id,
       cm.metadata->>'backfill_run' AS backfill_run, cm.created_at
FROM public.chat_messages cm
WHERE cm.receiver_id = '0adc6ff6-acb0-4dca-99d0-295211a40e3e'::uuid
  AND cm.metadata->>'backfill_run' = '2026-05-19'
LIMIT 5;

-- d) Sanity: chat_messages rows from the backfill where sender_vitana_id is null.
SELECT '─── Backfill rows: sender_vitana_id null vs filled ───' AS section;
SELECT
  CASE WHEN sender_vitana_id IS NULL THEN 'sender_vitana_id_null' ELSE 'sender_vitana_id_filled' END AS bucket,
  COUNT(*) AS rows
FROM public.chat_messages cm
WHERE cm.metadata->>'backfill_run' = '2026-05-19'
GROUP BY bucket;

-- e) Check if the legacy global_messages system also has these hellos
--    (in case the inbox UI lists from global_messages, not chat_messages).
SELECT '─── Legacy global_messages count for "I just joined the community" ───' AS section;
SELECT COUNT(*) AS legacy_hello_rows
FROM public.global_messages gm
WHERE gm.content LIKE '%I just joined the community%';
