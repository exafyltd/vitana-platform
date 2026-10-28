-- =============================================================================
-- Intelligent Calendar — Phase 1 Migration
--
-- Extends the existing calendar_events table (created in vitana-v1 migration
-- 20250923103450) with columns needed for:
--   - Role-aware filtering (role_context)
--   - Autopilot/journey/community source tracking (source_ref_id, source_ref_type)
--   - Infinite memory (completion_status, completed_at, original_start_time, embedding)
--   - Smart rescheduling (reschedule_count, activated_at)
--   - Dynamic prioritization (priority_score, wellness_tags)
--   - RSVP → calendar sync (DB triggers on event_attendance)
--
-- Backward-compatible: all new columns are nullable or have defaults.
-- Existing CHECK constraints are relaxed to accept new enum values.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Relax existing CHECK constraints to accept new values
-- ---------------------------------------------------------------------------

-- Drop and recreate event_type constraint with new values
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS valid_event_type;
ALTER TABLE public.calendar_events ADD CONSTRAINT valid_event_type
  CHECK (event_type IN (
    -- Original values
    'personal', 'community', 'professional', 'health', 'workout', 'nutrition',
    -- New values
    'autopilot', 'journey_milestone', 'dev_task', 'deployment',
    'sprint_milestone', 'admin_task', 'wellness_nudge'
  ));

-- Drop and recreate source_type constraint with new values
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS valid_source_type;
ALTER TABLE public.calendar_events ADD CONSTRAINT valid_source_type
  CHECK (source_type IN (
    -- Original values
    'manual', 'invite', 'imported',
    -- New values
    'autopilot', 'community_rsvp', 'assistant', 'journey',
    'vtid', 'ci_cd', 'nudge_engine'
  ));

-- Drop and recreate status constraint with new values
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS valid_status;
ALTER TABLE public.calendar_events ADD CONSTRAINT valid_status
  CHECK (status IN (
    -- Original values
    'confirmed', 'pending', 'conflict', 'cancelled'
  ));

-- ---------------------------------------------------------------------------
-- 2. Add new columns (all backward-compatible)
-- ---------------------------------------------------------------------------

-- Role-aware filtering
ALTER TABLE public.calendar_events
  ADD COLUMN IF NOT EXISTS role_context TEXT NOT NULL DEFAULT 'community';

-- Source tracking (links back to recommendation, meetup, wave, VTID, etc.)
ALTER TABLE public.calendar_events
  ADD COLUMN IF NOT EXISTS source_ref_id TEXT;
ALTER TABLE public.calendar_events
  ADD COLUMN IF NOT EXISTS source_ref_type TEXT;

-- Infinite memory — completion tracking
ALTER TABLE public.calendar_events
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;
ALTER TABLE public.calendar_events
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE public.calendar_events
  ADD COLUMN IF NOT EXISTS completion_status TEXT;
ALTER TABLE public.calendar_events
  ADD COLUMN IF NOT EXISTS completion_notes TEXT;
ALTER TABLE public.calendar_events
  ADD COLUMN IF NOT EXISTS original_start_time TIMESTAMPTZ;

-- Smart rescheduling
ALTER TABLE public.calendar_events
  ADD COLUMN IF NOT EXISTS reschedule_count INT NOT NULL DEFAULT 0;

-- Dynamic prioritization
ALTER TABLE public.calendar_events
  ADD COLUMN IF NOT EXISTS priority_score INT NOT NULL DEFAULT 50;

-- Wellness tags for nudge matching
ALTER TABLE public.calendar_events
  ADD COLUMN IF NOT EXISTS wellness_tags TEXT[] DEFAULT '{}';

-- pgvector embedding for semantic search (infinite memory)
-- Requires pgvector extension (already enabled via VTID-01184)
ALTER TABLE public.calendar_events
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- Constraints on new columns
ALTER TABLE public.calendar_events ADD CONSTRAINT valid_role_context
  CHECK (role_context IN ('community', 'admin', 'developer', 'personal'));

ALTER TABLE public.calendar_events ADD CONSTRAINT valid_completion_status
  CHECK (completion_status IS NULL OR completion_status IN (
    'completed', 'skipped', 'partial', 'rescheduled'
  ));

ALTER TABLE public.calendar_events ADD CONSTRAINT valid_priority_score
  CHECK (priority_score >= 0 AND priority_score <= 100);

-- ---------------------------------------------------------------------------
-- 3. Indexes
-- ---------------------------------------------------------------------------

-- Idempotent source-based inserts (prevents duplicate autopilot/journey events)
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_events_source_ref
  ON public.calendar_events (user_id, source_ref_id, source_ref_type)
  WHERE source_ref_id IS NOT NULL;

-- Role-filtered upcoming events (powers calendar API + assistant context)
CREATE INDEX IF NOT EXISTS idx_calendar_events_role_upcoming
  ON public.calendar_events (user_id, role_context, start_time)
  WHERE status != 'cancelled';

-- Smart rescheduler scan
CREATE INDEX IF NOT EXISTS idx_calendar_events_reschedule_candidates
  ON public.calendar_events (source_type, status, end_time, activated_at)
  WHERE source_type IN ('autopilot', 'journey') AND status = 'confirmed';

-- Embedding similarity search (uses pgvector ivfflat; build after data exists)
-- Note: IVFFlat index needs rows to train — create after journey pre-population
-- CREATE INDEX IF NOT EXISTS idx_calendar_events_embedding
--   ON public.calendar_events USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

-- ---------------------------------------------------------------------------
-- 4. Semantic search RPC (mirrors semantic_memory_search from VTID-01184)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.semantic_calendar_search(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 10,
  p_user_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  title text,
  description text,
  start_time timestamptz,
  end_time timestamptz,
  event_type text,
  status text,
  completion_status text,
  role_context text,
  wellness_tags text[],
  similarity float
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ce.id,
    ce.title,
    ce.description,
    ce.start_time,
    ce.end_time,
    ce.event_type,
    ce.status,
    ce.completion_status,
    ce.role_context,
    ce.wellness_tags,
    1 - (ce.embedding <=> query_embedding) AS similarity
  FROM public.calendar_events ce
  WHERE ce.embedding IS NOT NULL
    AND (p_user_id IS NULL OR ce.user_id = p_user_id)
    AND 1 - (ce.embedding <=> query_embedding) > match_threshold
  ORDER BY ce.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION public.semantic_calendar_search IS
  'Intelligent Calendar: cosine similarity search on calendar event embeddings';

-- ---------------------------------------------------------------------------
-- 5. RLS policy for service role access
-- ---------------------------------------------------------------------------

-- The gateway uses SUPABASE_SERVICE_ROLE which bypasses RLS.
-- The existing user-scoped RLS policy remains unchanged.
-- No new RLS policies needed — service role handles all gateway operations.

-- ---------------------------------------------------------------------------
-- 6. RSVP → Calendar sync triggers
-- ---------------------------------------------------------------------------

-- When a user RSVPs to a community meetup, auto-create a calendar event
CREATE OR REPLACE FUNCTION public.fn_rsvp_to_calendar()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'rsvp' THEN
    INSERT INTO public.calendar_events (
      user_id, title, start_time, end_time, location,
      event_type, source_type, source_ref_id, source_ref_type,
      status, role_context
    )
    SELECT
      NEW.user_id,
      COALESCE(m.title, 'Community Meetup'),
      m.starts_at,
      m.ends_at,
      m.location_text,
      'community',
      'community_rsvp',
      NEW.meetup_id::text,
      'community_meetup',
      'confirmed',
      'community'
    FROM public.community_meetups m
    WHERE m.id = NEW.meetup_id
    ON CONFLICT (user_id, source_ref_id, source_ref_type)
      WHERE source_ref_id IS NOT NULL
      DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger: AFTER INSERT on event_attendance
DROP TRIGGER IF EXISTS trg_rsvp_calendar_sync ON public.event_attendance;
CREATE TRIGGER trg_rsvp_calendar_sync
  AFTER INSERT ON public.event_attendance
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_rsvp_to_calendar();

-- When an RSVP is cancelled (status changes from 'rsvp' or row deleted),
-- cancel the corresponding calendar event
CREATE OR REPLACE FUNCTION public.fn_rsvp_cancel_calendar()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- On UPDATE: if status changed from 'rsvp' to something else
  IF TG_OP = 'UPDATE' AND OLD.status = 'rsvp' AND NEW.status != 'rsvp' THEN
    UPDATE public.calendar_events
    SET status = 'cancelled', updated_at = NOW()
    WHERE user_id = OLD.user_id
      AND source_ref_id = OLD.meetup_id::text
      AND source_ref_type = 'community_meetup';
    RETURN NEW;
  END IF;

  -- On DELETE: cancel the calendar event
  IF TG_OP = 'DELETE' THEN
    UPDATE public.calendar_events
    SET status = 'cancelled', updated_at = NOW()
    WHERE user_id = OLD.user_id
      AND source_ref_id = OLD.meetup_id::text
      AND source_ref_type = 'community_meetup';
    RETURN OLD;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_rsvp_cancel_calendar_sync ON public.event_attendance;
CREATE TRIGGER trg_rsvp_cancel_calendar_sync
  AFTER UPDATE OR DELETE ON public.event_attendance
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_rsvp_cancel_calendar();

COMMENT ON FUNCTION public.fn_rsvp_to_calendar IS
  'Intelligent Calendar: auto-creates calendar event when user RSVPs to a community meetup';
COMMENT ON FUNCTION public.fn_rsvp_cancel_calendar IS
  'Intelligent Calendar: cancels calendar event when user cancels RSVP';
