\set ON_ERROR_STOP on
\set u '''11111111-1111-1111-1111-111111111111'''
\set h '''22222222-2222-2222-2222-222222222222'''
INSERT INTO profiles VALUES (:u, :u, 'America/New_York'), (:h, :h, NULL);

CREATE FUNCTION assert(cond boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', msg; END IF; RAISE NOTICE 'ok: %', msg; END $$;

-- S1 goal plan: checkpoint + milestone + habit land, local times, step linked
INSERT INTO goal_plans (id, user_id, goal_text, start_date, target_date, status)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001', :u, 'Run 5k', '2026-10-01', '2026-11-30', 'active');
INSERT INTO goal_plan_steps (id, plan_id, user_id, kind, title, scheduled_date, status) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', :u, 'checkpoint', 'Run 2k', '2026-10-05', 'pending'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', :u, 'milestone', 'Run 5k', '2026-11-30', 'pending'),
  ('bbbbbbbb-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', :u, 'habit', 'Stretch', NULL, 'pending');
SELECT assert((SELECT count(*) FROM calendar_events WHERE source_ref_type='goal_plan_step') = 3, 'S1 three goal entries');
SELECT assert((SELECT start_time FROM calendar_events WHERE source_ref_id='bbbbbbbb-0000-0000-0000-000000000001') = '2026-10-05 13:00:00+00', 'S1 checkpoint 09:00 New York');
SELECT assert((SELECT emoji FROM calendar_events WHERE source_ref_id='bbbbbbbb-0000-0000-0000-000000000002') = '🏁', 'S1 milestone emoji');
SELECT assert((SELECT rrule FROM calendar_events WHERE source_ref_id='bbbbbbbb-0000-0000-0000-000000000003') = 'FREQ=DAILY;UNTIL=20261201T045959Z', 'S1 habit daily until end of target date');
SELECT assert((SELECT count(*) FROM goal_plan_steps WHERE calendar_event_id IS NOT NULL) = 3, 'S1 steps linked to entries');

-- S2 idempotent: re-touching a step does not duplicate or churn
SELECT updated_at AS t0 FROM calendar_events WHERE source_ref_id='bbbbbbbb-0000-0000-0000-000000000001' \gset
UPDATE goal_plan_steps SET title = 'Run 2k' WHERE id='bbbbbbbb-0000-0000-0000-000000000001';
SELECT assert((SELECT count(*) FROM calendar_events WHERE source_ref_type='goal_plan_step') = 3, 'S2 still three');
SELECT assert((SELECT updated_at FROM calendar_events WHERE source_ref_id='bbbbbbbb-0000-0000-0000-000000000001') = :'t0', 'S2 unchanged entry not rewritten');

-- S3 move a step moves the entry
UPDATE goal_plan_steps SET scheduled_date='2026-10-06' WHERE id='bbbbbbbb-0000-0000-0000-000000000001';
SELECT assert((SELECT start_time FROM calendar_events WHERE source_ref_id='bbbbbbbb-0000-0000-0000-000000000001') = '2026-10-06 13:00:00+00', 'S3 entry moved');

-- S4 done at source -> completed; back to pending -> reopened; completed entry never moved
UPDATE goal_plan_steps SET status='done' WHERE id='bbbbbbbb-0000-0000-0000-000000000001';
SELECT assert((SELECT completion_status FROM calendar_events WHERE source_ref_id='bbbbbbbb-0000-0000-0000-000000000001') = 'completed', 'S4 completed');
UPDATE goal_plan_steps SET scheduled_date='2026-10-09' WHERE id='bbbbbbbb-0000-0000-0000-000000000001';
SELECT assert((SELECT start_time FROM calendar_events WHERE source_ref_id='bbbbbbbb-0000-0000-0000-000000000001') = '2026-10-06 13:00:00+00', 'S4 completed entry kept its time');
UPDATE goal_plan_steps SET status='pending' WHERE id='bbbbbbbb-0000-0000-0000-000000000001';
SELECT assert((SELECT completed_at FROM calendar_events WHERE source_ref_id='bbbbbbbb-0000-0000-0000-000000000001') IS NULL, 'S4 reopened');

-- S5 superseded plan cancels its open entries
UPDATE goal_plans SET status='superseded' WHERE id='aaaaaaaa-0000-0000-0000-000000000001';
SELECT assert((SELECT count(*) FROM calendar_events WHERE source_ref_type='goal_plan_step' AND status='cancelled') = 3, 'S5 superseded -> cancelled');
-- and re-activating brings them back
UPDATE goal_plans SET status='active' WHERE id='aaaaaaaa-0000-0000-0000-000000000001';
SELECT assert((SELECT count(*) FROM calendar_events WHERE source_ref_type='goal_plan_step' AND status='confirmed') = 3, 'S5 reactivated');
DELETE FROM goal_plan_steps WHERE id='bbbbbbbb-0000-0000-0000-000000000002';
SELECT assert((SELECT status FROM calendar_events WHERE source_ref_id='bbbbbbbb-0000-0000-0000-000000000002') = 'cancelled', 'S5 deleted step cancelled');

-- S6 health plan: daily series, duration parsed, deactivation cancels
INSERT INTO user_health_plans (id, user_id, plan_type, plan_data, active, generated_at) VALUES
  ('cccccccc-0000-0000-0000-000000000001', :h, 'hydration', '{"planName":"Personalized Hydration Plan","duration":"4 weeks","recommendations":["a","b","c","d"]}', true, '2026-09-20 06:00+00'),
  ('cccccccc-0000-0000-0000-000000000002', :h, 'nutrition', '{"planName":"Eat well","duration":"10 days","recommendations":{"x":1}}', true, '2026-09-20 06:00+00');
SELECT assert((SELECT rrule FROM calendar_events WHERE source_ref_id='cccccccc-0000-0000-0000-000000000001') = 'FREQ=DAILY;COUNT=28', 'S6 4 weeks = 28');
SELECT assert((SELECT rrule FROM calendar_events WHERE source_ref_id='cccccccc-0000-0000-0000-000000000002') = 'FREQ=DAILY;COUNT=10', 'S6 10 days');
SELECT assert((SELECT start_time FROM calendar_events WHERE source_ref_id='cccccccc-0000-0000-0000-000000000001') = '2026-09-20 08:00:00+00', 'S6 hydration 10:00 Berlin');
SELECT assert((SELECT pillar||'/'||emoji||'/'||event_type FROM calendar_events WHERE source_ref_id='cccccccc-0000-0000-0000-000000000001') = 'hydration/💧/nutrition', 'S6 pillar emoji type');
SELECT assert((SELECT description FROM calendar_events WHERE source_ref_id='cccccccc-0000-0000-0000-000000000001') = E'• a\n• b\n• c', 'S6 first three recommendations');
SELECT assert((SELECT description FROM calendar_events WHERE source_ref_id='cccccccc-0000-0000-0000-000000000002') IS NULL, 'S6 non-array recommendations tolerated');
UPDATE user_health_plans SET active=false WHERE id='cccccccc-0000-0000-0000-000000000001';
SELECT assert((SELECT status FROM calendar_events WHERE source_ref_id='cccccccc-0000-0000-0000-000000000001') = 'cancelled', 'S6 deactivated -> cancelled');

-- S7 appointments: unpaid never shows, paid shows, cancel cancels
INSERT INTO provider_appointments (id, user_id, provider_name, provider_specialty, appointment_type, status, start_time, duration_minutes, location)
  VALUES ('dddddddd-0000-0000-0000-000000000001', :u, 'Dr. Weber', 'Cardiology', 'video', 'pending', '2026-10-10 09:00+00', 45, 'Online');
SELECT assert((SELECT count(*) FROM calendar_events WHERE source_ref_type='provider_appointment') = 0, 'S7 unpaid booking not in calendar');
UPDATE provider_appointments SET status='scheduled' WHERE id='dddddddd-0000-0000-0000-000000000001';
SELECT assert((SELECT title||'|'||end_time::text||'|'||status FROM calendar_events WHERE source_ref_type='provider_appointment') = 'Dr. Weber|2026-10-10 09:45:00+00|confirmed', 'S7 paid booking in calendar, duration used');
UPDATE provider_appointments SET status='cancelled' WHERE id='dddddddd-0000-0000-0000-000000000001';
SELECT assert((SELECT status FROM calendar_events WHERE source_ref_type='provider_appointment') = 'cancelled', 'S7 cancelled');
UPDATE provider_appointments SET status='scheduled' WHERE id='dddddddd-0000-0000-0000-000000000001';
SELECT assert((SELECT count(*) FROM calendar_events WHERE source_ref_type='provider_appointment' AND status='confirmed') = 1, 'S7 rebooked reactivates one row');

-- S8 lab order: confirmed -> lab entry, sample collected -> completed
INSERT INTO lab_tests (id, name) VALUES ('eeeeeeee-0000-0000-0000-000000000001', 'Vitamin D');
INSERT INTO lab_test_orders (id, user_id, lab_test_id, collection_method, status, scheduled_date, facility_address)
  VALUES ('ffffffff-0000-0000-0000-000000000001', :u, 'eeeeeeee-0000-0000-0000-000000000001', 'facility', 'confirmed', '2026-10-12 07:30+00', 'Lab street 1');
SELECT assert((SELECT title||'|'||source_type||'|'||emoji FROM calendar_events WHERE source_ref_type='lab_test_order') = 'Vitamin D|lab_order|🧪', 'S8 lab entry');
UPDATE lab_test_orders SET status='sample_collected' WHERE id='ffffffff-0000-0000-0000-000000000001';
SELECT assert((SELECT completion_status FROM calendar_events WHERE source_ref_type='lab_test_order') = 'completed', 'S8 sample collected -> completed');

-- S9 live room: host + ticket holder, move moves both, revoke cancels holder only, cancel cancels host
INSERT INTO live_rooms (id, host_user_id, title) VALUES ('99999999-0000-0000-0000-000000000001', :h, 'Breathwork');
INSERT INTO live_room_sessions (id, room_id, session_title, status, starts_at, ends_at)
  VALUES ('88888888-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000001', '', 'scheduled', '2026-10-15 17:00+00', NULL);
INSERT INTO live_room_access_grants (id, user_id, room_id, session_id)
  VALUES ('77777777-0000-0000-0000-000000000001', :u, '99999999-0000-0000-0000-000000000001', '88888888-0000-0000-0000-000000000001');
SELECT assert((SELECT count(*) FROM calendar_events WHERE source_ref_type='live_room_session' AND title='Breathwork') = 2, 'S9 host and holder');
UPDATE live_room_sessions SET starts_at='2026-10-15 18:00+00' WHERE id='88888888-0000-0000-0000-000000000001';
SELECT assert((SELECT count(*) FROM calendar_events WHERE source_ref_type='live_room_session' AND start_time='2026-10-15 18:00+00') = 2, 'S9 moved for both');
UPDATE live_room_access_grants SET is_revoked=true WHERE id='77777777-0000-0000-0000-000000000001';
SELECT assert((SELECT status FROM calendar_events WHERE source_ref_type='live_room_session' AND user_id=:u) = 'cancelled', 'S9 revoked ticket cancelled');
SELECT assert((SELECT status FROM calendar_events WHERE source_ref_type='live_room_session' AND user_id=:h) = 'confirmed', 'S9 host unaffected');
UPDATE live_room_sessions SET status='cancelled' WHERE id='88888888-0000-0000-0000-000000000001';
SELECT assert((SELECT status FROM calendar_events WHERE source_ref_type='live_room_session' AND user_id=:h) = 'cancelled', 'S9 session cancelled');

-- S10 a calendar failure never fails the source write
ALTER TABLE calendar_events ADD CONSTRAINT boom CHECK (title <> 'EXPLODE');
INSERT INTO goal_plan_steps (plan_id, user_id, kind, title, scheduled_date, status)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001', :u, 'checkpoint', 'EXPLODE', '2026-10-20', 'pending');
SELECT assert((SELECT count(*) FROM goal_plan_steps WHERE title='EXPLODE') = 1, 'S10 source row kept despite calendar failure');
ALTER TABLE calendar_events DROP CONSTRAINT boom;

-- S11 habits of one plan are staggered 30 min apart
INSERT INTO goal_plan_steps (id, plan_id, user_id, kind, title, sort_order, status) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001', :u, 'habit', 'Water', 5, 'pending'),
  ('bbbbbbbb-0000-0000-0000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000001', :u, 'habit', 'Walk', 6, 'pending');
SELECT assert((SELECT array_agg(to_char(start_time AT TIME ZONE 'America/New_York','HH24:MI') ORDER BY start_time) FROM calendar_events
  WHERE source_ref_id IN ('bbbbbbbb-0000-0000-0000-000000000003','bbbbbbbb-0000-0000-0000-000000000011','bbbbbbbb-0000-0000-0000-000000000012'))
  = ARRAY['08:00','08:30','09:00'], 'S11 habits staggered 08:00/08:30/09:00');
