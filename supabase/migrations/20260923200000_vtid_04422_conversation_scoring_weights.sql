-- VTID-04422 (Plan v1 WS-2.2) — weights for the shadow relevance score.
--
-- The continuation candidates are scored by a transparent weighted formula
-- (services/gateway/src/services/conversation/candidate-scoring.ts). Its
-- weights live here so they can be changed without a deploy: add a row with a
-- higher version and active = true (and set the old one inactive). The gateway
-- reads the highest active version, cached for 5 minutes, and falls back to the
-- identical built-in defaults when the table cannot be read.
--
-- Shadow mode: the score is recorded next to the live ranking and never
-- changes what Vitana says.

CREATE TABLE IF NOT EXISTS public.conversation_scoring_weights (
  version          integer     PRIMARY KEY,
  active           boolean     NOT NULL DEFAULT false,
  -- feature → weight (>= 0): urgency, freshness, screen, time_of_day, outcome, profile
  weights          jsonb       NOT NULL,
  -- candidate kind → { morning|afternoon|evening|night: fit in [0,1] }; missing = neutral 0.5
  time_of_day_fit  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  note             text,
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.conversation_scoring_weights ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.conversation_scoring_weights FROM anon, authenticated;

COMMENT ON TABLE public.conversation_scoring_weights IS
  'VTID-04422: versioned weights for the shadow relevance score of continuation candidates. Highest active version wins. Gateway-read only.';

INSERT INTO public.conversation_scoring_weights (version, active, weights, time_of_day_fit, note, created_by)
VALUES (
  1,
  true,
  '{"urgency":0.4,"freshness":0.25,"screen":0.1,"time_of_day":0.05,"outcome":0.2,"profile":0}'::jsonb,
  '{}'::jsonb,
  'Initial shadow weights: provider priority stays the largest signal; freshness and past outcomes can reorder; profile reserved for WS-4.1.',
  'VTID-04422'
)
ON CONFLICT (version) DO NOTHING;
