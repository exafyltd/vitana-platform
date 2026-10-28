-- VTID-05057 rollback: restores the pre-migration phone matchers and removes
-- the auth.users mirror. The added columns are left in place (harmless; the
-- gateway only reads them). Apply with RUN-MIGRATION.yml only on the owner's word.
BEGIN;
DROP TRIGGER IF EXISTS on_auth_user_phone_verification ON auth.users;
DROP FUNCTION IF EXISTS public.sync_profile_phone_verification();

CREATE OR REPLACE FUNCTION public.match_existing_contacts()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.contacts
  SET contact_user_id = NEW.user_id, is_on_platform = true, updated_at = now()
  WHERE contact_phone = NEW.phone AND contact_user_id IS NULL AND NEW.phone IS NOT NULL;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_phone_verified ON public.profiles;
CREATE TRIGGER on_phone_verified AFTER UPDATE ON public.profiles FOR EACH ROW
  WHEN (OLD.phone IS DISTINCT FROM NEW.phone AND NEW.phone IS NOT NULL)
  EXECUTE FUNCTION public.match_existing_contacts();

CREATE OR REPLACE FUNCTION public.check_phone_on_platform(phone_number TEXT)
RETURNS TABLE(user_id UUID, display_name TEXT, avatar_url TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY SELECT p.user_id, p.display_name, p.avatar_url FROM public.profiles p
  WHERE p.phone = phone_number AND p.phone IS NOT NULL LIMIT 1;
END;
$$;
COMMIT;
