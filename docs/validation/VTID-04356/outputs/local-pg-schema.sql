-- Minimal mirror of the live columns/constraints the VTID-04356 triggers touch.
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$; DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE profiles (id uuid PRIMARY KEY, user_id uuid, timezone text);
CREATE TABLE calendar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL, title text NOT NULL, description text,
  start_time timestamptz NOT NULL, end_time timestamptz, location text,
  event_type text NOT NULL DEFAULT 'personal', status text NOT NULL DEFAULT 'confirmed',
  priority text NOT NULL DEFAULT 'medium', metadata jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  source_type text DEFAULT 'manual', role_context text NOT NULL DEFAULT 'community',
  source_ref_id text, source_ref_type text, activated_at timestamptz, completed_at timestamptz,
  completion_status text, rrule text, timezone text, reminder_offsets int[], emoji text, pillar text,
  CONSTRAINT valid_event_type CHECK (event_type = ANY (ARRAY['personal','community','professional','health','workout','nutrition','autopilot','journey_milestone','dev_task','deployment','sprint_milestone','admin_task','wellness_nudge'])),
  CONSTRAINT valid_status CHECK (status = ANY (ARRAY['confirmed','pending','conflict','cancelled'])),
  CONSTRAINT valid_pillar CHECK (pillar IS NULL OR pillar = ANY (ARRAY['nutrition','hydration','exercise','sleep','mental'])),
  CONSTRAINT valid_emoji CHECK (emoji IS NULL OR (char_length(emoji) >= 1 AND char_length(emoji) <= 16)),
  CONSTRAINT valid_role_context CHECK (role_context = ANY (ARRAY['community','professional','admin','developer','personal'])),
  CONSTRAINT valid_completion_status CHECK (completion_status IS NULL OR completion_status = ANY (ARRAY['completed','skipped','partial','rescheduled'])),
  CONSTRAINT valid_rrule CHECK (rrule IS NULL OR rrule ~ '^FREQ=(DAILY|WEEKLY|MONTHLY)(;(INTERVAL=[1-9][0-9]*|COUNT=[1-9][0-9]*|UNTIL=[0-9]{8}T[0-9]{6}Z|BYDAY=(MO|TU|WE|TH|FR|SA|SU)(,(MO|TU|WE|TH|FR|SA|SU))*))*$'),
  CONSTRAINT valid_source_type CHECK (source_type = ANY (ARRAY['manual','invite','imported','autopilot','community_rsvp','assistant','journey','vtid','ci_cd','nudge_engine','health_plan','lab_order','appointment','live_room','goal_plan','guided_journey']))
);
CREATE UNIQUE INDEX idx_calendar_events_source_ref ON calendar_events (user_id, source_ref_id, source_ref_type) WHERE source_ref_id IS NOT NULL;
CREATE TABLE goal_plans (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, goal_text text, start_date date, target_date date, status text);
CREATE TABLE goal_plan_steps (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plan_id uuid, user_id uuid, kind text, title text, description text, day_offset int, scheduled_date date, sort_order int, status text, calendar_event_id uuid, completed_at timestamptz);
CREATE TABLE user_health_plans (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, plan_type text, plan_data jsonb, active boolean, generated_at timestamptz, created_at timestamptz DEFAULT now());
CREATE TABLE provider_appointments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, provider_id text, provider_name text, provider_specialty text, appointment_type text, status text, start_time timestamptz, end_time timestamptz, duration_minutes int, location text);
CREATE TYPE lab_status AS ENUM ('pending','confirmed','sample_collected','processing','completed','cancelled');
CREATE TYPE lab_method AS ENUM ('home','facility');
CREATE TABLE lab_tests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
CREATE TABLE lab_test_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, lab_test_id uuid, collection_method lab_method, status lab_status, scheduled_date timestamptz, facility_address text, special_instructions text);
CREATE TABLE live_rooms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), host_user_id uuid, title text);
CREATE TABLE live_room_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), room_id uuid, session_title text, status text, starts_at timestamptz, ends_at timestamptz);
CREATE TABLE live_room_access_grants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, room_id uuid, session_id uuid, is_valid boolean DEFAULT true, is_revoked boolean DEFAULT false);
