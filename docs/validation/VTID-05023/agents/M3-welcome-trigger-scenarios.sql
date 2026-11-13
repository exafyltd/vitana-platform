-- Scratch scenarios for MR !28 welcome trigger. Local throwaway cluster only.
-- Each scenario uses its own tenant. Output: per-scenario counts.
\set ON_ERROR_STOP 1

-- Fixed ids
-- service bot (registered in service_bot_accounts)
\set SVC  '887b34cb-9ee9-47dc-ad53-db5be1869846'
-- test account from DATABASE_SCHEMA.md (notification_test_actors seed)
\set TEST 'a27552a3-0257-4305-8ed0-351a80fd3701'

-- ===== Scenario A: service bot skipped =====
INSERT INTO app_users (user_id, display_name, vitana_id) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'RealA1', 'V-A1'),
  (:'SVC', 'SvcBot', 'V-SVC');
INSERT INTO service_bot_accounts (user_id, label, reason) VALUES (:'SVC', 'claude-code-agent', 'scratch');
INSERT INTO chat_groups (id, tenant_id, is_system, metadata) VALUES
  ('a0000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-0000000000aa', true, '{}');
INSERT INTO user_tenants VALUES ('a0000000-0000-0000-0000-0000000000aa', 'aaaaaaaa-0000-0000-0000-000000000001', true);
INSERT INTO user_tenants VALUES ('a0000000-0000-0000-0000-0000000000aa', :'SVC', true);

-- ===== Scenario B: test account skipped (registered) =====
INSERT INTO app_users (user_id, display_name, vitana_id) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001', 'RealB1', 'V-B1'),
  (:'TEST', 'E2E', 'V-TEST');
INSERT INTO notification_test_actors (user_id, reason) VALUES (:'TEST', 'seed');
INSERT INTO chat_groups (id, tenant_id, is_system, metadata) VALUES
  ('b0000000-0000-0000-0000-00000000000b', 'b0000000-0000-0000-0000-0000000000bb', true, '{}');
INSERT INTO user_tenants VALUES ('b0000000-0000-0000-0000-0000000000bb', 'bbbbbbbb-0000-0000-0000-000000000001', true);
INSERT INTO user_tenants VALUES ('b0000000-0000-0000-0000-0000000000bb', :'TEST', true);

-- ===== Scenario C: test account NOT registered (control for dependency on the row) =====
INSERT INTO app_users (user_id, display_name, vitana_id) VALUES
  ('cccccccc-0000-0000-0000-000000000001', 'RealC1', 'V-C1');
INSERT INTO app_users (user_id, display_name, vitana_id) VALUES
  ('c0000000-0000-0000-0000-00000000000c', 'UnregTest', 'V-UC');
INSERT INTO chat_groups (id, tenant_id, is_system, metadata) VALUES
  ('c0000000-0000-0000-0000-00000000000d', 'c0000000-0000-0000-0000-0000000000cc', true, '{}');
INSERT INTO user_tenants VALUES ('c0000000-0000-0000-0000-0000000000cc', 'cccccccc-0000-0000-0000-000000000001', true);
INSERT INTO user_tenants VALUES ('c0000000-0000-0000-0000-0000000000cc', 'c0000000-0000-0000-0000-00000000000c', true);

-- ===== Scenario D: real member control (must still get welcome + enrolment) =====
INSERT INTO app_users (user_id, display_name, vitana_id) VALUES
  ('dddddddd-0000-0000-0000-000000000001', 'RealD1', 'V-D1');
INSERT INTO chat_groups (id, tenant_id, is_system, metadata) VALUES
  ('d0000000-0000-0000-0000-00000000000e', 'd0000000-0000-0000-0000-0000000000dd', true, '{}');
INSERT INTO user_tenants VALUES ('d0000000-0000-0000-0000-0000000000dd', 'dddddddd-0000-0000-0000-000000000001', true);
INSERT INTO app_users (user_id, display_name, vitana_id) VALUES
  ('dddddddd-0000-0000-0000-000000000002', 'RealD2', 'V-D2');
INSERT INTO user_tenants VALUES ('d0000000-0000-0000-0000-0000000000dd', 'dddddddd-0000-0000-0000-000000000002', true);

-- ===== Results =====
\echo '--- results: messages sent BY each account, group rows, welcome flag'
SELECT 'A service bot' AS case, sender_id::text AS account,
       (SELECT count(*) FROM chat_messages m WHERE m.sender_id = :'SVC') AS msgs_sent,
       (SELECT count(*) FROM chat_group_members g WHERE g.user_id = :'SVC') AS group_rows,
       (SELECT welcome_chat_sent FROM app_users WHERE user_id = :'SVC') AS welcome_flag
  FROM (SELECT :'SVC'::uuid AS sender_id) x
UNION ALL
SELECT 'B test acct (registered)', :'TEST',
       (SELECT count(*) FROM chat_messages m WHERE m.sender_id = :'TEST'),
       (SELECT count(*) FROM chat_group_members g WHERE g.user_id = :'TEST'),
       (SELECT welcome_chat_sent FROM app_users WHERE user_id = :'TEST')
UNION ALL
SELECT 'C test acct (unregistered)', 'c0000000-0000-0000-0000-00000000000c',
       (SELECT count(*) FROM chat_messages m WHERE m.sender_id = 'c0000000-0000-0000-0000-00000000000c'),
       (SELECT count(*) FROM chat_group_members g WHERE g.user_id = 'c0000000-0000-0000-0000-00000000000c'),
       (SELECT welcome_chat_sent FROM app_users WHERE user_id = 'c0000000-0000-0000-0000-00000000000c')
UNION ALL
SELECT 'D real member (2nd joiner)', 'dddddddd-0000-0000-0000-000000000002',
       (SELECT count(*) FROM chat_messages m WHERE m.sender_id = 'dddddddd-0000-0000-0000-000000000002'),
       (SELECT count(*) FROM chat_group_members g WHERE g.user_id = 'dddddddd-0000-0000-0000-000000000002'),
       (SELECT welcome_chat_sent FROM app_users WHERE user_id = 'dddddddd-0000-0000-0000-000000000002');
