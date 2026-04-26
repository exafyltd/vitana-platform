-- Vitana ID — Release A · 5/9
-- Mirror trigger: profiles.vitana_id -> app_users.vitana_id.
--
-- Invariant: app_users.vitana_id is updated ONLY by this trigger.
-- Application code never writes app_users.vitana_id directly. This guarantees
-- exactly one source of truth (profiles) without forcing the gateway-wide
-- refactor of replacing every app_users read with a profiles join.

CREATE OR REPLACE FUNCTION public.profiles_mirror_vitana_id_to_app_users()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- INSERT path: a new profile row was created with a vitana_id.
  IF TG_OP = 'INSERT' THEN
    IF NEW.vitana_id IS NOT NULL THEN
      UPDATE public.app_users
         SET vitana_id = NEW.vitana_id
       WHERE user_id = NEW.user_id;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE path: only react when vitana_id actually changed (or moved
  -- from NULL to a value during backfill).
  IF TG_OP = 'UPDATE' THEN
    IF NEW.vitana_id IS DISTINCT FROM OLD.vitana_id THEN
      UPDATE public.app_users
         SET vitana_id = NEW.vitana_id
       WHERE user_id = NEW.user_id;
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_vitana_id_mirror_trigger ON public.profiles;

CREATE TRIGGER profiles_vitana_id_mirror_trigger
  AFTER INSERT OR UPDATE OF vitana_id ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.profiles_mirror_vitana_id_to_app_users();

COMMENT ON FUNCTION public.profiles_mirror_vitana_id_to_app_users() IS
  'Keeps app_users.vitana_id in sync with profiles.vitana_id. Fires on INSERT and on UPDATE OF vitana_id. Never write app_users.vitana_id from app code — the trigger is the only source.';
