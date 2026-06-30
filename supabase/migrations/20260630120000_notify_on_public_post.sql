-- ============================================================================
-- Community publish notifications (push + in-app, 'community' category)
--
-- When a user PUBLISHES content to the community — a public text/image post
-- (profile_posts) or an approved public video (media_uploads) — every other
-- active member of the author's tenant gets notified, to drive early
-- engagement. Recipients = all primary members of the author's tenant except
-- the author. Channel 'push_and_inapp', priority 'p2', category 'community'.
--
-- profile_posts / media_uploads are written directly from the frontend and the
-- ORB voice tool (NOT through a gateway HTTP endpoint), so a DB trigger is the
-- only reliable server-side hook — mirroring the existing pattern in
-- 20260225200000_notification_db_triggers.sql (SECURITY DEFINER + EXCEPTION
-- guard so a fan-out failure never blocks the underlying write).
--
-- i18n: triggers can't call the gateway tt() catalog, so each row stores the
-- catalog KEYS in data (i18n_title_key / i18n_body_key / i18n_params) plus a
-- German default in title/body (safe fallback). The /push-dispatch cron
-- localizes push per-recipient via tt(); NotificationsPanel localizes the
-- in-app row via t() — both keyed off data.i18n_*.
--
-- Push delivery: rows are inserted with push_sent_at = NULL and
-- channel = 'push_and_inapp', so the existing /push-dispatch cron (every 30s)
-- picks them up and sends FCM/Appilix, honoring user_notification_preferences.
-- ============================================================================

-- Partial index for the per-tenant fan-out lookup (is_primary members).
CREATE INDEX IF NOT EXISTS idx_user_tenants_tenant_primary
  ON public.user_tenants (tenant_id) WHERE is_primary = true;

-- ── 1. Public profile post → notify the author's community ──────────────────

CREATE OR REPLACE FUNCTION notify_community_on_public_post()
RETURNS TRIGGER AS $$
DECLARE
  v_tenant UUID;
  v_name   TEXT;
BEGIN
  -- Resolve the author's primary tenant (scopes the fan-out + isolation).
  SELECT ut.tenant_id INTO v_tenant
    FROM public.user_tenants ut
   WHERE ut.user_id = NEW.user_id AND ut.is_primary = true
   LIMIT 1;
  IF v_tenant IS NULL THEN
    RETURN NEW;  -- author has no resolvable tenant → nothing to fan out to
  END IF;

  -- Author display name for the body (best-effort; generic German fallback).
  SELECT COALESCE(NULLIF(TRIM(au.display_name), ''), 'Jemand')
    INTO v_name
    FROM public.app_users au
   WHERE au.user_id = NEW.user_id;
  v_name := COALESCE(v_name, 'Jemand');

  -- One in-app row per other active member of the tenant.
  INSERT INTO public.user_notifications
    (user_id, tenant_id, type, title, body, data, channel, priority)
  SELECT
    ut.user_id,
    v_tenant,
    'community_post_published',
    'Neuer Beitrag',                                   -- DE default (fallback)
    v_name || ' hat einen neuen Beitrag geteilt.',
    jsonb_build_object(
      'entity_id',      NEW.id::text,
      'post_id',        NEW.id::text,
      'author_id',      NEW.user_id::text,
      'author_name',    v_name,
      'url',            '/home?post=' || NEW.id::text,
      'i18n_title_key', 'notif.community_post_published.title',
      'i18n_body_key',  'notif.community_post_published.body',
      'i18n_params',    jsonb_build_object('name', v_name)
    ),
    'push_and_inapp',
    'p2'
  FROM public.user_tenants ut
  WHERE ut.tenant_id = v_tenant
    AND ut.is_primary = true
    AND ut.user_id <> NEW.user_id;                      -- exclude the author

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'notify_community_on_public_post error: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'profile_posts'
  ) THEN
    DROP TRIGGER IF EXISTS trg_notify_public_post ON public.profile_posts;
    CREATE TRIGGER trg_notify_public_post
      AFTER INSERT ON public.profile_posts
      FOR EACH ROW
      WHEN (NEW.is_public = true)
      EXECUTE FUNCTION notify_community_on_public_post();
  END IF;
END $$;

-- ── 2. Public approved video → notify the author's community ────────────────
-- Videos become feed-eligible at status='approved' AND is_public=true AND
-- media_type='video', which typically happens via an UPDATE (moderation). Fire
-- on the transition into 'approved' and avoid re-notifying on later updates.

CREATE OR REPLACE FUNCTION notify_community_on_public_video()
RETURNS TRIGGER AS $$
DECLARE
  v_tenant UUID;
  v_name   TEXT;
BEGIN
  SELECT ut.tenant_id INTO v_tenant
    FROM public.user_tenants ut
   WHERE ut.user_id = NEW.user_id AND ut.is_primary = true
   LIMIT 1;
  IF v_tenant IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(TRIM(au.display_name), ''), 'Jemand')
    INTO v_name
    FROM public.app_users au
   WHERE au.user_id = NEW.user_id;
  v_name := COALESCE(v_name, 'Jemand');

  INSERT INTO public.user_notifications
    (user_id, tenant_id, type, title, body, data, channel, priority)
  SELECT
    ut.user_id,
    v_tenant,
    'community_video_published',
    'Neues Video',                                     -- DE default (fallback)
    v_name || ' hat ein neues Video geteilt.',
    jsonb_build_object(
      'entity_id',      NEW.id::text,
      'media_id',       NEW.id::text,
      'author_id',      NEW.user_id::text,
      'author_name',    v_name,
      'url',            '/home',
      'i18n_title_key', 'notif.community_video_published.title',
      'i18n_body_key',  'notif.community_video_published.body',
      'i18n_params',    jsonb_build_object('name', v_name)
    ),
    'push_and_inapp',
    'p2'
  FROM public.user_tenants ut
  WHERE ut.tenant_id = v_tenant
    AND ut.is_primary = true
    AND ut.user_id <> NEW.user_id;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'notify_community_on_public_video error: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'media_uploads'
  ) THEN
    DROP TRIGGER IF EXISTS trg_notify_public_video ON public.media_uploads;
    CREATE TRIGGER trg_notify_public_video
      AFTER INSERT OR UPDATE ON public.media_uploads
      FOR EACH ROW
      WHEN (
        NEW.status = 'approved'
        AND NEW.is_public = true
        AND NEW.media_type = 'video'
        AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'approved')
      )
      EXECUTE FUNCTION notify_community_on_public_video();
  END IF;
END $$;
