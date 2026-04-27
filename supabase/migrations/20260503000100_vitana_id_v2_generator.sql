-- Vitana ID v2 — generator swap (VTID-01987)
-- Replaces generate_vitana_id_suggestion() to use the global vitana_id_seq
-- instead of a random 4-digit suffix. Adds a sibling allocate_vitana_id()
-- that returns BOTH the new id and the seq value atomically — used by the
-- handle_new_user trigger so we never lose track of which seq the user got.
--
-- Preserves every side-effect of the prior handle_new_user (Release A
-- migration 20260427000700): profiles, global_community_profiles, tenant
-- resolution, memberships, role_preferences, raw_app_meta_data. The mirror
-- trigger (Release A 5/9) still propagates vitana_id to app_users.

CREATE OR REPLACE FUNCTION public.generate_vitana_id_suggestion(
  p_display_name text DEFAULT NULL,
  p_full_name    text DEFAULT NULL,
  p_email        text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  raw_name  text;
  base      text;
  candidate text;
  seq       bigint;
  attempts  int := 0;
BEGIN
  raw_name := COALESCE(
    NULLIF(trim(p_display_name), ''),
    NULLIF(trim(p_full_name), ''),
    NULLIF(split_part(p_email, '@', 1), '')
  );

  IF raw_name IS NOT NULL THEN
    base := lower(public.unaccent(raw_name));
    base := regexp_replace(base, '[^a-z0-9 ]', '', 'g');
    base := split_part(trim(base), ' ', 1);
    base := regexp_replace(base, '^[0-9]+', '');
  END IF;

  IF base IS NULL OR length(base) < 2 THEN
    base := 'user';
  END IF;

  IF EXISTS (SELECT 1 FROM public.vitana_id_reserved WHERE token = base) THEN
    base := 'u' || base;
  END IF;

  -- Truncate base to 8 chars (was 6 — small bump now that the suffix is
  -- digits-only and total budget is 16).
  IF length(base) > 8 THEN
    base := substring(base from 1 for 8);
  END IF;

  -- Sequence-based suffix with parked-alias collision avoidance. The seq is
  -- global, so the only collision source is handle_aliases (legacy random
  -- IDs from the v1 era parked here). Bound at 50 attempts.
  LOOP
    attempts := attempts + 1;
    seq := nextval('public.vitana_id_seq');
    candidate := base || seq::text;

    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE vitana_id = candidate)
       AND NOT EXISTS (SELECT 1 FROM public.handle_aliases WHERE old_handle = candidate)
    THEN
      RETURN candidate;
    END IF;

    IF attempts > 50 THEN
      RAISE EXCEPTION 'vitana_id allocation failed after 50 attempts (alias collisions)';
    END IF;
  END LOOP;
END;
$$;

-- Sibling: returns vitana_id + seq atomically. Use this in the trigger so
-- we write both columns from one allocation call.
CREATE OR REPLACE FUNCTION public.allocate_vitana_id(
  p_display_name text DEFAULT NULL,
  p_full_name    text DEFAULT NULL,
  p_email        text DEFAULT NULL
) RETURNS TABLE(vitana_id text, registration_seq bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  raw_name  text;
  base      text;
  candidate text;
  seq       bigint;
  attempts  int := 0;
BEGIN
  raw_name := COALESCE(
    NULLIF(trim(p_display_name), ''),
    NULLIF(trim(p_full_name), ''),
    NULLIF(split_part(p_email, '@', 1), '')
  );

  IF raw_name IS NOT NULL THEN
    base := lower(public.unaccent(raw_name));
    base := regexp_replace(base, '[^a-z0-9 ]', '', 'g');
    base := split_part(trim(base), ' ', 1);
    base := regexp_replace(base, '^[0-9]+', '');
  END IF;

  IF base IS NULL OR length(base) < 2 THEN
    base := 'user';
  END IF;

  IF EXISTS (SELECT 1 FROM public.vitana_id_reserved WHERE token = base) THEN
    base := 'u' || base;
  END IF;

  IF length(base) > 8 THEN
    base := substring(base from 1 for 8);
  END IF;

  LOOP
    attempts := attempts + 1;
    seq := nextval('public.vitana_id_seq');
    candidate := base || seq::text;

    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE public.profiles.vitana_id = candidate)
       AND NOT EXISTS (SELECT 1 FROM public.handle_aliases WHERE old_handle = candidate)
    THEN
      vitana_id := candidate;
      registration_seq := seq;
      RETURN NEXT;
      RETURN;
    END IF;

    IF attempts > 50 THEN
      RAISE EXCEPTION 'allocate_vitana_id failed after 50 attempts (alias collisions)';
    END IF;
  END LOOP;
END;
$$;

-- handle_new_user — preserve all side-effects from 20260427000700 verbatim,
-- swap only the vitana_id allocation to capture seq.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_slug    text;
  v_tenant_id      uuid;
  v_full_name      text;
  v_display_name   text;
  v_email          text;
  v_vitana_id      text;
  v_seq            bigint;
BEGIN
  v_tenant_slug  := NEW.raw_user_meta_data ->> 'tenant_slug';
  v_full_name    := NEW.raw_user_meta_data ->> 'full_name';
  v_email        := NEW.email;
  v_display_name := COALESCE(
    NEW.raw_user_meta_data ->> 'display_name',
    v_full_name,
    split_part(v_email, '@', 1)
  );

  -- Allocate vitana_id + seq from the new helper. seq is the user's
  -- registration rank and is also written to profiles.registration_seq.
  SELECT a.vitana_id, a.registration_seq
    INTO v_vitana_id, v_seq
    FROM public.allocate_vitana_id(v_display_name, v_full_name, v_email) a;

  INSERT INTO public.profiles (
    user_id, full_name, display_name, handle, email,
    vitana_id, vitana_id_locked, registration_seq
  ) VALUES (
    NEW.id,
    v_full_name,
    v_display_name,
    v_vitana_id,
    v_email,
    v_vitana_id,
    false,
    v_seq
  );

  INSERT INTO public.global_community_profiles (user_id, display_name, is_visible)
  VALUES (NEW.id, v_display_name, true)
  ON CONFLICT (user_id) DO NOTHING;

  IF v_tenant_slug IS NOT NULL THEN
    SELECT t.tenant_id INTO v_tenant_id
      FROM public.tenants t
     WHERE t.slug = v_tenant_slug
     LIMIT 1;
  END IF;

  IF v_tenant_id IS NULL THEN
    SELECT t.tenant_id INTO v_tenant_id
      FROM public.tenants t
     ORDER BY t.created_at ASC
     LIMIT 1;
  END IF;

  IF v_tenant_id IS NOT NULL THEN
    INSERT INTO public.memberships (user_id, tenant_id, role, status)
    VALUES (NEW.id, v_tenant_id, 'community'::public.tenant_role, 'active');

    INSERT INTO public.role_preferences (user_id, tenant_id, role)
    VALUES (NEW.id, v_tenant_id, 'community');

    UPDATE auth.users
       SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
                            || jsonb_build_object('active_tenant_id', v_tenant_id)
     WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_new_user() IS
  'Provisions a new user: profile (with vitana_id + registration_seq), global community profile, tenant membership, role preference, active_tenant_id metadata. v2 swaps random suffix for global vitana_id_seq.';
