-- =============================================================================
-- VTID-03089 — Idempotent fan-out of the Vitana group welcome notification
-- =============================================================================
-- The "🎆 FIRST 100" welcome message was seeded via direct SQL, which
-- bypassed the gateway notification fanout. This INSERT writes one
-- user_notifications row per group member (except the bot/sender) so the
-- bell icon shows the entry point. Re-runs are safe: NOT EXISTS filters
-- on data.idempotency_key.
--
-- Idempotency key shape:  group_welcome:<welcome_message_id>:<user_id>
--
-- Note: this only writes the in-app notification row. FCM push delivery
-- requires the gateway's notifyUserAsync; the new admin endpoint
-- POST /api/v1/chat/groups/:id/refanout-welcome can be invoked with an
-- exafy_admin JWT to additionally trigger the FCM push.
-- =============================================================================

BEGIN;

WITH welcome AS (
  SELECT cm.id AS msg_id, cm.group_id, cm.sender_id, cm.content
  FROM public.chat_messages cm
  JOIN public.chat_groups g ON g.id = cm.group_id
  WHERE g.name = '🎆 FIRST 100'
    AND cm.metadata->>'source' = 'vitana_group_welcome'
  ORDER BY cm.created_at ASC
  LIMIT 1
),
targets AS (
  SELECT
    m.user_id,
    m.tenant_id,
    w.msg_id,
    w.group_id,
    w.sender_id,
    w.content
  FROM welcome w
  JOIN public.chat_group_members m ON m.group_id = w.group_id
  WHERE m.user_id <> w.sender_id
    AND m.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
)
INSERT INTO public.user_notifications (user_id, tenant_id, type, title, body, data)
SELECT
  t.user_id,
  t.tenant_id,
  'new_chat_message',
  '🎆 FIRST 100',
  'Vitana: ' || CASE
    WHEN LENGTH(t.content) > 90 THEN SUBSTRING(t.content, 1, 87) || '...'
    ELSE t.content
  END,
  jsonb_build_object(
    'type', 'new_group_message',
    'group_id', t.group_id,
    'sender_id', t.sender_id,
    'sender_name', 'Vitana',
    'message_id', t.msg_id,
    'idempotency_key', 'group_welcome:' || t.msg_id || ':' || t.user_id,
    'url', '/inbox/g/' || t.group_id
  )
FROM targets t
WHERE NOT EXISTS (
  SELECT 1 FROM public.user_notifications un
  WHERE un.user_id = t.user_id
    AND un.data->>'idempotency_key' = 'group_welcome:' || t.msg_id || ':' || t.user_id
);

COMMIT;

-- Tally for the workflow log.
SELECT
  (SELECT COUNT(*) FROM public.chat_group_members m
     JOIN public.chat_groups g ON g.id = m.group_id
    WHERE g.name = '🎆 FIRST 100'
      AND m.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
  ) AS group_members_eligible,
  (SELECT COUNT(*) FROM public.user_notifications un
    WHERE un.data->>'idempotency_key' LIKE 'group_welcome:%'
  ) AS welcome_notifications_total;
