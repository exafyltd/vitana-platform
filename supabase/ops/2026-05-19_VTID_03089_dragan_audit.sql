-- =============================================================================
-- VTID-03089 — Audit why some recipients got fewer than 28 hello messages
-- =============================================================================
-- Read-only. Investigates the difference between Dragan1 (23 received) and
-- Dragan3 (28 received) by:
--   a) Listing every user with "dragan" in display_name or email.
--   b) For each such user, counting backfill messages received + listing
--      which senders' messages they DID receive vs which 28 senders sent.
--   c) Showing the full sender list (28) and recipient list (per Dragan).
--   d) Comparing the resolved gap to membership / role / is_primary flags.
-- =============================================================================

-- a) Find all Dragan accounts.
SELECT '─── Dragan accounts ───' AS section;
SELECT u.user_id, u.display_name, u.email, u.welcome_chat_sent, u.created_at AT TIME ZONE 'Europe/Berlin' AS created_cet
FROM public.app_users u
WHERE LOWER(COALESCE(u.display_name, '')) LIKE '%dragan%'
   OR LOWER(COALESCE(u.email, '')) LIKE '%dragan%'
ORDER BY u.created_at;

-- b) For each Dragan, count backfill_run='2026-05-19' messages received and
--    show their user_tenants rows so we can see is_primary + tenant_id.
SELECT '─── Per-Dragan received count + tenant memberships ───' AS section;
WITH dragans AS (
  SELECT u.user_id, u.display_name, u.email
  FROM public.app_users u
  WHERE LOWER(COALESCE(u.display_name, '')) LIKE '%dragan%'
     OR LOWER(COALESCE(u.email, '')) LIKE '%dragan%'
)
SELECT
  d.user_id,
  d.display_name,
  (
    SELECT COUNT(*) FROM public.chat_messages cm
    WHERE cm.receiver_id = d.user_id
      AND cm.metadata->>'backfill_run' = '2026-05-19'
  ) AS backfill_received,
  (
    SELECT COUNT(*) FROM public.chat_messages cm
    WHERE cm.receiver_id = d.user_id
      AND cm.metadata->>'source' = 'welcome_chat'
  ) AS welcome_chat_received_total,
  ARRAY(
    SELECT jsonb_build_object('tenant_id', ut.tenant_id, 'is_primary', ut.is_primary, 'role', ut.role)
    FROM public.user_tenants ut WHERE ut.user_id = d.user_id
  ) AS tenant_memberships
FROM dragans d
ORDER BY d.display_name;

-- c) Total sender count from the backfill (sanity check).
SELECT '─── Backfill senders ───' AS section;
SELECT
  cm.sender_id,
  u.display_name AS sender_name,
  COUNT(*) AS messages_sent_in_backfill
FROM public.chat_messages cm
LEFT JOIN public.app_users u ON u.user_id = cm.sender_id
WHERE cm.metadata->>'backfill_run' = '2026-05-19'
GROUP BY cm.sender_id, u.display_name
ORDER BY messages_sent_in_backfill DESC, u.display_name;

-- d) For each Dragan, list the 28 senders who SHOULD have sent and which
--    sender_id rows are MISSING for that Dragan.
SELECT '─── Missing senders per Dragan ───' AS section;
WITH dragans AS (
  SELECT u.user_id, u.display_name
  FROM public.app_users u
  WHERE LOWER(COALESCE(u.display_name, '')) LIKE '%dragan%'
     OR LOWER(COALESCE(u.email, '')) LIKE '%dragan%'
),
all_senders AS (
  SELECT DISTINCT cm.sender_id
  FROM public.chat_messages cm
  WHERE cm.metadata->>'backfill_run' = '2026-05-19'
)
SELECT
  d.display_name AS dragan,
  s.sender_id AS missing_sender_id,
  (SELECT display_name FROM public.app_users WHERE user_id = s.sender_id) AS missing_sender_name
FROM dragans d
CROSS JOIN all_senders s
WHERE NOT EXISTS (
  SELECT 1 FROM public.chat_messages cm
  WHERE cm.receiver_id = d.user_id
    AND cm.sender_id = s.sender_id
    AND cm.metadata->>'backfill_run' = '2026-05-19'
)
ORDER BY d.display_name, missing_sender_name;

-- e) Sanity: total members in the maxina tenant per is_primary.
SELECT '─── Tenant membership breakdown ───' AS section;
SELECT
  ut.is_primary,
  COUNT(*) AS users
FROM public.user_tenants ut
WHERE ut.tenant_id = '2e7528b8-472a-4356-88da-0280d4639cce'::uuid
  AND ut.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
GROUP BY ut.is_primary;

-- f) FIRST 100 group state.
SELECT '─── FIRST 100 group + member counts ───' AS section;
SELECT g.id, g.name, g.member_count_now, g.has_welcome
FROM (
  SELECT
    g.id,
    g.name,
    (SELECT COUNT(*) FROM public.chat_group_members WHERE group_id = g.id) AS member_count_now,
    (SELECT COUNT(*) FROM public.chat_messages cm WHERE cm.group_id = g.id AND cm.metadata->>'source' = 'vitana_group_welcome') AS has_welcome
  FROM public.chat_groups g
  WHERE g.name = '🎆 FIRST 100'
) g;
