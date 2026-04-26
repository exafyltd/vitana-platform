-- Vitana Intent Engine — P2-A · 8/9
-- VTID-01973
--
-- Centralised RLS-helper function for the intent engine. The route layer
-- (gateway/intents.ts, intent-matches.ts, intent-board.ts) calls
-- can_read_intent() once per request rather than re-implementing visibility
-- rules in every endpoint.
--
-- Visibility rules:
--   public         → readable by anyone in the same tenant.
--   tenant         → same as public for now (separate flag for future
--                    cross-tenant federation gating).
--   private        → owner only.
--   mutual_reveal  → owner can read; counterparty can read only after
--                    intent_matches.mutual_reveal_unlocked_at IS NOT NULL.

CREATE OR REPLACE FUNCTION public.can_read_intent(
  p_reader     uuid,
  p_intent_id  uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  src record;
  v_unlocked boolean;
BEGIN
  IF p_reader IS NULL OR p_intent_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT requester_user_id, tenant_id, visibility, status
    INTO src
    FROM public.user_intents
   WHERE intent_id = p_intent_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Owner always reads.
  IF src.requester_user_id = p_reader THEN
    RETURN true;
  END IF;

  -- private: owner only.
  IF src.visibility = 'private' THEN
    RETURN false;
  END IF;

  -- Tenant gate for non-private kinds.
  IF NOT EXISTS (
    SELECT 1 FROM public.memberships m
     WHERE m.user_id = p_reader
       AND m.tenant_id = src.tenant_id
       AND m.status = 'active'
  ) THEN
    RETURN false;
  END IF;

  -- public + tenant: readable now.
  IF src.visibility IN ('public','tenant') THEN
    RETURN true;
  END IF;

  -- mutual_reveal: only if a match between reader and this intent has unlocked.
  IF src.visibility = 'mutual_reveal' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.intent_matches im
        JOIN public.user_intents reader_intent
             ON reader_intent.intent_id IN (im.intent_a_id, im.intent_b_id)
            AND reader_intent.requester_user_id = p_reader
       WHERE p_intent_id IN (im.intent_a_id, im.intent_b_id)
         AND im.mutual_reveal_unlocked_at IS NOT NULL
    ) INTO v_unlocked;
    RETURN COALESCE(v_unlocked, false);
  END IF;

  RETURN false;
END;
$$;

COMMENT ON FUNCTION public.can_read_intent(uuid, uuid) IS
  'Centralised visibility rule. Owner always reads. private = owner only. public/tenant = same tenant. mutual_reveal = only after intent_matches.mutual_reveal_unlocked_at IS NOT NULL between reader and target.';

-- Companion helper for the matches table: when a row is partner_seek
-- pre-reveal, redact vitana_id_b in API responses.
CREATE OR REPLACE FUNCTION public.intent_match_should_redact(
  p_match_id   uuid,
  p_reader     uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  m record;
BEGIN
  SELECT im.*, ia.intent_kind AS kind_a, ia.requester_user_id AS owner_a,
         ib.intent_kind AS kind_b, ib.requester_user_id AS owner_b
    INTO m
    FROM public.intent_matches im
    JOIN public.user_intents ia ON ia.intent_id = im.intent_a_id
    LEFT JOIN public.user_intents ib ON ib.intent_id = im.intent_b_id
   WHERE im.match_id = p_match_id;

  IF NOT FOUND THEN
    RETURN true; -- conservative
  END IF;

  -- Only mutual_reveal-bound kinds redact.
  IF m.kind_a NOT IN ('partner_seek') AND COALESCE(m.kind_b, '') NOT IN ('partner_seek') THEN
    RETURN false;
  END IF;

  -- Already revealed: no redaction.
  IF m.mutual_reveal_unlocked_at IS NOT NULL THEN
    RETURN false;
  END IF;

  -- Owners see their own side regardless.
  IF p_reader = m.owner_a OR p_reader = m.owner_b THEN
    RETURN true;  -- they see the row but the OTHER side's vitana_id is hidden
  END IF;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.intent_match_should_redact(uuid, uuid) IS
  'For partner_seek matches pre-reveal, route layer calls this and nullifies vitana_id_b (and vitana_id_a for the b-side viewer) in the response payload. Mutual-reveal protocol enforcement.';
