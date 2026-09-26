-- VTID-04674: admin on/off switch per notification type, enforced on every
-- route a notification can take.
--
-- Before this, no switch could stop a notification type from being sent:
-- notification_categories.is_active only decides whether members may opt out,
-- and rows written by database triggers were pushed by /push-dispatch, which
-- only checked the member's push master switch and quiet hours.
--
-- The rule, applied here and in the gateway (notification-controls-service):
--   a notification is created only if
--     1. the admin has its type switched on for the tenant, and
--     2. when an automation sent it, that automation is switched on for the type, and
--     3. the member has not switched off the category the type belongs to
--        (unless the category is one members may not switch off).
--   Push and quiet hours are then applied by the sender, as before.
--
-- A type nobody has registered yet is added here as OFF the first time
-- something tries to send it, so a new notification never reaches anyone
-- until an admin turns it on.

-- ── State ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.notification_type_controls (
  tenant_id        uuid        NOT NULL,
  type             text        NOT NULL,
  -- '' = the type itself; 'AP-0101' etc. = one automation's sends of this type
  source_key       text        NOT NULL DEFAULT '',
  enabled          boolean     NOT NULL DEFAULT false,
  auto_registered  boolean     NOT NULL DEFAULT false,
  reason           text,
  updated_by       uuid,
  updated_by_email text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, type, source_key)
);

COMMENT ON TABLE public.notification_type_controls IS
  'VTID-04674: admin on/off switch per notification type (source_key='''') and per automation sending that type (source_key=AP id). Missing row = off; rows are auto-registered as off on first send.';

CREATE TABLE IF NOT EXISTS public.notification_type_control_audit (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL,
  type          text        NOT NULL,
  source_key    text        NOT NULL DEFAULT '',
  old_enabled   boolean,
  new_enabled   boolean     NOT NULL,
  reason        text,
  actor_user_id uuid,
  actor_email   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_type_control_audit_type
  ON public.notification_type_control_audit (tenant_id, type, created_at DESC);

CREATE TABLE IF NOT EXISTS public.notification_type_blocks (
  tenant_id       uuid        NOT NULL,
  type            text        NOT NULL,
  source_key      text        NOT NULL DEFAULT '',
  block_reason    text        NOT NULL CHECK (block_reason IN ('admin_off', 'member_off')),
  day             date        NOT NULL,
  blocked_count   integer     NOT NULL DEFAULT 0,
  last_blocked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, type, source_key, block_reason, day)
);

COMMENT ON TABLE public.notification_type_blocks IS
  'VTID-04674: daily count of notifications not created because the admin switched the type off (admin_off) or the member switched its category off (member_off).';

ALTER TABLE public.notification_type_controls      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_type_control_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_type_blocks        ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notification_type_controls, public.notification_type_control_audit,
              public.notification_type_blocks FROM anon, authenticated;

-- Categories a member may not switch off (account and security notices).
ALTER TABLE public.notification_categories
  ADD COLUMN IF NOT EXISTS member_can_disable boolean NOT NULL DEFAULT true;

-- The stats and activity queries read one tenant's recent rows.
CREATE INDEX IF NOT EXISTS idx_user_notifications_tenant_time
  ON public.user_notifications (tenant_id, created_at DESC);

-- ── Decision functions ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.notification_type_allowed(
  p_tenant uuid, p_type text, p_source_key text DEFAULT ''
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_enabled boolean;
  v_source  text := COALESCE(p_source_key, '');
BEGIN
  IF p_tenant IS NULL OR p_type IS NULL OR p_type = '' THEN
    RAISE WARNING 'notification_type_allowed called without tenant/type (tenant=%, type=%) — allowed', p_tenant, p_type;
    RETURN true;
  END IF;

  SELECT enabled INTO v_enabled FROM notification_type_controls
   WHERE tenant_id = p_tenant AND type = p_type AND source_key = '';
  IF NOT FOUND THEN
    INSERT INTO notification_type_controls (tenant_id, type, source_key, enabled, auto_registered, reason)
    VALUES (p_tenant, p_type, '', false, true, 'Added as off on first send (VTID-04674)')
    ON CONFLICT DO NOTHING;
    RETURN false;
  END IF;
  IF NOT v_enabled THEN RETURN false; END IF;

  IF v_source <> '' THEN
    SELECT enabled INTO v_enabled FROM notification_type_controls
     WHERE tenant_id = p_tenant AND type = p_type AND source_key = v_source;
    IF NOT FOUND THEN
      INSERT INTO notification_type_controls (tenant_id, type, source_key, enabled, auto_registered, reason)
      VALUES (p_tenant, p_type, v_source, false, true, 'Added as off on first send (VTID-04674)')
      ON CONFLICT DO NOTHING;
      RETURN false;
    END IF;
    RETURN v_enabled;
  END IF;

  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.notification_member_allows(
  p_user uuid, p_tenant uuid, p_type text
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cat         uuid;
  v_default     boolean;
  v_can_disable boolean;
  v_pref        boolean;
BEGIN
  SELECT c.id, c.default_enabled, c.member_can_disable
    INTO v_cat, v_default, v_can_disable
    FROM notification_categories c
   WHERE c.is_active
     AND c.mapped_types ? p_type
     AND (c.tenant_id IS NULL OR c.tenant_id = p_tenant)
   ORDER BY c.tenant_id NULLS LAST
   LIMIT 1;

  IF v_cat IS NULL OR NOT v_can_disable THEN
    RETURN true;
  END IF;

  SELECT enabled INTO v_pref FROM user_category_preferences
   WHERE user_id = p_user AND category_id = v_cat;
  RETURN COALESCE(v_pref, v_default, true);
END $$;

CREATE OR REPLACE FUNCTION public.notification_record_block(
  p_tenant uuid, p_type text, p_source_key text, p_reason text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO notification_type_blocks (tenant_id, type, source_key, block_reason, day, blocked_count, last_blocked_at)
  VALUES (p_tenant, p_type, COALESCE(p_source_key, ''), p_reason, (now() AT TIME ZONE 'UTC')::date, 1, now())
  ON CONFLICT (tenant_id, type, source_key, block_reason, day)
  DO UPDATE SET blocked_count = notification_type_blocks.blocked_count + 1, last_blocked_at = now();
END $$;

-- ── The guard every row passes through ───────────────────────────────────────
-- Catches the gateway AND every database trigger that writes user_notifications
-- (new posts, likes, comments, follows, mentions, chat, reactions, …). The
-- gateway checks the same rule before it pushes, because a push-only
-- notification never writes a row.

CREATE OR REPLACE FUNCTION public._notif_enforce_type_controls()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid := NEW.tenant_id;
  v_source text := COALESCE(NEW.data->>'automation_id', '');
BEGIN
  IF v_tenant IS NULL THEN
    SELECT ut.tenant_id INTO v_tenant FROM user_tenants ut
     WHERE ut.user_id = NEW.user_id AND ut.is_primary LIMIT 1;
  END IF;
  IF v_tenant IS NULL THEN
    RAISE WARNING 'notification type control: no tenant for user % (type %) — allowed', NEW.user_id, NEW.type;
    RETURN NEW;
  END IF;

  IF NOT notification_type_allowed(v_tenant, NEW.type, v_source) THEN
    PERFORM notification_record_block(v_tenant, NEW.type, v_source, 'admin_off');
    RETURN NULL;
  END IF;

  IF NOT notification_member_allows(NEW.user_id, v_tenant, NEW.type) THEN
    PERFORM notification_record_block(v_tenant, NEW.type, '', 'member_off');
    RETURN NULL;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '_notif_enforce_type_controls failed open (type %): %', NEW.type, SQLERRM;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_enforce_notification_type_controls ON public.user_notifications;
CREATE TRIGGER trg_enforce_notification_type_controls
  BEFORE INSERT ON public.user_notifications
  FOR EACH ROW EXECUTE FUNCTION public._notif_enforce_type_controls();

-- ── Read models for the admin screen ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.notification_type_stats(p_tenant uuid, p_days integer DEFAULT 7)
RETURNS TABLE (
  type text, sent bigint, pushed bigint, read bigint,
  blocked_admin bigint, blocked_member bigint, last_sent_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH s AS (
    SELECT n.type,
           count(*)                                        AS sent,
           count(*) FILTER (WHERE n.push_sent_at IS NOT NULL
                              AND n.channel IN ('push', 'push_and_inapp')) AS pushed,
           count(*) FILTER (WHERE n.read_at IS NOT NULL)   AS read,
           max(n.created_at)                               AS last_sent_at
      FROM user_notifications n
     WHERE n.tenant_id = p_tenant
       AND n.created_at > now() - make_interval(days => GREATEST(p_days, 1))
     GROUP BY n.type
  ), b AS (
    SELECT bl.type,
           sum(bl.blocked_count) FILTER (WHERE bl.block_reason = 'admin_off')  AS blocked_admin,
           sum(bl.blocked_count) FILTER (WHERE bl.block_reason = 'member_off') AS blocked_member
      FROM notification_type_blocks bl
     WHERE bl.tenant_id = p_tenant
       AND bl.day > (now() AT TIME ZONE 'UTC')::date - GREATEST(p_days, 1)
     GROUP BY bl.type
  )
  SELECT COALESCE(s.type, b.type),
         COALESCE(s.sent, 0), COALESCE(s.pushed, 0), COALESCE(s.read, 0),
         COALESCE(b.blocked_admin, 0)::bigint, COALESCE(b.blocked_member, 0)::bigint,
         s.last_sent_at
    FROM s FULL OUTER JOIN b ON b.type = s.type;
$$;

CREATE OR REPLACE FUNCTION public.notification_daily_activity(p_tenant uuid, p_days integer DEFAULT 30)
RETURNS TABLE (
  day date, type text, sent bigint, pushed bigint, read bigint,
  blocked_admin bigint, blocked_member bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH s AS (
    SELECT (n.created_at AT TIME ZONE 'UTC')::date AS day, n.type,
           count(*) AS sent,
           count(*) FILTER (WHERE n.push_sent_at IS NOT NULL
                              AND n.channel IN ('push', 'push_and_inapp')) AS pushed,
           count(*) FILTER (WHERE n.read_at IS NOT NULL) AS read
      FROM user_notifications n
     WHERE n.tenant_id = p_tenant
       AND n.created_at > now() - make_interval(days => LEAST(GREATEST(p_days, 1), 90))
     GROUP BY 1, 2
  ), b AS (
    SELECT bl.day, bl.type,
           sum(bl.blocked_count) FILTER (WHERE bl.block_reason = 'admin_off')  AS blocked_admin,
           sum(bl.blocked_count) FILTER (WHERE bl.block_reason = 'member_off') AS blocked_member
      FROM notification_type_blocks bl
     WHERE bl.tenant_id = p_tenant
       AND bl.day > (now() AT TIME ZONE 'UTC')::date - LEAST(GREATEST(p_days, 1), 90)
     GROUP BY 1, 2
  )
  SELECT COALESCE(s.day, b.day), COALESCE(s.type, b.type),
         COALESCE(s.sent, 0), COALESCE(s.pushed, 0), COALESCE(s.read, 0),
         COALESCE(b.blocked_admin, 0)::bigint, COALESCE(b.blocked_member, 0)::bigint
    FROM s FULL OUTER JOIN b ON b.day = s.day AND b.type = s.type
   ORDER BY 1 DESC, 2;
$$;

REVOKE ALL ON FUNCTION public.notification_type_allowed(uuid, text, text)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notification_member_allows(uuid, uuid, text)         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notification_record_block(uuid, text, text, text)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notification_type_stats(uuid, integer)               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notification_daily_activity(uuid, integer)           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._notif_enforce_type_controls()                       FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notification_type_allowed(uuid, text, text)       TO service_role;
GRANT EXECUTE ON FUNCTION public.notification_member_allows(uuid, uuid, text)      TO service_role;
GRANT EXECUTE ON FUNCTION public.notification_record_block(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.notification_type_stats(uuid, integer)            TO service_role;
GRANT EXECUTE ON FUNCTION public.notification_daily_activity(uuid, integer)        TO service_role;

-- ── Starting state (owner-approved list) ─────────────────────────────────────
-- ON: the types members actually received in the 30 days before this change,
-- plus reminders the member set themselves (sent without a notification row,
-- 65 fired in those 30 days). Everything else starts OFF — including every
-- new scheduled job — and is added as off the first time it is sent.

INSERT INTO public.notification_type_controls (tenant_id, type, source_key, enabled, reason)
SELECT t.tenant_id, x.type, '', true,
       'Starting state: delivered to members in the 30 days before VTID-04674'
  FROM public.tenants t
 CROSS JOIN (VALUES
   ('community_post_published'), ('feature_announcement'), ('new_chat_message'),
   ('post_like'), ('memory_garden_grew'), ('post_comment'), ('comment_like'),
   ('new_follower'), ('comment_reply'), ('post_mention'), ('message_reaction'),
   ('admin_insight_urgent'), ('reminder_due')
 ) AS x(type)
ON CONFLICT (tenant_id, type, source_key) DO NOTHING;

-- ── Member categories for the types members actually receive ─────────────────
-- Until now no category held new posts, likes, comments, follows or the daily
-- tip, so a member could not switch any of them off. Existing choices are not
-- touched: these are new categories, on by default like every other one.

INSERT INTO public.notification_categories
  (tenant_id, type, slug, display_name, description, sort_order, is_active, default_enabled, mapped_types)
SELECT NULL, 'community', 'posts_reactions', 'Posts & reactions',
       'New posts in the community, and likes, comments, replies and mentions on yours.',
       4, true, true,
       '["community_post_published","post_like","post_comment","comment_like","comment_reply","post_mention"]'::jsonb
 WHERE NOT EXISTS (SELECT 1 FROM public.notification_categories WHERE tenant_id IS NULL AND slug = 'posts_reactions');

INSERT INTO public.notification_categories
  (tenant_id, type, slug, display_name, description, sort_order, is_active, default_enabled, mapped_types)
SELECT NULL, 'community', 'tips_updates', 'Tips & updates from Vitana',
       'The daily tip about a Vitanaland feature, and announcements.',
       5, true, true,
       '["feature_announcement"]'::jsonb
 WHERE NOT EXISTS (SELECT 1 FROM public.notification_categories WHERE tenant_id IS NULL AND slug = 'tips_updates');

UPDATE public.notification_categories
   SET mapped_types = mapped_types || '["new_follower"]'::jsonb, updated_at = now()
 WHERE tenant_id IS NULL AND slug = 'connections_social' AND NOT (mapped_types ? 'new_follower');

UPDATE public.notification_categories
   SET mapped_types = mapped_types || '["message_reaction"]'::jsonb, updated_at = now()
 WHERE tenant_id IS NULL AND slug = 'direct_messages' AND NOT (mapped_types ? 'message_reaction');
