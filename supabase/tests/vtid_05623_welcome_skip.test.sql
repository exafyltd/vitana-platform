-- VTID-05623: the welcome-chat trigger skips registered service and test accounts.
-- Run after vtid_05623_welcome_skip_fixture.sql and the welcome migration. Synthetic UUIDs only.
-- A service account and a test actor must get no welcome messages and no group enrolments.
-- A normal member must get the welcome and be enrolled.
SELECT extensions.plan(7);

-- Synthetic IDs. None of these is a real account.
INSERT INTO public.tenants (id, name) VALUES ('11111111-1111-4111-8111-111111111100', 'synthetic tenant');

INSERT INTO public.app_users (user_id, email, display_name, vitana_id) VALUES
  ('11111111-1111-4111-8111-111111111101', 'synthetic-old@example.test', 'Old Member', 'V-OLD'),
  ('11111111-1111-4111-8111-111111111102', 'synthetic-svc@example.test', 'Service', 'V-SVC'),
  ('11111111-1111-4111-8111-111111111103', 'synthetic-test@example.test', 'Test Actor', 'V-TST'),
  ('11111111-1111-4111-8111-111111111104', 'synthetic-new@example.test', 'New Member', 'V-NEW');

INSERT INTO public.service_bot_accounts (user_id, label, reason)
  VALUES ('11111111-1111-4111-8111-111111111102', 'synthetic-service', 'VTID-05623 skip test');
INSERT INTO public.notification_test_actors (user_id)
  VALUES ('11111111-1111-4111-8111-111111111103');

-- One uncapped system group, so every primary member is enrolled.
INSERT INTO public.chat_groups (id, tenant_id, name, is_system, metadata)
  VALUES ('11111111-1111-4111-8111-111111111150', '11111111-1111-4111-8111-111111111100', 'Alle Beisammen', true, '{}');

-- Existing member first. Nobody else is in the tenant yet, so this member gets no fan-out.
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary)
  VALUES ('11111111-1111-4111-8111-111111111100', '11111111-1111-4111-8111-111111111101', true);

-- Service account. The trigger fires, and the skip must stop it before any message or enrolment.
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary)
  VALUES ('11111111-1111-4111-8111-111111111100', '11111111-1111-4111-8111-111111111102', true);

SELECT extensions.ok(
  (SELECT COUNT(*) FROM public.chat_messages
    WHERE sender_id = '11111111-1111-4111-8111-111111111102'
       OR receiver_id = '11111111-1111-4111-8111-111111111102') = 0,
  'service account: 0 welcome messages sent or received');

SELECT extensions.ok(
  (SELECT COUNT(*) FROM public.chat_group_members
    WHERE user_id = '11111111-1111-4111-8111-111111111102') = 0,
  'service account: 0 group enrolments');

SELECT extensions.ok(
  (SELECT welcome_chat_sent FROM public.app_users WHERE user_id = '11111111-1111-4111-8111-111111111102') IS TRUE,
  'service account: marked welcome_chat_sent so a retry cannot re-fire');

-- Test actor. Same expectations as the service account.
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary)
  VALUES ('11111111-1111-4111-8111-111111111100', '11111111-1111-4111-8111-111111111103', true);

SELECT extensions.ok(
  (SELECT COUNT(*) FROM public.chat_messages
    WHERE sender_id = '11111111-1111-4111-8111-111111111103'
       OR receiver_id = '11111111-1111-4111-8111-111111111103') = 0,
  'test actor: 0 welcome messages sent or received');

SELECT extensions.ok(
  (SELECT COUNT(*) FROM public.chat_group_members
    WHERE user_id = '11111111-1111-4111-8111-111111111103') = 0,
  'test actor: 0 group enrolments');

-- Normal member. The welcome must go out and the member must be enrolled.
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary)
  VALUES ('11111111-1111-4111-8111-111111111100', '11111111-1111-4111-8111-111111111104', true);

SELECT extensions.ok(
  (SELECT COUNT(*) FROM public.chat_messages
    WHERE sender_id = '11111111-1111-4111-8111-111111111104'
      AND metadata->>'source' = 'welcome_chat') > 0,
  'normal member: welcome messages sent');

SELECT extensions.ok(
  (SELECT COUNT(*) FROM public.chat_group_members
    WHERE user_id = '11111111-1111-4111-8111-111111111104') = 1,
  'normal member: enrolled in the system group');
