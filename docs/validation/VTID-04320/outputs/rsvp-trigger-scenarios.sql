\set ON_ERROR_STOP 1
insert into global_community_events (id,title,start_time,end_time,location,slug) values ('11111111-1111-1111-1111-111111111111','Sunset walk', now()+interval '1 day', null, 'Park','sunset');
-- 1) voice path: participant only -> 1 trigger row
insert into global_event_participants (event_id,user_id,status) values ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001','attending');
select 'T1 voice join', count(*) filter (where status<>'cancelled'), string_agg(source_type,',') from calendar_events where user_id='aaaaaaaa-0000-0000-0000-000000000001';
-- 2) web path: participant + client row -> exactly 1 (client row)
insert into global_event_participants (event_id,user_id,status) values ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002','attending');
insert into calendar_events (user_id,title,start_time,event_type,source_type,metadata) values ('aaaaaaaa-0000-0000-0000-000000000002','Sunset walk',now()+interval '1 day','community','manual','{"meetup_id":"11111111-1111-1111-1111-111111111111"}');
select 'T2 web join', count(*) filter (where status<>'cancelled'), string_agg(source_type,',') from calendar_events where user_id='aaaaaaaa-0000-0000-0000-000000000002';
-- 3) repeat upsert with same status -> no dup
update global_event_participants set status='attending' where user_id='aaaaaaaa-0000-0000-0000-000000000001';
select 'T3 re-upsert', count(*) filter (where status<>'cancelled') from calendar_events where user_id='aaaaaaaa-0000-0000-0000-000000000001';
-- 4) leave (delete) -> cancelled
delete from global_event_participants where user_id='aaaaaaaa-0000-0000-0000-000000000001';
select 'T4 leave', count(*) filter (where status<>'cancelled'), count(*) filter (where status='cancelled') from calendar_events where user_id='aaaaaaaa-0000-0000-0000-000000000001';
-- 5) rejoin -> reactivated, still 1 row total
insert into global_event_participants (event_id,user_id,status) values ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001','attending');
select 'T5 rejoin', count(*) filter (where status<>'cancelled'), count(*) from calendar_events where user_id='aaaaaaaa-0000-0000-0000-000000000001';
-- 6) end_time null -> +1h; web user leave cancels client row
select 'T6 end', (end_time - start_time) from calendar_events where user_id='aaaaaaaa-0000-0000-0000-000000000001';
update global_event_participants set status='cancelled' where user_id='aaaaaaaa-0000-0000-0000-000000000002';
select 'T7 web leave via status', count(*) filter (where status<>'cancelled') from calendar_events where user_id='aaaaaaaa-0000-0000-0000-000000000002';
-- 8) unrelated manual row without meetup untouched
insert into calendar_events (user_id,title,start_time,event_type) values ('aaaaaaaa-0000-0000-0000-000000000003','Dentist',now(),'personal');
select 'T8 unrelated', count(*) from calendar_events where user_id='aaaaaaaa-0000-0000-0000-000000000003';
