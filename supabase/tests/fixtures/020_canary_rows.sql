-- VTID-05520: CANARY_A_<uuid> markers in representative T_A rows, and CANARY_B_<uuid> rows in T_B, so an isolation test can
-- tell whose row it saw. Tables used are replayable ones: community_groups, community_meetups, services_catalog (tenant
-- content) and health_features_daily (a health table, member-private). Idempotent: fixed ids, ON CONFLICT DO NOTHING.
-- Triggers are off for the load (session_replication_role = replica): the welcome-chat and notification fan-out triggers
-- (VTID-03990, VTID-03506) must never act on fixture rows, here or anywhere a fixture is copied to.
BEGIN;
SET LOCAL session_replication_role = replica;

INSERT INTO public.community_groups (id, tenant_id, name, topic_key, description) VALUES
  ('c0a00000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-00000000000a', 'CANARY_A_5d0f1c2e-0000-4000-8000-00000000ca01', 'mt_fixture', 'synthetic fixture row'),
  ('c0b00000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-00000000000b', 'CANARY_B_5d0f1c2e-0000-4000-8000-00000000cb01', 'mt_fixture', 'synthetic fixture row')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.community_meetups (id, tenant_id, group_id, title, starts_at, ends_at, location_text, mode) VALUES
  ('c0a00000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-00000000000a', 'c0a00000-0000-4000-8000-0000000000a1',
   'CANARY_A_5d0f1c2e-0000-4000-8000-00000000ca02', '2030-01-01T10:00:00Z', '2030-01-01T11:00:00Z', 'nowhere', 'online'),
  ('c0b00000-0000-4000-8000-0000000000b2', 'bbbbbbbb-0000-4000-8000-00000000000b', 'c0b00000-0000-4000-8000-0000000000b1',
   'CANARY_B_5d0f1c2e-0000-4000-8000-00000000cb02', '2030-01-01T10:00:00Z', '2030-01-01T11:00:00Z', 'nowhere', 'online')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.services_catalog (id, tenant_id, name, service_type) VALUES
  ('c0a00000-0000-4000-8000-0000000000a3', 'aaaaaaaa-0000-4000-8000-00000000000a', 'CANARY_A_5d0f1c2e-0000-4000-8000-00000000ca03', 'other'),
  ('c0b00000-0000-4000-8000-0000000000b3', 'bbbbbbbb-0000-4000-8000-00000000000b', 'CANARY_B_5d0f1c2e-0000-4000-8000-00000000cb03', 'other')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.health_features_daily (id, tenant_id, user_id, date, feature_key, feature_value) VALUES
  ('c0a00000-0000-4000-8000-0000000000a4', 'aaaaaaaa-0000-4000-8000-00000000000a', '0000000a-0000-4000-8000-000000000001', '2030-01-01',
   'CANARY_A_5d0f1c2e-0000-4000-8000-00000000ca04', 1),
  ('c0b00000-0000-4000-8000-0000000000b4', 'bbbbbbbb-0000-4000-8000-00000000000b', '0000000b-0000-4000-8000-000000000001', '2030-01-01',
   'CANARY_B_5d0f1c2e-0000-4000-8000-00000000cb04', 1)
ON CONFLICT (id) DO NOTHING;

COMMIT;
