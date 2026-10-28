-- =============================================================================
-- VTID-04892 — Vitana Onboarding Assistant, slice 1: coach engine tables
-- -----------------------------------------------------------------------------
-- Plan: docs/plans/VITANA-ONBOARDING-ASSISTANT-PLAN.md (v3, sparred, owner
-- approved 2026-10-05; record docs/validation/VTID-04892/plan-sparring.md).
--
-- Slice 1 is SHADOW ONLY: the coach decides what Vitana would do for each
-- new member and writes only these coach-owned tables. It sends nothing.
--
--   1. onboarding_coach_state      one row per cohort member (plan §4.3)
--   2. onboarding_coach_decisions  shadow decision log, one row per member per
--                                  local day (upsert — never one row per tick)
--   3. onboarding_touch_ledger     the one-touch-per-day budget (plan §4.7),
--                                  unique (user_id, local_day), status
--                                  pending|sent|failed; claimed only through
--   4. claim_onboarding_touch() /  SECURITY DEFINER, service_role only
--      finish_onboarding_touch()
--   5. user_proactive_touches.surface CHECK widened to the full presence-pacer
--      union + 'onboarding_coach' (plan §4.7, sparring N4/M1). The repo CHECK
--      listed 7 of the code's 11 surfaces, so touches on did_you_know_card,
--      voice_opener_tour, voice_opener_initiative and
--      vitana_responsibility_message were rejected and never counted. Live
--      rows checked read-only before writing this (2026-10-05): only
--      priority_card and welcome_banner exist. Added NOT VALID, then
--      VALIDATEd, so a surprising live row fails the VALIDATE loudly instead
--      of half-applying.
--
-- Members can read their own coach row; nothing is writable from a client.
-- =============================================================================

BEGIN;

-- 1. Coach state ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.onboarding_coach_state (
  user_id               uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id             uuid NOT NULL,
  joined_at             timestamptz NOT NULL,
  stage                 text NOT NULL DEFAULT 'd0'
                        CHECK (stage IN ('d0','d1','d2_3','d4_7','d8_30','d31_60','d61_90','done')),
  pilot_stage_override  text
                        CHECK (pilot_stage_override IS NULL OR pilot_stage_override IN ('d0','d1','d2_3','d4_7','d8_30','d31_60','d61_90')),
  next_action_key       text,
  last_touch_at         timestamptz,
  snoozed_until         timestamptz,
  ignored_streak        integer NOT NULL DEFAULT 0 CHECK (ignored_streak >= 0),
  opted_out_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_coach_state_tenant ON public.onboarding_coach_state (tenant_id, stage);

ALTER TABLE public.onboarding_coach_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS onboarding_coach_state_read_own ON public.onboarding_coach_state;
CREATE POLICY onboarding_coach_state_read_own ON public.onboarding_coach_state
  FOR SELECT TO authenticated USING (user_id = auth.uid());
REVOKE INSERT, UPDATE, DELETE ON public.onboarding_coach_state FROM anon, authenticated;

COMMENT ON TABLE public.onboarding_coach_state IS
  'VTID-04892: Vitana Onboarding Assistant per-member state (cohort members only). Written by the gateway coach (service role); members may read their own row.';

-- 2. Shadow decision log -------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.onboarding_coach_decisions (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL,
  local_day   date NOT NULL,
  mode        text NOT NULL CHECK (mode IN ('shadow','live')),
  stage       text NOT NULL,
  action_key  text,
  decision    text NOT NULL CHECK (decision IN ('would_touch','skip')),
  reason      text NOT NULL,
  tick_id     uuid NOT NULL,
  decided_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, local_day, mode)
);

ALTER TABLE public.onboarding_coach_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.onboarding_coach_decisions FROM anon, authenticated;

COMMENT ON TABLE public.onboarding_coach_decisions IS
  'VTID-04892: what the onboarding coach decided (or, in shadow mode, would have done) per member per local day. Service role only.';

-- 3. Touch ledger (the one-touch-per-day budget) -------------------------------
CREATE TABLE IF NOT EXISTS public.onboarding_touch_ledger (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL,
  local_day   date NOT NULL,
  action_key  text NOT NULL,
  channel     text NOT NULL CHECK (channel IN ('push','inapp','dm','post_offer','auto_post')),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts    integer NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 2),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, local_day)
);

ALTER TABLE public.onboarding_touch_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.onboarding_touch_ledger FROM anon, authenticated;

COMMENT ON TABLE public.onboarding_touch_ledger IS
  'VTID-04892: one onboarding touch per member per local day, claimed before any send via claim_onboarding_touch(). A failed send may be retried once the same day. Service role only.';

-- 4. Claim / finish -------------------------------------------------------------
-- Claim the member's one touch for p_local_day. Returns
--   { ok, claimed: true,  id, attempt }  → the caller may send now
--   { ok, claimed: false, reason }       → already touched / retry spent / pending
-- A row in status 'failed' with attempts = 1 may be claimed once more.
CREATE OR REPLACE FUNCTION public.claim_onboarding_touch(
  p_user_id    uuid,
  p_tenant_id  uuid,
  p_local_day  date,
  p_action_key text,
  p_channel    text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row public.onboarding_touch_ledger%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_tenant_id IS NULL OR p_local_day IS NULL
     OR p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ARGS_REQUIRED');
  END IF;
  IF p_channel IS NULL OR p_channel NOT IN ('push','inapp','dm','post_offer','auto_post') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_CHANNEL');
  END IF;

  INSERT INTO public.onboarding_touch_ledger (user_id, tenant_id, local_day, action_key, channel)
  VALUES (p_user_id, p_tenant_id, p_local_day, p_action_key, p_channel)
  ON CONFLICT (user_id, local_day) DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'claimed', true, 'id', v_row.id, 'attempt', 1);
  END IF;

  -- The day's slot exists: only a failed first attempt may be retried, once.
  UPDATE public.onboarding_touch_ledger
     SET status = 'pending', attempts = attempts + 1, action_key = p_action_key,
         channel = p_channel, updated_at = now()
   WHERE user_id = p_user_id AND local_day = p_local_day
     AND status = 'failed' AND attempts = 1
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'claimed', true, 'id', v_row.id, 'attempt', 2);
  END IF;

  SELECT * INTO v_row FROM public.onboarding_touch_ledger
   WHERE user_id = p_user_id AND local_day = p_local_day;
  RETURN jsonb_build_object('ok', true, 'claimed', false,
    'reason', CASE
      WHEN v_row.status = 'sent'    THEN 'already_touched_today'
      WHEN v_row.status = 'pending' THEN 'touch_in_flight'
      ELSE 'retry_spent' END);
END;
$fn$;

-- Record the outcome of a claimed touch (only a pending row moves).
CREATE OR REPLACE FUNCTION public.finish_onboarding_touch(p_id bigint, p_status text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_id bigint;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('sent','failed') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_STATUS');
  END IF;
  UPDATE public.onboarding_touch_ledger
     SET status = p_status, updated_at = now()
   WHERE id = p_id AND status = 'pending'
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING');
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$fn$;

REVOKE ALL ON FUNCTION public.claim_onboarding_touch(uuid, uuid, date, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_onboarding_touch(uuid, uuid, date, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_onboarding_touch(uuid, uuid, date, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.finish_onboarding_touch(bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_onboarding_touch(bigint, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_onboarding_touch(bigint, text) TO service_role;

COMMENT ON FUNCTION public.claim_onboarding_touch(uuid, uuid, date, text, text) IS
  'VTID-04892: claim a member''s one onboarding touch for their local day before sending; one retry after a failed send. Service role only.';
COMMENT ON FUNCTION public.finish_onboarding_touch(bigint, text) IS
  'VTID-04892: mark a claimed onboarding touch sent or failed. Service role only.';

-- 5. Presence pacer: the CHECK matches the code's surfaces ----------------------
ALTER TABLE public.user_proactive_touches
  DROP CONSTRAINT IF EXISTS user_proactive_touches_surface_check;
ALTER TABLE public.user_proactive_touches
  ADD CONSTRAINT user_proactive_touches_surface_check CHECK (surface IN (
    'welcome_banner','priority_card','autopilot_badge','morning_brief',
    'text_chat_awareness','self_awareness_preview','voice_opener',
    'did_you_know_card','voice_opener_tour','voice_opener_initiative',
    'vitana_responsibility_message','onboarding_coach'
  )) NOT VALID;
ALTER TABLE public.user_proactive_touches
  VALIDATE CONSTRAINT user_proactive_touches_surface_check;

COMMIT;
