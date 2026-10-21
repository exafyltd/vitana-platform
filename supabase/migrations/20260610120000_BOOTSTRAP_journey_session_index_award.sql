-- =============================================================================
-- Guided Journey — Vitana Index award for listening to a session
-- BOOTSTRAP-GUIDED-JOURNEY-POPUP
-- -----------------------------------------------------------------------------
-- When a user listens to a Guided Journey session (taps a topic → Vitana
-- narrates → the Topic Explanation popup appears), they earn +2 Vitana Index
-- points. This table is the IDEMPOTENT ledger of those awards: the (user_id,
-- topic_id) primary key guarantees a given session awards at most once, no
-- matter how many times it's replayed.
--
-- The bonus is summed and applied as an ADDITIVE overlay on the user-facing
-- Vitana Index read (gateway `fetchVitanaIndexSnapshot`) — it is NOT written
-- into `vitana_index_scores`, so the stored daily health history stays a clean
-- record of health signals while the headline Index the user sees/hears
-- reflects their engagement. Recompute-safe by construction (nothing to
-- overwrite) and trivially reversible (drop this table).
--
-- SECURITY: gateway service-role only. RLS enabled with NO permissive policy,
-- matching the platform's anon-exposure lockdown posture.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.journey_session_index_awards (
  user_id    uuid NOT NULL,
  topic_id   text NOT NULL,
  points     integer NOT NULL DEFAULT 2 CHECK (points >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, topic_id)
);

CREATE INDEX IF NOT EXISTS idx_journey_session_index_awards_user
  ON public.journey_session_index_awards (user_id);

ALTER TABLE public.journey_session_index_awards ENABLE ROW LEVEL SECURITY;
-- No permissive policy: only the gateway service-role may read/write.

COMMENT ON TABLE public.journey_session_index_awards IS
  'BOOTSTRAP-GUIDED-JOURNEY-POPUP — idempotent ledger of Vitana Index points (2 per distinct topic) earned by listening to a Guided Journey session. Summed and applied as an additive overlay on the user-facing Vitana Index read; never written into vitana_index_scores.';

COMMIT;
