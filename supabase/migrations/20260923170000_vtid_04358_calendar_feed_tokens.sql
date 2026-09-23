-- VTID-04358 — calendar step 7a: private ICS subscription feed.
--
-- One secret feed token per user. Only its SHA-256 hash is stored, so a read
-- of this table cannot be turned into a working feed URL. The gateway (service
-- role) is the only reader/writer: RLS is on with no policies, and browser
-- roles have no grants.

CREATE TABLE IF NOT EXISTS public.calendar_feed_tokens (
  user_id      uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

COMMENT ON TABLE public.calendar_feed_tokens IS
  'VTID-04358: one private iCalendar subscription token per user, stored as a SHA-256 hash. Service role only.';

ALTER TABLE public.calendar_feed_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.calendar_feed_tokens FROM PUBLIC, anon, authenticated;
