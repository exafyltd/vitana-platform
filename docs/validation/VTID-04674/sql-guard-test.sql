-- VTID-04674: exercises the migration's guard against a minimal schema.
-- Run: psql -v ON_ERROR_STOP=1 -f <this file> against a throwaway database
-- that already has the migration applied on top of the stubs below.
\set ON_ERROR_STOP 1
\echo '--- setup ---'
INSERT INTO tenants (tenant_id, name) VALUES ('11111111-1111-1111-1111-111111111111','T1');
INSERT INTO user_tenants (user_id, tenant_id, is_primary) VALUES
 ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111', true),
 ('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111', true);
INSERT INTO notification_categories (id, tenant_id, type, slug, display_name, is_active, default_enabled, mapped_types, member_can_disable) VALUES
 ('cccccccc-0000-0000-0000-000000000002', NULL, 'community', 'account', 'Account', true, true, '["welcome_to_vitana"]', false);
-- re-run the seed now that a tenant exists (the migration seeded zero tenants)
INSERT INTO notification_type_controls (tenant_id, type, source_key, enabled, reason)
SELECT t.tenant_id, x.type, '', true, 'seed' FROM tenants t
CROSS JOIN (VALUES ('new_chat_message'),('community_post_published')) x(type) ON CONFLICT DO NOTHING;

\echo '--- 1. seeded type, no member opt-out: row created ---'
INSERT INTO user_notifications (user_id, tenant_id, type, title, body) VALUES
 ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','new_chat_message','t','b');
SELECT CASE WHEN count(*)=1 THEN 'PASS' ELSE 'FAIL' END AS t1 FROM user_notifications WHERE type='new_chat_message';

\echo '--- 2. unknown type: blocked, auto-registered OFF, counted ---'
INSERT INTO user_notifications (user_id, tenant_id, type, title, body) VALUES
 ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','new_daily_matches','t','b');
SELECT CASE WHEN (SELECT count(*) FROM user_notifications WHERE type='new_daily_matches')=0
        AND (SELECT enabled=false AND auto_registered FROM notification_type_controls WHERE type='new_daily_matches' AND source_key='')
        AND (SELECT blocked_count FROM notification_type_blocks WHERE type='new_daily_matches' AND block_reason='admin_off')=1
       THEN 'PASS' ELSE 'FAIL' END AS t2;

\echo '--- 3. admin switches a live type OFF: blocked ---'
UPDATE notification_type_controls SET enabled=false WHERE type='community_post_published';
INSERT INTO user_notifications (user_id, tenant_id, type, title, body) VALUES
 ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','community_post_published','t','b');
SELECT CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END AS t3 FROM user_notifications WHERE type='community_post_published';

\echo '--- 4. member switched the category off: blocked as member_off ---'
INSERT INTO user_category_preferences (user_id, tenant_id, category_id, enabled) VALUES
 ('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','cccccccc-0000-0000-0000-000000000001', false);
INSERT INTO user_notifications (user_id, tenant_id, type, title, body) VALUES
 ('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','new_chat_message','t','b');
SELECT CASE WHEN (SELECT count(*) FROM user_notifications WHERE type='new_chat_message' AND user_id='aaaaaaaa-0000-0000-0000-000000000002')=0
        AND (SELECT blocked_count FROM notification_type_blocks WHERE type='new_chat_message' AND block_reason='member_off')=1
       THEN 'PASS' ELSE 'FAIL' END AS t4;

\echo '--- 5. category members may not switch off: delivered even with an opt-out row ---'
INSERT INTO notification_type_controls (tenant_id,type,source_key,enabled) VALUES ('11111111-1111-1111-1111-111111111111','welcome_to_vitana','',true);
INSERT INTO user_category_preferences (user_id, tenant_id, category_id, enabled) VALUES
 ('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','cccccccc-0000-0000-0000-000000000002', false);
INSERT INTO user_notifications (user_id, tenant_id, type, title, body) VALUES
 ('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','welcome_to_vitana','t','b');
SELECT CASE WHEN count(*)=1 THEN 'PASS' ELSE 'FAIL' END AS t5 FROM user_notifications WHERE type='welcome_to_vitana';

\echo '--- 6. automation source: type on, automation not yet switched on → blocked; on → delivered ---'
INSERT INTO notification_type_controls (tenant_id,type,source_key,enabled) VALUES ('11111111-1111-1111-1111-111111111111','orb_proactive_message','',true);
INSERT INTO user_notifications (user_id, tenant_id, type, title, body, data) VALUES
 ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','orb_proactive_message','t','b','{"automation_id":"AP-0210"}');
SELECT CASE WHEN (SELECT count(*) FROM user_notifications WHERE type='orb_proactive_message')=0
        AND (SELECT enabled=false AND auto_registered FROM notification_type_controls WHERE type='orb_proactive_message' AND source_key='AP-0210')
       THEN 'PASS' ELSE 'FAIL' END AS t6a;
UPDATE notification_type_controls SET enabled=true WHERE type='orb_proactive_message' AND source_key='AP-0210';
INSERT INTO user_notifications (user_id, tenant_id, type, title, body, data) VALUES
 ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','orb_proactive_message','t','b','{"automation_id":"AP-0210"}');
SELECT CASE WHEN count(*)=1 THEN 'PASS' ELSE 'FAIL' END AS t6b FROM user_notifications WHERE type='orb_proactive_message';

\echo '--- 7. row without tenant resolves the primary tenant ---'
INSERT INTO user_notifications (user_id, tenant_id, type, title, body) VALUES
 ('aaaaaaaa-0000-0000-0000-000000000001', NULL,'new_daily_matches','t','b');
SELECT CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END AS t7 FROM user_notifications WHERE type='new_daily_matches';

\echo '--- 8. stats read model ---'
SELECT type, sent, blocked_admin, blocked_member FROM notification_type_stats('11111111-1111-1111-1111-111111111111', 7) ORDER BY type;
SELECT count(*) AS activity_rows FROM notification_daily_activity('11111111-1111-1111-1111-111111111111', 30);

\echo '--- 9. member categories: two added, two extended, no duplicates after a second run ---'
SELECT CASE WHEN
      (SELECT count(*) FROM notification_categories WHERE slug='posts_reactions') = 1
  AND (SELECT count(*) FROM notification_categories WHERE slug='tips_updates') = 1
  AND (SELECT mapped_types ? 'community_post_published' AND mapped_types ? 'post_like' FROM notification_categories WHERE slug='posts_reactions')
  AND (SELECT mapped_types ? 'feature_announcement' FROM notification_categories WHERE slug='tips_updates')
  AND (SELECT mapped_types ? 'message_reaction' FROM notification_categories WHERE slug='direct_messages')
  AND (SELECT jsonb_array_length(mapped_types) FROM notification_categories WHERE slug='connections_social') = 2
 THEN 'PASS' ELSE 'FAIL' END AS t9;

\echo '--- 10. a member who switches off Posts & reactions no longer gets new-post notifications ---'
UPDATE notification_type_controls SET enabled=true WHERE type='community_post_published';
INSERT INTO user_category_preferences (user_id, tenant_id, category_id, enabled)
SELECT 'aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111', id, false
  FROM notification_categories WHERE slug='posts_reactions';
INSERT INTO user_notifications (user_id, tenant_id, type, title, body) VALUES
 ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','community_post_published','t','b'),
 ('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','community_post_published','t','b');
SELECT CASE WHEN (SELECT count(*) FROM user_notifications WHERE type='community_post_published') = 1
        AND (SELECT user_id FROM user_notifications WHERE type='community_post_published') = 'aaaaaaaa-0000-0000-0000-000000000001'
       THEN 'PASS' ELSE 'FAIL' END AS t10;
