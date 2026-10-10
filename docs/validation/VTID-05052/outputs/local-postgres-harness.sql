create role anon; create role authenticated; create role service_role;
create table app_users(user_id uuid primary key, created_at timestamptz default now(), welcome_chat_sent boolean);
create table chat_messages(sender_id uuid, created_at timestamptz default now(), metadata jsonb);
create table service_bot_accounts(user_id uuid primary key);
create table notification_test_actors(user_id uuid primary key);
\i supabase/migrations/20261010170000_vtid_05052_ci_welcome_greeting_health_exclude_test_accounts.sql
-- 2026-10-08 shape: two registered test accounts, flagged sent, no greetings
insert into app_users values ('7b445f73-e0c2-4e4d-8b3a-d919642c99f0',now()-interval '20 h',true),('e3ff6aa3-bf60-4f18-a49a-306d8e450e9a',now()-interval '1 h',true);
insert into service_bot_accounts values ('7b445f73-e0c2-4e4d-8b3a-d919642c99f0'),('e3ff6aa3-bf60-4f18-a49a-306d8e450e9a');
insert into notification_test_actors values ('7b445f73-e0c2-4e4d-8b3a-d919642c99f0');
select 'test-only window' c, ci_welcome_greeting_health();
-- a real unflagged, ungreeted signup must still alarm
insert into app_users values ('11111111-1111-1111-1111-111111111111',now()-interval '2 h',false);
select 'real ungreeted' c, ci_welcome_greeting_health();
\i supabase/migrations/20261010170000_vtid_05052_ci_welcome_greeting_health_exclude_test_accounts.sql
select 'reapplied' c, has_function_privilege('anon','ci_welcome_greeting_health()','execute') anon_exec, has_function_privilege('service_role','ci_welcome_greeting_health()','execute') sr_exec;
