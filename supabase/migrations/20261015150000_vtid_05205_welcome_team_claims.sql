-- =============================================================================
-- VTID-05205 — New-member welcome: three team welcome DMs, send-once claims
-- -----------------------------------------------------------------------------
-- Plan: .kiro/specs/new-member-welcome/plan-sparring.md (sparred, owner approved
-- 2026-10-15, Gate 1). Lane team-welcome-backend, Part A.
--
-- Mariia, Jovana and Alex Blue each send a newly registered member ONE private
-- welcome DM, from the gateway welcome-team tick (never a DB trigger). This
-- migration adds only the send-once bookkeeping:
--
--   1. welcome_team_claims        one row per (member, sender). The primary key
--                                 makes a second send for the same pair
--                                 impossible, across tick retries and repeat
--                                 sign-ins. status pending|sent|failed.
--   2. claim_welcome_message()    SECURITY DEFINER, service_role only. Claims the
--                                 pair before the DM is written; a failed first
--                                 attempt may be claimed once more.
--   3. finish_welcome_message()   moves a pending claim to sent|failed and keeps
--                                 the chat_messages id of the DM.
--
-- A pending row is never re-claimed: if a tick dies between the DM insert and
-- finish, the member keeps the one DM and never gets a second (no double send
-- beats a guaranteed send — same choice as claim_onboarding_touch).
-- Nothing here sends anything, and no trigger is added. No client can read or
-- write these rows (RLS on, zero policies).
-- =============================================================================

BEGIN;

-- 1. Claims --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.welcome_team_claims (
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sender_slug      text NOT NULL CHECK (sender_slug IN ('mariia','jovana','alex')),
  tenant_id        uuid NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts         integer NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 2),
  chat_message_id  uuid,
  sent_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, sender_slug)
);

-- The tick reads "when did this member last get a welcome" (min-gap rule).
CREATE INDEX IF NOT EXISTS idx_welcome_team_claims_user_sent
  ON public.welcome_team_claims (user_id, sent_at);

ALTER TABLE public.welcome_team_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.welcome_team_claims FROM anon, authenticated;

COMMENT ON TABLE public.welcome_team_claims IS
  'VTID-05205: one row per (new member, welcome sender). Send-once guard for the three team welcome DMs (Mariia, Jovana, Alex Blue); claimed only via claim_welcome_message(). Service role only.';

-- 2. Claim ---------------------------------------------------------------------
-- Returns
--   { ok, claimed: true,  attempt }   → the caller may write the DM now
--   { ok, claimed: false, reason }    → already_sent | in_flight | retry_spent
--   { ok: false, error }              → bad arguments
CREATE OR REPLACE FUNCTION public.claim_welcome_message(
  p_user_id     uuid,
  p_tenant_id   uuid,
  p_sender_slug text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row public.welcome_team_claims%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_tenant_id IS NULL OR p_sender_slug IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ARGS_REQUIRED');
  END IF;
  IF p_sender_slug NOT IN ('mariia','jovana','alex') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_SENDER');
  END IF;

  INSERT INTO public.welcome_team_claims (user_id, sender_slug, tenant_id)
  VALUES (p_user_id, p_sender_slug, p_tenant_id)
  ON CONFLICT (user_id, sender_slug) DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'claimed', true, 'attempt', 1);
  END IF;

  -- The pair exists: only a failed first attempt may be retried, once.
  UPDATE public.welcome_team_claims
     SET status = 'pending', attempts = attempts + 1, updated_at = now()
   WHERE user_id = p_user_id AND sender_slug = p_sender_slug
     AND status = 'failed' AND attempts = 1
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'claimed', true, 'attempt', 2);
  END IF;

  SELECT * INTO v_row FROM public.welcome_team_claims
   WHERE user_id = p_user_id AND sender_slug = p_sender_slug;
  RETURN jsonb_build_object('ok', true, 'claimed', false,
    'reason', CASE
      WHEN v_row.status = 'sent'    THEN 'already_sent'
      WHEN v_row.status = 'pending' THEN 'in_flight'
      ELSE 'retry_spent' END);
END;
$fn$;

-- 3. Finish --------------------------------------------------------------------
-- Only a pending claim moves; a 'sent' row keeps the DM id and the send time.
CREATE OR REPLACE FUNCTION public.finish_welcome_message(
  p_user_id         uuid,
  p_sender_slug     text,
  p_status          text,
  p_chat_message_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_user uuid;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('sent','failed') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_STATUS');
  END IF;
  UPDATE public.welcome_team_claims
     SET status          = p_status,
         chat_message_id = CASE WHEN p_status = 'sent' THEN p_chat_message_id ELSE chat_message_id END,
         sent_at         = CASE WHEN p_status = 'sent' THEN now() ELSE sent_at END,
         updated_at      = now()
   WHERE user_id = p_user_id AND sender_slug = p_sender_slug AND status = 'pending'
  RETURNING user_id INTO v_user;
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING');
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$fn$;

REVOKE ALL ON FUNCTION public.claim_welcome_message(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_welcome_message(uuid, uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_welcome_message(uuid, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.finish_welcome_message(uuid, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_welcome_message(uuid, text, text, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_welcome_message(uuid, text, text, uuid) TO service_role;

COMMENT ON FUNCTION public.claim_welcome_message(uuid, uuid, text) IS
  'VTID-05205: claim one team welcome DM (member, sender) before writing it; one retry after a failed send; a pending claim is never re-claimed. Service role only.';
COMMENT ON FUNCTION public.finish_welcome_message(uuid, text, text, uuid) IS
  'VTID-05205: mark a claimed team welcome DM sent (with its chat_messages id) or failed. Service role only.';

COMMIT;
