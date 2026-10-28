-- Fix reaction push notifications always deep-linking to the generic
-- /inbox conversation list instead of the specific conversation + message
-- that was reacted to.
--
-- notify_on_reaction() (AFTER INSERT trigger on message_reactions) hardcoded
-- data.url = '/inbox'. The /push-dispatch cron and the frontend's
-- resolveNotificationRoute() both honor data.url verbatim, so every reaction
-- notification landed on the generic inbox list regardless of which
-- conversation the reacted-to message belonged to.
--
-- This resolves the specific conversation (group / 1:1 / global thread) the
-- message belongs to and builds a path-segment deep-link
-- (/inbox/{g|u|t}/<id>/msg/<message_id>) — a path segment, not a query
-- string, because Appilix's Android in-app browser silently fails to launch
-- notification URLs containing a query string (see App.tsx routing comments).
-- The frontend (vitana-v1) reads the trailing /msg/:messageId segment to
-- scroll to and highlight the reacted-to message once the conversation loads.

CREATE OR REPLACE FUNCTION public.notify_on_reaction()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_author_id UUID;
  v_group_id UUID;
  v_receiver_id UUID;
  v_thread_id UUID;
  v_reactor_name TEXT;
  v_tenant_id UUID;
  v_body TEXT;
  v_url TEXT;
BEGIN
  -- chat_messages covers both 1:1 (receiver_id set, group_id null) and group
  -- chat (group_id set) — this is the table the "Google Review" / DM /
  -- group-chat inbox conversations write to.
  SELECT sender_id, group_id, receiver_id
    INTO v_author_id, v_group_id, v_receiver_id
    FROM chat_messages WHERE id = NEW.message_id;

  IF v_author_id IS NULL THEN
    -- global_messages: community/global chat threads.
    SELECT sender_id, thread_id INTO v_author_id, v_thread_id
      FROM global_messages WHERE id = NEW.message_id;
  END IF;

  IF v_author_id IS NULL THEN
    -- Legacy/system messages table — no known conversation deep-link mapping,
    -- falls back to the generic /inbox below.
    SELECT sender_id INTO v_author_id FROM messages WHERE id = NEW.message_id;
  END IF;

  IF v_author_id IS NULL OR v_author_id = NEW.user_id THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM user_notifications
    WHERE user_id = v_author_id
      AND type = 'message_reaction'
      AND data->>'reactor_id' = NEW.user_id::text
      AND data->>'message_id' = NEW.message_id::text
      AND created_at > NOW() - INTERVAL '5 seconds'
  ) THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(full_name, handle, 'Someone') INTO v_reactor_name
  FROM profiles WHERE user_id = NEW.user_id;

  SELECT tenant_id INTO v_tenant_id
  FROM user_tenants
  WHERE user_id = v_author_id AND is_primary = true
  LIMIT 1;

  v_body := v_reactor_name || ' reacted ' || NEW.emoji || ' to your message';

  IF v_group_id IS NOT NULL THEN
    v_url := '/inbox/g/' || v_group_id::text || '/msg/' || NEW.message_id::text;
  ELSIF v_receiver_id IS NOT NULL THEN
    -- v_author_id (the message writer, who is being notified) is always
    -- chat_messages.sender_id here; the conversation partner is receiver_id.
    v_url := '/inbox/u/' || v_receiver_id::text || '/msg/' || NEW.message_id::text;
  ELSIF v_thread_id IS NOT NULL THEN
    v_url := '/inbox/t/' || v_thread_id::text || '/msg/' || NEW.message_id::text;
  ELSE
    v_url := '/inbox';
  END IF;

  INSERT INTO user_notifications (user_id, tenant_id, type, title, body, data, channel, priority)
  VALUES (
    v_author_id,
    v_tenant_id,
    'message_reaction',
    'New Reaction',
    v_body,
    jsonb_build_object(
      'entity_id', NEW.message_id::text,
      'message_id', NEW.message_id::text,
      'reactor_id', NEW.user_id::text,
      'reactor_name', v_reactor_name,
      'emoji', NEW.emoji,
      'group_id', v_group_id::text,
      'recipient_id', v_receiver_id::text,
      'thread_id', v_thread_id::text,
      'url', v_url
    ),
    'push_and_inapp',
    'p2'
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'notify_on_reaction error: %', SQLERRM;
  RETURN NEW;
END;
$function$;
