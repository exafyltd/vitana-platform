-- VTID-05023 fixture for scenario (b): runs after the baseline is applied once,
-- before it is applied again. Inserts one allowlist row that the second apply must not touch.
INSERT INTO public.service_bot_accounts (user_id, label, reason)
VALUES ('05023000-0000-4000-8000-0000000000a1', 'vtid-05023-fixture', 'fixture row for baseline re-apply check');

SELECT set_config('vtid_05023.expected_rows', '1', false);
SELECT set_config('vtid_05023.expected_label', 'vtid-05023-fixture', false);
SELECT set_config('vtid_05023.expected_fixture_present', '1', false);
