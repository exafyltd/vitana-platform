-- VTID-05579 fixture, part 2: rows. Loaded AFTER the real 20261102050000 and 20261102051000 (so the rule-45 guard on
-- global_community_profiles is live, as it is in production) and BEFORE the lane migrations, so the legacy network groups
-- exist when chat_groups.scope is added (the backfill must classify them).
-- Ids are 05579000-0000-4000-8000-0000000000NN (NN = member number) / ...00aN tenants / ...00bN groups.
--   U1  TA primary (also in the platform tenant)   U2  TA                U3  TB primary (also in the platform tenant)
--   U4  TA primary and TB                          U5  service bot       U6  notification test actor
--   U7  platform-only account                      U8  TB, request from U1 still pending   U9  TA, NOT network_visible
--   U10 only the platform tenant                   U11 TA, request declined   U12 TA, no request at all
--   U13 TB, U1 blocks U13   U14 TB, U14 blocks U1  U15 TA, connected to U2 only
--   U20..U40 TB, connected to U1 (cap fill)        U60..U80 TA (members of the big community group)
INSERT INTO public.tenants (tenant_id, slug, is_platform) VALUES
  ('05579000-0000-4000-8000-0000000000a1', 'ta', false),
  ('05579000-0000-4000-8000-0000000000a2', 'tb', false),
  ('05579000-0000-4000-8000-0000000000a3', 'platform', true);
INSERT INTO auth.users (id, email)
  SELECT ('05579000-0000-4000-8000-00000000' || lpad(g::text, 4, '0'))::uuid, 'u' || g || '@example.test'
    FROM generate_series(1, 80) g;
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary) VALUES
  ('05579000-0000-4000-8000-0000000000a1', '05579000-0000-4000-8000-000000000001', true),
  ('05579000-0000-4000-8000-0000000000a3', '05579000-0000-4000-8000-000000000001', false),
  ('05579000-0000-4000-8000-0000000000a1', '05579000-0000-4000-8000-000000000002', true),
  ('05579000-0000-4000-8000-0000000000a2', '05579000-0000-4000-8000-000000000003', true),
  ('05579000-0000-4000-8000-0000000000a3', '05579000-0000-4000-8000-000000000003', false),
  ('05579000-0000-4000-8000-0000000000a1', '05579000-0000-4000-8000-000000000004', true),
  ('05579000-0000-4000-8000-0000000000a2', '05579000-0000-4000-8000-000000000004', false),
  ('05579000-0000-4000-8000-0000000000a3', '05579000-0000-4000-8000-000000000010', true);
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary)
  SELECT '05579000-0000-4000-8000-0000000000a1', ('05579000-0000-4000-8000-00000000' || lpad(g::text, 4, '0'))::uuid, true
    FROM unnest(ARRAY[5, 6, 7, 9, 11, 12, 15]) g;
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary)
  SELECT '05579000-0000-4000-8000-0000000000a2', ('05579000-0000-4000-8000-00000000' || lpad(g::text, 4, '0'))::uuid, true
    FROM unnest(ARRAY[8, 13, 14]) g;
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary)
  SELECT '05579000-0000-4000-8000-0000000000a2', ('05579000-0000-4000-8000-00000000' || lpad(g::text, 4, '0'))::uuid, true
    FROM generate_series(20, 40) g;
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary)
  SELECT '05579000-0000-4000-8000-0000000000a1', ('05579000-0000-4000-8000-00000000' || lpad(g::text, 4, '0'))::uuid, true
    FROM generate_series(60, 80) g;
INSERT INTO public.service_bot_accounts (user_id) VALUES ('05579000-0000-4000-8000-000000000005');
INSERT INTO public.notification_test_actors (user_id) VALUES ('05579000-0000-4000-8000-000000000006');
INSERT INTO public.platform_only_accounts (user_id) VALUES ('05579000-0000-4000-8000-000000000007');

-- Profiles: everyone is in the directory; the network opt-in is set below (the rule-45 guard flips a listed account back to false).
INSERT INTO public.global_community_profiles (user_id, display_name)
  SELECT ('05579000-0000-4000-8000-00000000' || lpad(g::text, 4, '0'))::uuid, 'User ' || g FROM generate_series(1, 80) g;
UPDATE public.global_community_profiles SET network_visible = true
 WHERE right(user_id::text, 4)::int <> 9 AND right(user_id::text, 4)::int NOT BETWEEN 60 AND 80;

-- Connections. U1<->U2, U3->U1 (the other direction), U1<->U4 accepted; U1->U8 pending; U1->U11 declined; U1 has no request with U12.
-- U1<->U9 (not network_visible), U1<->U5/U6/U7 (rule 43-45 accounts), U1<->U13 and U1<->U14 (blocked) are accepted.
-- U2<->U15 accepted; U1<->U20..U40 accepted.
INSERT INTO public.connection_requests (from_user_id, to_user_id, status)
  SELECT ('05579000-0000-4000-8000-00000000' || lpad(a::text, 4, '0'))::uuid, ('05579000-0000-4000-8000-00000000' || lpad(b::text, 4, '0'))::uuid, s
    FROM (VALUES (1, 2, 'accepted'), (3, 1, 'accepted'), (1, 4, 'accepted'), (1, 8, 'pending'), (1, 11, 'declined'),
                 (1, 9, 'accepted'), (1, 5, 'accepted'), (1, 6, 'accepted'), (1, 7, 'accepted'), (1, 13, 'accepted'),
                 (14, 1, 'accepted'), (2, 15, 'accepted')) v(a, b, s);
INSERT INTO public.connection_requests (from_user_id, to_user_id, status)
  SELECT '05579000-0000-4000-8000-000000000001'::uuid, ('05579000-0000-4000-8000-00000000' || lpad(g::text, 4, '0'))::uuid, 'accepted'
    FROM generate_series(20, 40) g;
INSERT INTO public.user_blocklist (tenant_id, user_id, blocked_user_id, expires_at) VALUES
  ('05579000-0000-4000-8000-0000000000a1', '05579000-0000-4000-8000-000000000001', '05579000-0000-4000-8000-000000000013', now() + interval '1 day'),
  ('05579000-0000-4000-8000-0000000000a2', '05579000-0000-4000-8000-000000000014', '05579000-0000-4000-8000-000000000001', now() + interval '1 day');

-- Groups that exist BEFORE the lane (they must be classified by the backfill).
--   b1 legacy cross-tenant thread (VTID-05573 wrote metadata.legacy_scope = network): U1 admin, U3 member
--   b2 legacy tenant thread (metadata.legacy_scope = community):                       U1 admin, U2 member
--   b3 a system group ("FIRST 100" style) with a bot member:                           U1, U5 (bot)
--   b4 an ordinary TA group:                                                           U1 admin, U2 member
--   b5 a big TA community group with 22 members (the 20 cap is a Network rule only):   U1 admin, U60..U80 members
INSERT INTO public.chat_groups (id, tenant_id, name, created_by, is_system, metadata) VALUES
  ('05579000-0000-4000-8000-0000000000b1', '05579000-0000-4000-8000-0000000000a1', 'legacy network', '05579000-0000-4000-8000-000000000001', false,
     '{"legacy_source":"global_message_threads","legacy_scope":"network"}'),
  ('05579000-0000-4000-8000-0000000000b2', '05579000-0000-4000-8000-0000000000a1', 'legacy community', '05579000-0000-4000-8000-000000000001', false,
     '{"legacy_source":"message_threads","legacy_scope":"community"}'),
  ('05579000-0000-4000-8000-0000000000b3', '05579000-0000-4000-8000-0000000000a1', 'FIRST 100', NULL, true, '{}'),
  ('05579000-0000-4000-8000-0000000000b4', '05579000-0000-4000-8000-0000000000a1', 'TA group', '05579000-0000-4000-8000-000000000001', false, '{}'),
  ('05579000-0000-4000-8000-0000000000b5', '05579000-0000-4000-8000-0000000000a1', 'TA big group', '05579000-0000-4000-8000-000000000001', false, '{}');
INSERT INTO public.chat_group_members (group_id, user_id, tenant_id, role) VALUES
  ('05579000-0000-4000-8000-0000000000b1', '05579000-0000-4000-8000-000000000001', '05579000-0000-4000-8000-0000000000a1', 'admin'),
  ('05579000-0000-4000-8000-0000000000b1', '05579000-0000-4000-8000-000000000003', '05579000-0000-4000-8000-0000000000a1', 'member'),
  ('05579000-0000-4000-8000-0000000000b2', '05579000-0000-4000-8000-000000000001', '05579000-0000-4000-8000-0000000000a1', 'admin'),
  ('05579000-0000-4000-8000-0000000000b2', '05579000-0000-4000-8000-000000000002', '05579000-0000-4000-8000-0000000000a1', 'member'),
  ('05579000-0000-4000-8000-0000000000b3', '05579000-0000-4000-8000-000000000001', '05579000-0000-4000-8000-0000000000a1', 'member'),
  ('05579000-0000-4000-8000-0000000000b3', '05579000-0000-4000-8000-000000000005', '05579000-0000-4000-8000-0000000000a1', 'bot'),
  ('05579000-0000-4000-8000-0000000000b4', '05579000-0000-4000-8000-000000000001', '05579000-0000-4000-8000-0000000000a1', 'admin'),
  ('05579000-0000-4000-8000-0000000000b4', '05579000-0000-4000-8000-000000000002', '05579000-0000-4000-8000-0000000000a1', 'member'),
  ('05579000-0000-4000-8000-0000000000b5', '05579000-0000-4000-8000-000000000001', '05579000-0000-4000-8000-0000000000a1', 'admin');
INSERT INTO public.chat_group_members (group_id, user_id, tenant_id, role)
  SELECT '05579000-0000-4000-8000-0000000000b5', ('05579000-0000-4000-8000-00000000' || lpad(g::text, 4, '0'))::uuid,
         '05579000-0000-4000-8000-0000000000a1', 'member' FROM generate_series(60, 80) g;
