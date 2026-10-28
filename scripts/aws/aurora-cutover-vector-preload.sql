-- Aurora cutover: PRE-LOAD (run before the DMS full load; no downtime, Aurora only) (VTID-04755)
-- Generated from Supabase's live schema 2026-10-05 (the target state).
-- DMS's bulk loader cannot write pgvector columns (runbook Step 1), so the
-- 13 vector columns are staged as text for the load and cast back after.
-- `products` is excluded from the DMS load and is deliberately not touched.
-- One statement per line: run with scripts/aws/aurora-run-sql.sh.

-- calendar_events: all 12 CHECK constraints re-synced to Supabase's definitions
-- as of 2026-10-09 (the 10-09 reload failed on an older valid_source_type that
-- lacked 'reminder'/'subscription'). NOT VALID: enforced for loaded rows, no scan.
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS valid_completion_status;
ALTER TABLE public.calendar_events ADD CONSTRAINT valid_completion_status CHECK (((completion_status IS NULL) OR (completion_status = ANY (ARRAY['completed'::text, 'skipped'::text, 'partial'::text, 'rescheduled'::text])))) NOT VALID;
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS valid_contribution_vector;
ALTER TABLE public.calendar_events ADD CONSTRAINT valid_contribution_vector CHECK (((contribution_vector IS NULL) OR ((jsonb_typeof(contribution_vector) = 'object'::text) AND ((((((contribution_vector - 'nutrition'::text) - 'hydration'::text) - 'exercise'::text) - 'sleep'::text) - 'mental'::text) = '{}'::jsonb)))) NOT VALID;
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS valid_emoji;
ALTER TABLE public.calendar_events ADD CONSTRAINT valid_emoji CHECK (((emoji IS NULL) OR ((char_length(emoji) >= 1) AND (char_length(emoji) <= 16)))) NOT VALID;
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS valid_event_type;
ALTER TABLE public.calendar_events ADD CONSTRAINT valid_event_type CHECK ((event_type = ANY (ARRAY['personal'::text, 'community'::text, 'professional'::text, 'health'::text, 'workout'::text, 'nutrition'::text, 'autopilot'::text, 'journey_milestone'::text, 'dev_task'::text, 'deployment'::text, 'sprint_milestone'::text, 'admin_task'::text, 'wellness_nudge'::text]))) NOT VALID;
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS valid_pillar;
ALTER TABLE public.calendar_events ADD CONSTRAINT valid_pillar CHECK (((pillar IS NULL) OR (pillar = ANY (ARRAY['nutrition'::text, 'hydration'::text, 'exercise'::text, 'sleep'::text, 'mental'::text])))) NOT VALID;
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS valid_priority;
ALTER TABLE public.calendar_events ADD CONSTRAINT valid_priority CHECK ((priority = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text]))) NOT VALID;
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS valid_priority_score;
ALTER TABLE public.calendar_events ADD CONSTRAINT valid_priority_score CHECK (((priority_score >= 0) AND (priority_score <= 100))) NOT VALID;
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS valid_reminder_offsets;
ALTER TABLE public.calendar_events ADD CONSTRAINT valid_reminder_offsets CHECK (((reminder_offsets IS NULL) OR ((cardinality(reminder_offsets) <= 5) AND (0 <= ALL (reminder_offsets)) AND (40320 >= ALL (reminder_offsets))))) NOT VALID;
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS valid_role_context;
ALTER TABLE public.calendar_events ADD CONSTRAINT valid_role_context CHECK ((role_context = ANY (ARRAY['community'::text, 'professional'::text, 'admin'::text, 'developer'::text, 'personal'::text]))) NOT VALID;
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS valid_rrule;
ALTER TABLE public.calendar_events ADD CONSTRAINT valid_rrule CHECK (((rrule IS NULL) OR (rrule ~ '^FREQ=(DAILY|WEEKLY|MONTHLY)(;(INTERVAL=[1-9][0-9]*|COUNT=[1-9][0-9]*|UNTIL=[0-9]{8}T[0-9]{6}Z|BYDAY=(MO|TU|WE|TH|FR|SA|SU)(,(MO|TU|WE|TH|FR|SA|SU))*))*$'::text))) NOT VALID;
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS valid_source_type;
ALTER TABLE public.calendar_events ADD CONSTRAINT valid_source_type CHECK ((source_type = ANY (ARRAY['manual'::text, 'invite'::text, 'imported'::text, 'autopilot'::text, 'community_rsvp'::text, 'assistant'::text, 'journey'::text, 'vtid'::text, 'ci_cd'::text, 'nudge_engine'::text, 'health_plan'::text, 'lab_order'::text, 'appointment'::text, 'live_room'::text, 'goal_plan'::text, 'guided_journey'::text, 'reminder'::text, 'subscription'::text]))) NOT VALID;
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS valid_status;
ALTER TABLE public.calendar_events ADD CONSTRAINT valid_status CHECK ((status = ANY (ARRAY['confirmed'::text, 'pending'::text, 'conflict'::text, 'cancelled'::text]))) NOT VALID;
DROP INDEX IF EXISTS public.ai_memory_embedding_idx;
DROP INDEX IF EXISTS public.dev_agent_memory_embedding_idx;
DROP INDEX IF EXISTS public.mem_episodes_embedding_hnsw;
DROP INDEX IF EXISTS public.mem_facts_embedding_hnsw;
DROP INDEX IF EXISTS public.idx_mem_emb_vector;
DROP INDEX IF EXISTS public.idx_memory_facts_embedding_hnsw;
DROP INDEX IF EXISTS public.idx_memory_items_embedding_hnsw;
DROP INDEX IF EXISTS public.user_intents_embedding_hnsw_idx;
DROP INDEX IF EXISTS public.idx_vtid_ledger_embedding_hnsw;
ALTER TABLE public.ai_memory ALTER COLUMN embedding TYPE text USING embedding::text;
ALTER TABLE public.calendar_events ALTER COLUMN embedding TYPE text USING embedding::text;
ALTER TABLE public.dev_agent_memory ALTER COLUMN embedding TYPE text USING embedding::text;
ALTER TABLE public.feedback_tickets ALTER COLUMN embedding TYPE text USING embedding::text;
ALTER TABLE public.mem_episodes ALTER COLUMN embedding TYPE text USING embedding::text;
ALTER TABLE public.mem_facts ALTER COLUMN embedding TYPE text USING embedding::text;
ALTER TABLE public.memory_embeddings ALTER COLUMN embedding TYPE text USING embedding::text;
ALTER TABLE public.memory_facts ALTER COLUMN embedding TYPE text USING embedding::text;
ALTER TABLE public.memory_items ALTER COLUMN embedding TYPE text USING embedding::text;
ALTER TABLE public.user_intents ALTER COLUMN embedding TYPE text USING embedding::text;
ALTER TABLE public.user_intents ALTER COLUMN embedding_v2 TYPE text USING embedding_v2::text;
ALTER TABLE public.vtid_ledger ALTER COLUMN embedding TYPE text USING embedding::text;
ALTER TABLE public.vtid_ledger ALTER COLUMN embedding_v2 TYPE text USING embedding_v2::text;
