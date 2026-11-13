-- VTID-05023 fixture for scenario (c): both tables already exist with the same
-- definition (stands in for the production tables), and hold one row each.
-- The baseline migration runs after this file and must be a no-op.
CREATE TABLE public.notification_test_actors (
  user_id    UUID PRIMARY KEY,
  reason     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.notification_test_actors ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.service_bot_accounts (
  user_id    UUID PRIMARY KEY,
  label      TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.service_bot_accounts ENABLE ROW LEVEL SECURITY;

INSERT INTO public.notification_test_actors (user_id, reason)
VALUES ('05023000-0000-4000-8000-0000000000b1', 'fixture row for pre-existing table check');
INSERT INTO public.service_bot_accounts (user_id, label, reason)
VALUES ('05023000-0000-4000-8000-0000000000a1', 'vtid-05023-fixture', 'fixture row for pre-existing table check');

SELECT set_config('vtid_05023.expected_rows', '1', false);
SELECT set_config('vtid_05023.expected_label', 'vtid-05023-fixture', false);
SELECT set_config('vtid_05023.expected_fixture_present', '1', false);
SELECT set_config('vtid_05023.expected_nta_rows', '1', false);
