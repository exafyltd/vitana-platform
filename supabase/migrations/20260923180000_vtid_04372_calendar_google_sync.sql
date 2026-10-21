-- VTID-04372 — calendar step 7b: Google Calendar two-way sync (switched off).
--
-- Push: a member's own community/personal entries are written to a dedicated
-- "Vitanaland" calendar in their Google account (created by the app, so the
-- sync never touches their other calendars). Pull: only free/busy intervals
-- from their Google primary calendar come back, shown as grey busy blocks —
-- no titles, no attendees.
--
-- OAuth tokens are NOT stored here: they already live in social_connections
-- (provider 'google'), kept fresh by the existing token refresher.
-- All three tables are service-role only: RLS on, no policies, no grants.

CREATE TABLE IF NOT EXISTS public.calendar_google_sync (
  user_id            uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  enabled            boolean NOT NULL DEFAULT false,
  google_calendar_id text,
  last_push_at       timestamptz,
  last_pull_at       timestamptz,
  last_error         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.calendar_google_sync IS
  'VTID-04372: per-user Google Calendar sync state (enabled, the app-created Vitanaland calendar id, last runs, last error). Service role only.';

-- One row per pushed entry. calendar_event_id goes NULL when the entry is
-- deleted, so the next push can delete the Google copy and then this row.
CREATE TABLE IF NOT EXISTS public.calendar_google_links (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  calendar_event_id uuid UNIQUE REFERENCES public.calendar_events (id) ON DELETE SET NULL,
  google_event_id   text NOT NULL,
  pushed_hash       text NOT NULL,
  pushed_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS calendar_google_links_user_idx ON public.calendar_google_links (user_id);

COMMENT ON TABLE public.calendar_google_links IS
  'VTID-04372: calendar entry -> Google event id in the member''s Vitanaland calendar, with a hash of what was pushed. Service role only.';

-- Busy intervals pulled from the member's Google primary calendar. Replaced
-- wholesale on every pull; no titles are ever stored.
CREATE TABLE IF NOT EXISTS public.calendar_external_busy (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  source     text NOT NULL CHECK (source IN ('google')),
  start_time timestamptz NOT NULL,
  end_time   timestamptz NOT NULL CHECK (end_time > start_time),
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS calendar_external_busy_user_time_idx
  ON public.calendar_external_busy (user_id, start_time);

COMMENT ON TABLE public.calendar_external_busy IS
  'VTID-04372: free/busy intervals from an external calendar (Google), shown as grey busy blocks. Times only. Service role only.';

ALTER TABLE public.calendar_google_sync   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_google_links  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_external_busy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.calendar_google_sync   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.calendar_google_links  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.calendar_external_busy FROM PUBLIC, anon, authenticated;
