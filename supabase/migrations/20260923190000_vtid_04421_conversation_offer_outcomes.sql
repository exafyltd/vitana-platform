-- VTID-04421 (Plan v1 WS-2.4) — one row per suggestion Vitana makes.
--
-- The WS-0.5 offer lifecycle (VTID-04355) emits conversation.offer.{made,
-- accepted,declined,ignored} to oasis_events. Counting outcomes from there
-- means scanning a table with no usable created_at index (VTID-03980), and an
-- event stream cannot say which outcome a given offer finally had. This table
-- keeps one row per offer, settled by its FIRST outcome, so WS-2.2's scoring
-- and the Command Hub outcomes view read a small indexed table instead.
--
-- Written only by the gateway (service role) from offer-outcomes.ts; RLS is on
-- with no policies, so browser roles cannot read or write it.

CREATE TABLE IF NOT EXISTS public.conversation_offer_outcomes (
  offer_id        uuid        PRIMARY KEY,
  user_id         uuid        NOT NULL,
  source          text        NOT NULL,
  provider        text        NOT NULL,
  offer_key       text,
  tool            text        NOT NULL,
  offered_at      timestamptz NOT NULL,
  outcome         text        NOT NULL DEFAULT 'made'
                  CHECK (outcome IN ('made', 'accepted', 'declined', 'ignored')),
  outcome_at      timestamptz,
  outcome_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversation_offer_outcomes_user_offered
  ON public.conversation_offer_outcomes (user_id, offered_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_offer_outcomes_provider_offered
  ON public.conversation_offer_outcomes (provider, offered_at DESC);

ALTER TABLE public.conversation_offer_outcomes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.conversation_offer_outcomes FROM anon, authenticated;

COMMENT ON TABLE public.conversation_offer_outcomes IS
  'VTID-04421: one row per offered action (pending_cta), settled by its first accepted/declined/ignored outcome. Gateway-written; an offer still "made" after its TTL was ignored.';

-- Per-provider outcome counts since a point in time. An offer still 'made'
-- longer than p_ignored_after is counted as ignored (it expired unanswered).
CREATE OR REPLACE FUNCTION public.conversation_offer_outcome_stats(
  p_since timestamptz,
  p_ignored_after interval DEFAULT interval '1 day',
  p_user_id uuid DEFAULT NULL
)
RETURNS TABLE (
  provider text,
  made bigint,
  accepted bigint,
  declined bigint,
  ignored bigint,
  open bigint
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    o.provider,
    count(*)                                                                   AS made,
    count(*) FILTER (WHERE o.outcome = 'accepted')                             AS accepted,
    count(*) FILTER (WHERE o.outcome = 'declined')                             AS declined,
    count(*) FILTER (WHERE o.outcome = 'ignored'
                        OR (o.outcome = 'made' AND o.offered_at < now() - p_ignored_after)) AS ignored,
    count(*) FILTER (WHERE o.outcome = 'made' AND o.offered_at >= now() - p_ignored_after)  AS open
  FROM public.conversation_offer_outcomes o
  WHERE o.offered_at >= p_since
    AND (p_user_id IS NULL OR o.user_id = p_user_id)
  GROUP BY o.provider
  ORDER BY count(*) DESC;
$$;

REVOKE ALL ON FUNCTION public.conversation_offer_outcome_stats(timestamptz, interval, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.conversation_offer_outcome_stats(timestamptz, interval, uuid) TO service_role;
