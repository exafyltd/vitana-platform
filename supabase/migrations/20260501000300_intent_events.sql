-- Vitana Intent Engine — P2-A · 4/9
-- VTID-01973
--
-- Append-only audit timeline for the intent engine. Mirrors the Part 1
-- pattern: every state transition writes here AND fans out to oasis_events
-- via the application layer (oasis-event-service.ts already auto-tags
-- vitana_id from the actor in Release B).
--
-- Support engineers replay an entire intent's lifecycle by querying
--   SELECT * FROM intent_events WHERE intent_id = $1 ORDER BY created_at;
-- or, more naturally, by speakable ID:
--   SELECT * FROM intent_events WHERE actor_vitana_id = '@alex3700' ORDER BY created_at;

CREATE TABLE IF NOT EXISTS public.intent_events (
  event_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id         uuid REFERENCES public.user_intents(intent_id) ON DELETE CASCADE,
  match_id          uuid REFERENCES public.intent_matches(match_id) ON DELETE CASCADE,
  actor_user_id     uuid,
  actor_vitana_id   text,
  event_type        text NOT NULL,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CHECK (intent_id IS NOT NULL OR match_id IS NOT NULL)
);

COMMENT ON TABLE public.intent_events IS
  'Append-only audit log for the intent engine. Every state transition emits a row. event_type covers the full lifecycle: intent.created/updated/closed, match.created/viewed/responded/mutual_interest/engaged/fulfilled/closed/declined, mutual_reveal.unlocked, proactive_prompt.fired/accepted/declined, compass_alignment.boosted/missed, content_filter.blocked, throttled.';

CREATE INDEX IF NOT EXISTS intent_events_intent_idx
  ON public.intent_events (intent_id, created_at DESC)
  WHERE intent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS intent_events_match_idx
  ON public.intent_events (match_id, created_at DESC)
  WHERE match_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS intent_events_actor_idx
  ON public.intent_events (actor_vitana_id, created_at DESC)
  WHERE actor_vitana_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS intent_events_type_idx
  ON public.intent_events (event_type, created_at DESC);

-- RLS: append-only, owners can read their own events. Service role for writes.
ALTER TABLE public.intent_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY intent_events_actor_read ON public.intent_events
  FOR SELECT
  USING (auth.uid() = actor_user_id);

CREATE POLICY intent_events_owner_read ON public.intent_events
  FOR SELECT
  USING (
    intent_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.user_intents ui
       WHERE ui.intent_id = intent_events.intent_id
         AND ui.requester_user_id = auth.uid()
    )
  );
