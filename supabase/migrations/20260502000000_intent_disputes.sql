-- Vitana Intent Engine — P2-C · 1/2
-- VTID-01976
--
-- Dispute flow + monetization-hook columns + archival helper RPC.
--
-- Dispute table is keyed off intent_matches; either party of a match can
-- raise a dispute, admin tooling resolves. Both parties' vitana_ids are
-- denormalised so support engineers can read by speakable ID.
--
-- Monetization columns are nullable + gated by application logic — no
-- behavior change at this release. They reserve the schema for the
-- future success-fee + escrow + lead-boost flows.

-- ─── Disputes ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.intent_disputes (
  dispute_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id          uuid NOT NULL REFERENCES public.intent_matches(match_id) ON DELETE CASCADE,
  raised_by         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  raised_by_vitana_id text,                    -- denorm via trigger
  -- Counterparty captured at dispute time (snapshot, in case the match row
  -- gets archived later).
  counterparty_vitana_id text,
  reason_category   text NOT NULL CHECK (reason_category IN (
    'no_show',
    'misrepresented',
    'safety',
    'payment',
    'other'
  )),
  reason_detail     text NOT NULL CHECK (length(reason_detail) BETWEEN 10 AND 2000),
  status            text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','investigating','resolved','dismissed','withdrawn')),
  resolution        text,
  resolution_actor_user_id uuid,
  resolution_actor_vitana_id text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz
);

COMMENT ON TABLE public.intent_disputes IS
  'Dispute records for intent_matches. Either party can raise; admin resolves. vitana_ids denormalised so support reads by speakable ID. Plan: i-want-a-solution-streamed-patterson.md (Part 2 / P2-C).';

CREATE INDEX IF NOT EXISTS intent_disputes_match_idx
  ON public.intent_disputes (match_id, created_at DESC);

CREATE INDEX IF NOT EXISTS intent_disputes_status_idx
  ON public.intent_disputes (status, created_at DESC)
  WHERE status IN ('open','investigating');

CREATE INDEX IF NOT EXISTS intent_disputes_raised_by_vid_idx
  ON public.intent_disputes (raised_by_vitana_id, created_at DESC)
  WHERE raised_by_vitana_id IS NOT NULL;

-- vitana_id denorm trigger.
CREATE OR REPLACE FUNCTION public.intent_disputes_set_vitana_ids()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  match_row record;
  raised_vid text;
  counter_vid text;
BEGIN
  IF NEW.raised_by_vitana_id IS NULL AND NEW.raised_by IS NOT NULL THEN
    SELECT vitana_id INTO raised_vid FROM public.profiles WHERE user_id = NEW.raised_by LIMIT 1;
    NEW.raised_by_vitana_id := raised_vid;
  END IF;

  IF NEW.counterparty_vitana_id IS NULL AND NEW.match_id IS NOT NULL THEN
    SELECT * INTO match_row FROM public.intent_matches WHERE match_id = NEW.match_id;
    IF FOUND THEN
      counter_vid := CASE
        WHEN match_row.vitana_id_a = raised_vid THEN match_row.vitana_id_b
        ELSE match_row.vitana_id_a
      END;
      NEW.counterparty_vitana_id := counter_vid;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS intent_disputes_set_vitana_ids_bi ON public.intent_disputes;
CREATE TRIGGER intent_disputes_set_vitana_ids_bi
  BEFORE INSERT ON public.intent_disputes
  FOR EACH ROW
  EXECUTE FUNCTION public.intent_disputes_set_vitana_ids();

-- updated_at trigger (mirrors user_intents pattern).
CREATE OR REPLACE FUNCTION public.intent_disputes_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS intent_disputes_set_updated_at_bu ON public.intent_disputes;
CREATE TRIGGER intent_disputes_set_updated_at_bu
  BEFORE UPDATE ON public.intent_disputes
  FOR EACH ROW
  EXECUTE FUNCTION public.intent_disputes_set_updated_at();

-- RLS: raiser can read their own disputes; admin via service role.
ALTER TABLE public.intent_disputes ENABLE ROW LEVEL SECURITY;

CREATE POLICY intent_disputes_raiser_read ON public.intent_disputes
  FOR SELECT
  USING (auth.uid() = raised_by);

-- ─── Monetization-hook columns on intent_matches ──────────────

ALTER TABLE public.intent_matches
  ADD COLUMN IF NOT EXISTS fee_basis_points int,                 -- e.g. 800 = 8%
  ADD COLUMN IF NOT EXISTS fee_currency text DEFAULT 'EUR',
  ADD COLUMN IF NOT EXISTS fee_collected_at timestamptz,
  ADD COLUMN IF NOT EXISTS fee_payment_id text;                  -- external payment system ref

COMMENT ON COLUMN public.intent_matches.fee_basis_points IS
  'Reserved for monetization (P2-C+). NULL means no fee captured. Application logic gated until KPI baselines confirm healthy conversion.';

-- ─── Archival RPC ──────────────────────────────────────────────

-- Moves matches in terminal states older than the lookback window from
-- intent_matches to intent_matches_archive. Idempotent — works in batches.
-- Called by gateway worker on a schedule (P2-C).

CREATE OR REPLACE FUNCTION public.archive_old_intent_matches(
  p_older_than_days int DEFAULT 90,
  p_batch_size int DEFAULT 500
) RETURNS TABLE (archived int, remaining bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_archived int := 0;
  v_remaining bigint;
  v_cutoff timestamptz;
BEGIN
  v_cutoff := now() - (p_older_than_days || ' days')::interval;

  WITH targets AS (
    SELECT match_id
      FROM public.intent_matches
     WHERE state IN ('closed','fulfilled','declined')
       AND created_at < v_cutoff
     ORDER BY created_at ASC
     LIMIT p_batch_size
  ),
  moved AS (
    INSERT INTO public.intent_matches_archive (
      match_id, intent_a_id, intent_b_id, vitana_id_a, vitana_id_b,
      external_target_kind, external_target_id, kind_pairing,
      score, match_reasons, compass_aligned,
      surfaced_to_a_at, surfaced_to_b_at, mutual_reveal_unlocked_at,
      state, created_at, updated_at
    )
    SELECT
      im.match_id, im.intent_a_id, im.intent_b_id, im.vitana_id_a, im.vitana_id_b,
      im.external_target_kind, im.external_target_id, im.kind_pairing,
      im.score, im.match_reasons, im.compass_aligned,
      im.surfaced_to_a_at, im.surfaced_to_b_at, im.mutual_reveal_unlocked_at,
      im.state, im.created_at, im.updated_at
    FROM public.intent_matches im
    JOIN targets t ON t.match_id = im.match_id
    ON CONFLICT (match_id) DO NOTHING
    RETURNING match_id
  ),
  deleted AS (
    DELETE FROM public.intent_matches
    WHERE match_id IN (SELECT match_id FROM moved)
    RETURNING match_id
  )
  SELECT count(*)::int INTO v_archived FROM deleted;

  SELECT count(*) INTO v_remaining
    FROM public.intent_matches
   WHERE state IN ('closed','fulfilled','declined')
     AND created_at < v_cutoff;

  RETURN QUERY SELECT v_archived, v_remaining;
END;
$$;

COMMENT ON FUNCTION public.archive_old_intent_matches(int, int) IS
  'Moves terminal-state matches >N days old to intent_matches_archive. Batched + idempotent. Gateway worker calls on a daily schedule.';
