-- Four sign-ups on the "supabase" side: the six triggers provision them.
-- Same users, same order as aurora-provision.sql.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('10000000-0000-0000-0000-000000000001', 'alice@example.com', '{"tenant_slug":"maxina","full_name":"Alice Example"}');
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('10000000-0000-0000-0000-000000000002', 'bob@example.com', '{}');
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('10000000-0000-0000-0000-000000000003', 'carol@example.com', '{"tenant_slug":"no-such-tenant","display_name":"Caro"}');
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('10000000-0000-0000-0000-000000000004', 'dave@example.com', '{"tenant_slug":"alkalma","full_name":"Dave D","display_name":"DD"}');
CREATE VIEW public.test_active_tenant AS SELECT id AS user_id, raw_app_meta_data ->> 'active_tenant_id' AS active_tenant_id FROM auth.users;
