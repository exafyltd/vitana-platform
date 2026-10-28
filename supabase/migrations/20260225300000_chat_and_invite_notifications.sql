-- ============================================================================
-- Chat Message Notifications + Group Invitations
--
-- 1. Trigger on `messages` → notify recipient(s) of new chat message
-- 2. Trigger on `global_messages` → notify thread participants
-- 3. New `community_group_invitations` table
-- 4. Trigger on `community_group_invitations` → notify invited user
-- ============================================================================

-- ── 1. Tenant Chat Messages ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION notify_on_tenant_message()
RETURNS TRIGGER AS $$
DECLARE
  v_sender_name TEXT;
  v_thread_name TEXT;
  v_body_preview TEXT;
  v_last_msg TIMESTAMPTZ;
  v_recipient RECORD;
BEGIN
  -- Anti-spam: skip if sender sent a message in this thread < 30s ago
  IF NEW.thread_id IS NOT NULL THEN
    SELECT MAX(created_at) INTO v_last_msg
    FROM messages
    WHERE thread_id = NEW.thread_id
      AND sender_id = NEW.sender_id
      AND id != NEW.id;
    IF v_last_msg IS NOT NULL AND (NEW.created_at - v_last_msg) < interval '30 seconds' THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Look up sender display name
  SELECT COALESCE(full_name, handle, 'Someone') INTO v_sender_name
  FROM profiles WHERE id = NEW.sender_id;

  -- Truncate body for notification preview
  v_body_preview := LEFT(COALESCE(NEW.body, ''), 100);

  -- Direct message path (recipient_id is set)
  IF NEW.recipient_id IS NOT NULL AND NEW.recipient_id != NEW.sender_id THEN
    INSERT INTO user_notifications (user_id, tenant_id, type, title, body, data, channel, priority)
    VALUES (
      NEW.recipient_id,
      NEW.tenant_id,
      'new_chat_message',
      'New Message',
      v_sender_name || ': ' || v_body_preview,
      jsonb_build_object(
        'entity_id', COALESCE(NEW.thread_id, NEW.id)::text,
        'sender_id', NEW.sender_id::text,
        'thread_id', COALESCE(NEW.thread_id, '')::text,
        'url', '/messages'
      ),
      'push_and_inapp',
      'p1'
    );
    RETURN NEW;
  END IF;

  -- Thread/group message path
  IF NEW.thread_id IS NOT NULL THEN
    -- Get thread name
    SELECT name INTO v_thread_name
    FROM message_threads WHERE id = NEW.thread_id;

    -- Notify all active participants except sender
    FOR v_recipient IN
      SELECT tp.user_id
      FROM thread_participants tp
      WHERE tp.thread_id = NEW.thread_id
        AND tp.is_active = true
        AND tp.user_id != NEW.sender_id
    LOOP
      INSERT INTO user_notifications (user_id, tenant_id, type, title, body, data, channel, priority)
      VALUES (
        v_recipient.user_id,
        NEW.tenant_id,
        'new_chat_message',
        CASE WHEN v_thread_name IS NOT NULL
          THEN 'New Message in ' || LEFT(v_thread_name, 40)
          ELSE 'New Message'
        END,
        v_sender_name || ': ' || v_body_preview,
        jsonb_build_object(
          'entity_id', NEW.thread_id::text,
          'sender_id', NEW.sender_id::text,
          'thread_id', NEW.thread_id::text,
          'url', '/messages'
        ),
        'push_and_inapp',
        'p1'
      );
    END LOOP;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'notify_on_tenant_message error: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'messages') THEN
    DROP TRIGGER IF EXISTS trg_notify_tenant_message ON messages;
    CREATE TRIGGER trg_notify_tenant_message
      AFTER INSERT ON messages
      FOR EACH ROW
      WHEN (NEW.message_type = 'text' OR NEW.message_type = 'image' OR NEW.message_type = 'file')
      EXECUTE FUNCTION notify_on_tenant_message();
  END IF;
END $$;

-- ── 2. Global Chat Messages ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION notify_on_global_message()
RETURNS TRIGGER AS $$
DECLARE
  v_sender_name TEXT;
  v_thread_name TEXT;
  v_body_preview TEXT;
  v_last_msg TIMESTAMPTZ;
  v_recipient RECORD;
  v_tenant_id UUID;
BEGIN
  -- Anti-spam: skip if sender sent a message in this thread < 30s ago
  SELECT MAX(created_at) INTO v_last_msg
  FROM global_messages
  WHERE thread_id = NEW.thread_id
    AND sender_id = NEW.sender_id
    AND id != NEW.id;
  IF v_last_msg IS NOT NULL AND (NEW.created_at - v_last_msg) < interval '30 seconds' THEN
    RETURN NEW;
  END IF;

  -- Look up sender display name (try profiles first, then global_community_profiles)
  SELECT COALESCE(p.full_name, p.handle, gcp.display_name, 'Someone') INTO v_sender_name
  FROM profiles p
  LEFT JOIN global_community_profiles gcp ON gcp.user_id = p.id
  WHERE p.id = NEW.sender_id;

  -- Truncate body
  v_body_preview := LEFT(COALESCE(NEW.body, ''), 100);

  -- Get thread name
  SELECT name INTO v_thread_name
  FROM global_message_threads WHERE id = NEW.thread_id;

  -- Notify all active participants except sender
  FOR v_recipient IN
    SELECT gtp.user_id
    FROM global_thread_participants gtp
    WHERE gtp.thread_id = NEW.thread_id
      AND gtp.is_active = true
      AND gtp.user_id != NEW.sender_id
  LOOP
    -- Look up tenant_id for the recipient (primary tenant)
    SELECT tenant_id INTO v_tenant_id
    FROM user_tenants
    WHERE user_id = v_recipient.user_id AND is_primary = true
    LIMIT 1;

    IF v_tenant_id IS NOT NULL THEN
      INSERT INTO user_notifications (user_id, tenant_id, type, title, body, data, channel, priority)
      VALUES (
        v_recipient.user_id,
        v_tenant_id,
        'new_chat_message',
        CASE WHEN v_thread_name IS NOT NULL
          THEN 'New Message in ' || LEFT(v_thread_name, 40)
          ELSE 'New Message'
        END,
        v_sender_name || ': ' || v_body_preview,
        jsonb_build_object(
          'entity_id', NEW.thread_id::text,
          'sender_id', NEW.sender_id::text,
          'thread_id', NEW.thread_id::text,
          'url', '/messages'
        ),
        'push_and_inapp',
        'p1'
      );
    END IF;
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'notify_on_global_message error: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'global_messages') THEN
    DROP TRIGGER IF EXISTS trg_notify_global_message ON global_messages;
    CREATE TRIGGER trg_notify_global_message
      AFTER INSERT ON global_messages
      FOR EACH ROW
      WHEN (NEW.message_type = 'text' OR NEW.message_type = 'image' OR NEW.message_type = 'file')
      EXECUTE FUNCTION notify_on_global_message();
  END IF;
END $$;

-- ── 3. Community Group Invitations Table ────────────────────────────────────

CREATE TABLE IF NOT EXISTS community_group_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  group_id UUID NOT NULL,
  invited_by UUID NOT NULL,
  invited_user_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ
);

-- Prevent duplicate pending invites for same user+group
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_pending_invite
  ON community_group_invitations (tenant_id, group_id, invited_user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_invitations_invited_user
  ON community_group_invitations (invited_user_id, status);

CREATE INDEX IF NOT EXISTS idx_invitations_group
  ON community_group_invitations (group_id, status);

ALTER TABLE community_group_invitations ENABLE ROW LEVEL SECURITY;

-- Users can see invitations they sent or received
CREATE POLICY "users_see_own_invitations"
  ON community_group_invitations FOR SELECT
  USING (auth.uid() = invited_by OR auth.uid() = invited_user_id);

-- Users can insert invitations (as the inviter)
CREATE POLICY "users_send_invitations"
  ON community_group_invitations FOR INSERT
  WITH CHECK (auth.uid() = invited_by);

-- Users can update invitations they received (accept/decline)
CREATE POLICY "users_respond_to_invitations"
  ON community_group_invitations FOR UPDATE
  USING (auth.uid() = invited_user_id);

-- Service role can manage all
CREATE POLICY "service_role_manage_invitations"
  ON community_group_invitations FOR ALL
  USING (true) WITH CHECK (true);

-- ── 4. Group Invitation Notification Trigger ────────────────────────────────

CREATE OR REPLACE FUNCTION notify_on_group_invitation()
RETURNS TRIGGER AS $$
DECLARE
  v_inviter_name TEXT;
  v_group_name TEXT;
BEGIN
  -- Look up inviter name
  SELECT COALESCE(full_name, handle, 'Someone') INTO v_inviter_name
  FROM profiles WHERE id = NEW.invited_by;

  -- Look up group name
  SELECT name INTO v_group_name
  FROM community_groups WHERE id = NEW.group_id;

  INSERT INTO user_notifications (user_id, tenant_id, type, title, body, data, channel, priority)
  VALUES (
    NEW.invited_user_id,
    NEW.tenant_id,
    'group_invitation_received',
    'Group Invitation',
    v_inviter_name || ' invited you to join ' || COALESCE(v_group_name, 'a group'),
    jsonb_build_object(
      'entity_id', NEW.id::text,
      'group_id', NEW.group_id::text,
      'invitation_id', NEW.id::text,
      'invited_by', NEW.invited_by::text,
      'url', '/community'
    ),
    'push_and_inapp',
    'p1'
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'notify_on_group_invitation error: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_notify_group_invitation ON community_group_invitations;
CREATE TRIGGER trg_notify_group_invitation
  AFTER INSERT ON community_group_invitations
  FOR EACH ROW
  WHEN (NEW.status = 'pending')
  EXECUTE FUNCTION notify_on_group_invitation();
