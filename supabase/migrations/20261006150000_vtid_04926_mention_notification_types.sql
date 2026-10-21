-- VTID-04926: switch on the two new @mention notification types.
--
--   chat_mention    — a member was @mentioned in a group chat message
--                     (routes/chat-groups.ts sends it INSTEAD of
--                     new_chat_message to that member).
--   comment_mention — a member was @mentioned in a post comment (DB trigger,
--                     exafyltd/vitana-v1 migration 20261006140000_vtid_04926_mentions.sql).
--
-- Without this, the VTID-04674 guard auto-registers both as OFF the first time
-- they are sent and every mention push is silently dropped. Approved with the
-- VTID-04926 plan (owner, 2026-10-06). Idempotent; an admin who later turns a
-- type off keeps it off (ON CONFLICT DO NOTHING), except a row the guard
-- auto-registered as off before this migration ran, which is switched on.

INSERT INTO public.notification_type_controls (tenant_id, type, source_key, enabled, reason)
SELECT t.tenant_id, x.type, '', true, 'VTID-04926: @mention notifications (owner-approved plan)'
  FROM public.tenants t
 CROSS JOIN (VALUES ('chat_mention'), ('comment_mention')) AS x(type)
ON CONFLICT (tenant_id, type, source_key) DO NOTHING;

UPDATE public.notification_type_controls
   SET enabled = true,
       auto_registered = false,
       reason = 'VTID-04926: @mention notifications (owner-approved plan)',
       updated_at = now()
 WHERE type IN ('chat_mention', 'comment_mention')
   AND source_key = ''
   AND auto_registered = true
   AND enabled = false;

-- Member preference categories: a chat mention follows the member's chat
-- switch, a comment mention their posts & reactions switch.
UPDATE public.notification_categories
   SET mapped_types = mapped_types || '["chat_mention"]'::jsonb
 WHERE slug = 'direct_messages'
   AND NOT (mapped_types ? 'chat_mention');

UPDATE public.notification_categories
   SET mapped_types = mapped_types || '["comment_mention"]'::jsonb
 WHERE slug = 'posts_reactions'
   AND NOT (mapped_types ? 'comment_mention');
