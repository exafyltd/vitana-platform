-- =============================================================================
-- VTID-05099 — Vitana Companion Messages, Phase 1 (engine, SHADOW ONLY)
-- -----------------------------------------------------------------------------
-- Plan: Vitana Companion Messages (sparred 5 rounds, CONVERGED, owner approved
-- 2026-10-12; record docs/validation/VTID-05099/plan-sparring.md, plan hash
-- 494738edb276213257cff5f12207d8a1c190cd87368e791af0b1aec88d8fba63).
--
-- Vitana writes at most ONE proactive message per member per local day into
-- the member's private Vitana DM. Phase 1 decides and records only; it sends
-- nothing.
--
--   1. companion_preferences       one row per member (plan §B, sparring F1/F9).
--                                  No row = defaults: enabled, health +
--                                  community on, business OFF (owner D2).
--   2. companion_messages_ledger   one row per member per local day per mode.
--                                  The partial unique index on real sends
--                                  (mode <> 'shadow') is what enforces owner
--                                  decision D1 (max 1/day) across every
--                                  sender — the companion engine AND
--                                  proactive-match-messenger (sparring F2).
--                                  Shadow rows never block a real send.
--   3. claim_companion_message() / finish_companion_message() /
--      mark_companion_replied()    SECURITY DEFINER, service_role only.
--   4. user_proactive_touches.surface CHECK += 'messenger_companion'
--      (sparring F4) — in step with the ProactiveSurface union.
-- =============================================================================

BEGIN;

-- 1. Member preferences --------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.companion_preferences (
  user_id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id        uuid,
  enabled          boolean NOT NULL DEFAULT true,
  topic_health     boolean NOT NULL DEFAULT true,
  topic_community  boolean NOT NULL DEFAULT true,
  topic_business   boolean NOT NULL DEFAULT false,
  delivery_window  text NOT NULL DEFAULT 'morning' CHECK (delivery_window IN ('morning')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.companion_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS companion_preferences_read_own ON public.companion_preferences;
CREATE POLICY companion_preferences_read_own ON public.companion_preferences
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS companion_preferences_insert_own ON public.companion_preferences;
CREATE POLICY companion_preferences_insert_own ON public.companion_preferences
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS companion_preferences_update_own ON public.companion_preferences;
CREATE POLICY companion_preferences_update_own ON public.companion_preferences
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
REVOKE DELETE ON public.companion_preferences FROM anon, authenticated;

COMMENT ON TABLE public.companion_preferences IS
  'VTID-05099: Vitana Companion Messages settings, one row per member. No row means the defaults (enabled; health + community on; business off). Members read/write their own row.';

-- 2. Ledger -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.companion_messages_ledger (
  id                 bigserial PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id          uuid NOT NULL,
  local_date         date NOT NULL,
  mode               text NOT NULL CHECK (mode IN ('shadow','staff','live')),
  sender             text NOT NULL DEFAULT 'companion' CHECK (sender IN ('companion','proactive_match')),
  moment_key         text NOT NULL,
  card_type          text,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','shadow')),
  facts              jsonb NOT NULL DEFAULT '{}'::jsonb,
  composed_text      text,
  composed_by_model  text,
  chat_message_id    uuid,
  replied_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, local_date, mode)
);

-- D1: at most one REAL proactive Vitana DM per member per local day, whoever sends it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_companion_ledger_one_real_per_day
  ON public.companion_messages_ledger (user_id, local_date)
  WHERE mode <> 'shadow';
-- Back-off / anti-repeat read: a member's latest rows.
CREATE INDEX IF NOT EXISTS idx_companion_ledger_user_date
  ON public.companion_messages_ledger (user_id, local_date DESC);

ALTER TABLE public.companion_messages_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.companion_messages_ledger FROM anon, authenticated;

COMMENT ON TABLE public.companion_messages_ledger IS
  'VTID-05099: one Vitana companion message per member per local day per mode. Rows with mode <> shadow are real sends and are unique per member per day (owner decision D1). Service role only.';

-- 3. Claim / finish / replied -------------------------------------------------------
-- Claim the member's message slot for p_local_date. Returns
--   { ok, claimed: true,  id }        → the caller may compose/send now
--   { ok, claimed: false, reason }    → already decided or already sent today
CREATE OR REPLACE FUNCTION public.claim_companion_message(
  p_user_id     uuid,
  p_tenant_id   uuid,
  p_local_date  date,
  p_mode        text,
  p_sender      text,
  p_moment_key  text,
  p_card_type   text,
  p_facts       jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_id bigint;
BEGIN
  IF p_user_id IS NULL OR p_tenant_id IS NULL OR p_local_date IS NULL
     OR p_moment_key IS NULL OR btrim(p_moment_key) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ARGS_REQUIRED');
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('shadow','staff','live') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_MODE');
  END IF;
  IF p_sender IS NULL OR p_sender NOT IN ('companion','proactive_match') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_SENDER');
  END IF;

  BEGIN
    INSERT INTO public.companion_messages_ledger
      (user_id, tenant_id, local_date, mode, sender, moment_key, card_type, facts)
    VALUES
      (p_user_id, p_tenant_id, p_local_date, p_mode, p_sender, p_moment_key, p_card_type, coalesce(p_facts, '{}'::jsonb))
    ON CONFLICT (user_id, local_date, mode) DO NOTHING
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    -- the partial index: another sender already holds today's real slot
    v_id := NULL;
  END;

  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'claimed', true, 'id', v_id);
  END IF;
  RETURN jsonb_build_object('ok', true, 'claimed', false,
    'reason', CASE WHEN p_mode = 'shadow' THEN 'already_decided_today' ELSE 'already_sent_today' END);
END;
$fn$;

-- Record the outcome of a claimed slot (only a pending row moves).
CREATE OR REPLACE FUNCTION public.finish_companion_message(
  p_id                bigint,
  p_status            text,
  p_composed_text     text,
  p_composed_by_model text,
  p_chat_message_id   uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_id bigint;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('sent','failed','shadow') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_STATUS');
  END IF;
  UPDATE public.companion_messages_ledger
     SET status = p_status,
         composed_text = p_composed_text,
         composed_by_model = p_composed_by_model,
         chat_message_id = p_chat_message_id,
         updated_at = now()
   WHERE id = p_id AND status = 'pending'
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING');
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$fn$;

-- A member replied (text or card tap): mark their latest unreplied real send (sparring F3).
CREATE OR REPLACE FUNCTION public.mark_companion_replied(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_id bigint;
BEGIN
  UPDATE public.companion_messages_ledger
     SET replied_at = now(), updated_at = now()
   WHERE id = (
     SELECT id FROM public.companion_messages_ledger
      WHERE user_id = p_user_id AND mode <> 'shadow' AND status = 'sent' AND replied_at IS NULL
      ORDER BY local_date DESC
      LIMIT 1)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'marked', v_id IS NOT NULL);
END;
$fn$;

REVOKE ALL ON FUNCTION public.claim_companion_message(uuid, uuid, date, text, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_companion_message(uuid, uuid, date, text, text, text, text, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_companion_message(uuid, uuid, date, text, text, text, text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.finish_companion_message(bigint, text, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_companion_message(bigint, text, text, text, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_companion_message(bigint, text, text, text, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.mark_companion_replied(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_companion_replied(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_companion_replied(uuid) TO service_role;

-- 4. Presence pacer: the CHECK matches the code's surfaces ----------------------
ALTER TABLE public.user_proactive_touches
  DROP CONSTRAINT IF EXISTS user_proactive_touches_surface_check;
ALTER TABLE public.user_proactive_touches
  ADD CONSTRAINT user_proactive_touches_surface_check CHECK (surface IN (
    'welcome_banner','priority_card','autopilot_badge','morning_brief',
    'text_chat_awareness','self_awareness_preview','voice_opener',
    'did_you_know_card','voice_opener_tour','voice_opener_initiative',
    'vitana_responsibility_message','onboarding_coach','messenger_companion'
  )) NOT VALID;
ALTER TABLE public.user_proactive_touches
  VALIDATE CONSTRAINT user_proactive_touches_surface_check;

COMMIT;
