-- VTID-04436: push Vitanaland calendar entries into the member's Outlook and
-- iPhone (iCloud) calendars, the way VTID-04372 does for Google.
--
-- Each provider gets one "Vitanaland" calendar in the member's own account,
-- created by the push; only that calendar is ever written. Tokens and Apple
-- passwords stay where they already live (social_connections,
-- apple_account_credentials). Both tables are service-role only.

CREATE TABLE IF NOT EXISTS public.calendar_push_targets (
  user_id            uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  provider           text NOT NULL CHECK (provider IN ('microsoft','apple')),
  remote_calendar_id text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

COMMENT ON TABLE public.calendar_push_targets IS
  'VTID-04436: the Vitanaland calendar the push created in a member''s Outlook (Graph calendar id) or iCloud (CalDAV collection URL). NULL id = recreate on next sync. Service role only.';

-- One row per pushed entry. calendar_event_id goes NULL when the entry is
-- deleted, so the next push deletes the remote copy and then this row.
CREATE TABLE IF NOT EXISTS public.calendar_push_links (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  provider          text NOT NULL CHECK (provider IN ('microsoft','apple')),
  calendar_event_id uuid REFERENCES public.calendar_events (id) ON DELETE SET NULL,
  remote_id         text NOT NULL,
  pushed_hash       text NOT NULL,
  pushed_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendar_push_links_provider_event_key UNIQUE (provider, calendar_event_id)
);

CREATE INDEX IF NOT EXISTS calendar_push_links_user_idx ON public.calendar_push_links (user_id, provider);

COMMENT ON TABLE public.calendar_push_links IS
  'VTID-04436: calendar entry -> event id (Outlook) or .ics URL (iCloud) in the member''s Vitanaland calendar, with a hash of what was pushed. Service role only.';

ALTER TABLE public.calendar_push_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_push_links   ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.calendar_push_targets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.calendar_push_links   FROM PUBLIC, anon, authenticated;
