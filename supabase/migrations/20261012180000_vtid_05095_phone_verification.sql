-- VTID-05095: members verify their own phone number with an SMS code.
--
-- Plan: docs/validation/VTID-05095/plan-sparring.md (sparred, owner-approved).
--
-- 1. phone_verification_challenges — one open code per member (UNIQUE user_id).
--    Only the HMAC of the code is stored. Service role only (RLS on, no policy).
-- 2. phone_verification_sends — one row per SMS sent, for the per-member,
--    per-number and daily limits. Rows older than 7 days are purged by
--    phone_verification_begin itself.
-- 3. phone_verification_begin / phone_verification_confirm — the two steps as
--    single transactions under a per-member advisory lock, so two requests at
--    the same moment can neither create two codes nor slip past a limit.
--    EXECUTE for service_role only.
-- 4. unmatch_phone_contacts() + trigger on_phone_a_withdrawn on profiles:
--    when a member's number stops being matchable (removed, unverified, hidden,
--    or replaced), other members' contacts linked to it BY PHONE are unlinked.
--    Rows also linked by the member's e-mail stay linked. The trigger name
--    sorts before on_phone_verified (VTID-05057), so on a replaced number the
--    old links are cleared before the new number's links are made.
--
-- The verified number itself is written by the gateway through
-- auth.admin.updateUserById(phone, phone_confirm); VTID-05057's
-- sync_profile_phone_verification mirrors it into profiles.
--
-- Rollback: docs/validation/VTID-05095/rollback.down.sql

BEGIN;

-- ── 1. Challenges ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.phone_verification_challenges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL UNIQUE,
  phone_e164  text NOT NULL,
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.phone_verification_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.phone_verification_challenges FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.phone_verification_challenges TO service_role;
COMMENT ON TABLE public.phone_verification_challenges IS
  'VTID-05095: the one open SMS code per member (HMAC only). Service role only; written by phone_verification_begin/confirm.';

-- ── 2. Send log (limits) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.phone_verification_sends (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid NOT NULL,
  phone_e164 text NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_phone_verification_sends_user ON public.phone_verification_sends (user_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_phone_verification_sends_phone ON public.phone_verification_sends (phone_e164, sent_at);
CREATE INDEX IF NOT EXISTS idx_phone_verification_sends_sent ON public.phone_verification_sends (sent_at);
ALTER TABLE public.phone_verification_sends ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.phone_verification_sends FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.phone_verification_sends TO service_role;
COMMENT ON TABLE public.phone_verification_sends IS
  'VTID-05095: one row per verification SMS, for the per-member / per-number / daily limits. Kept 7 days.';

-- ── 3a. Begin: limits + one open challenge, atomically ───────────────────
-- Returns 'ok' or the limit that refused: 'user_hour', 'user_day',
-- 'phone_day', 'daily_cap'. The caller sends the SMS only on 'ok'.
CREATE OR REPLACE FUNCTION public.phone_verification_begin(
  p_user_id uuid,
  p_phone_e164 text,
  p_code_hash text,
  p_ttl_seconds integer,
  p_user_hour_max integer,
  p_user_day_max integer,
  p_phone_day_max integer,
  p_daily_cap integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('phone_verification:' || p_user_id::text));

  DELETE FROM public.phone_verification_sends WHERE sent_at < now() - interval '7 days';

  IF (SELECT count(*) FROM public.phone_verification_sends
       WHERE user_id = p_user_id AND sent_at > now() - interval '1 hour') >= p_user_hour_max THEN
    RETURN 'user_hour';
  END IF;
  IF (SELECT count(*) FROM public.phone_verification_sends
       WHERE user_id = p_user_id AND sent_at > now() - interval '1 day') >= p_user_day_max THEN
    RETURN 'user_day';
  END IF;
  IF (SELECT count(*) FROM public.phone_verification_sends
       WHERE phone_e164 = p_phone_e164 AND sent_at > now() - interval '1 day') >= p_phone_day_max THEN
    RETURN 'phone_day';
  END IF;
  IF (SELECT count(*) FROM public.phone_verification_sends
       WHERE sent_at >= date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc') >= p_daily_cap THEN
    RETURN 'daily_cap';
  END IF;

  INSERT INTO public.phone_verification_challenges (user_id, phone_e164, code_hash, expires_at)
  VALUES (p_user_id, p_phone_e164, p_code_hash, now() + make_interval(secs => p_ttl_seconds))
  ON CONFLICT (user_id) DO UPDATE
     SET phone_e164 = EXCLUDED.phone_e164,
         code_hash = EXCLUDED.code_hash,
         expires_at = EXCLUDED.expires_at,
         attempts = 0,
         consumed_at = NULL,
         created_at = now();

  INSERT INTO public.phone_verification_sends (user_id, phone_e164) VALUES (p_user_id, p_phone_e164);
  RETURN 'ok';
END;
$$;

-- ── 3b. Confirm: check the code, count the attempt, consume ──────────────
-- Returns (result, phone_e164). result: 'ok' (consumed; phone set),
-- 'none', 'expired', 'too_many_attempts', 'wrong'.
CREATE OR REPLACE FUNCTION public.phone_verification_confirm(
  p_user_id uuid,
  p_code_hash text,
  p_max_attempts integer
)
RETURNS TABLE(result text, phone_e164 text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ch public.phone_verification_challenges%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('phone_verification:' || p_user_id::text));

  SELECT * INTO ch FROM public.phone_verification_challenges c
   WHERE c.user_id = p_user_id AND c.consumed_at IS NULL;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'none'::text, NULL::text; RETURN;
  END IF;
  IF ch.expires_at <= now() THEN
    RETURN QUERY SELECT 'expired'::text, NULL::text; RETURN;
  END IF;
  IF ch.attempts >= p_max_attempts THEN
    RETURN QUERY SELECT 'too_many_attempts'::text, NULL::text; RETURN;
  END IF;
  IF ch.code_hash <> p_code_hash THEN
    UPDATE public.phone_verification_challenges SET attempts = attempts + 1 WHERE id = ch.id;
    RETURN QUERY SELECT
      CASE WHEN ch.attempts + 1 >= p_max_attempts THEN 'too_many_attempts' ELSE 'wrong' END::text,
      NULL::text;
    RETURN;
  END IF;
  UPDATE public.phone_verification_challenges SET consumed_at = now() WHERE id = ch.id;
  RETURN QUERY SELECT 'ok'::text, ch.phone_e164;
END;
$$;

REVOKE ALL ON FUNCTION public.phone_verification_begin(uuid, text, text, integer, integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.phone_verification_confirm(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.phone_verification_begin(uuid, text, text, integer, integer, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.phone_verification_confirm(uuid, text, integer) TO service_role;

-- ── 4. Un-match when a number stops being matchable ──────────────────────
CREATE OR REPLACE FUNCTION public.unmatch_phone_contacts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.contacts c
     SET contact_user_id = NULL, is_on_platform = false, updated_at = now()
   WHERE c.contact_user_id = OLD.user_id
     AND c.user_id <> OLD.user_id
     AND OLD.phone_e164 = ANY (c.contact_phone_e164)
     -- still linked by e-mail → keep the link
     AND NOT (c.contact_email IS NOT NULL AND OLD.email IS NOT NULL
              AND lower(c.contact_email) = lower(OLD.email));
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.unmatch_phone_contacts() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_phone_a_withdrawn ON public.profiles;
CREATE TRIGGER on_phone_a_withdrawn
  AFTER UPDATE OF phone_e164, phone_verified, discoverable_by_phone ON public.profiles
  FOR EACH ROW
  WHEN (OLD.phone_verified AND OLD.discoverable_by_phone AND OLD.phone_e164 IS NOT NULL
        AND (NOT NEW.phone_verified
             OR NOT NEW.discoverable_by_phone
             OR NEW.phone_e164 IS DISTINCT FROM OLD.phone_e164))
  EXECUTE FUNCTION public.unmatch_phone_contacts();

COMMIT;
