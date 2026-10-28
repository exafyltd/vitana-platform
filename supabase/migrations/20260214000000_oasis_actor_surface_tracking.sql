-- VTID-01260: Add actor identification and surface tracking to OASIS events
-- Purpose: Enable supervisor-grade tracking of WHO triggered events and FROM WHERE
--
-- Problems solved:
-- 1. No way to distinguish which user initiated an event (j.tadic vs d.stevanovic)
-- 2. No clear origin tracking (ORB vs Operator vs Command Hub)
-- 3. Conversation events flood OASIS with 30+ entries per turn
--
-- New columns:
-- - actor_id: User/system identifier (email, system ID, or service account)
-- - actor_email: Human-readable email for supervisor display
-- - actor_role: Role of the actor (user, operator, admin, system, agent)
-- - surface: Origin surface (orb, operator, command-hub, cicd, system, api)
-- - conversation_turn_id: Groups conversation events into a single turn
-- Idempotent: Safe to run multiple times

-- Step 1: Add actor_id column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'oasis_events'
      AND column_name = 'actor_id'
  ) THEN
    ALTER TABLE public.oasis_events ADD COLUMN actor_id text;
    RAISE NOTICE 'Added actor_id column to oasis_events';
  ELSE
    RAISE NOTICE 'actor_id column already exists';
  END IF;
END$$;

-- Step 2: Add actor_email column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'oasis_events'
      AND column_name = 'actor_email'
  ) THEN
    ALTER TABLE public.oasis_events ADD COLUMN actor_email text;
    RAISE NOTICE 'Added actor_email column to oasis_events';
  ELSE
    RAISE NOTICE 'actor_email column already exists';
  END IF;
END$$;

-- Step 3: Add actor_role column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'oasis_events'
      AND column_name = 'actor_role'
  ) THEN
    ALTER TABLE public.oasis_events ADD COLUMN actor_role text;
    RAISE NOTICE 'Added actor_role column to oasis_events';
  ELSE
    RAISE NOTICE 'actor_role column already exists';
  END IF;
END$$;

-- Step 4: Add surface column (orb | operator | command-hub | cicd | system | api)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'oasis_events'
      AND column_name = 'surface'
  ) THEN
    ALTER TABLE public.oasis_events ADD COLUMN surface text;
    RAISE NOTICE 'Added surface column to oasis_events';
  ELSE
    RAISE NOTICE 'surface column already exists';
  END IF;
END$$;

-- Step 5: Add conversation_turn_id column for grouping conversation events
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'oasis_events'
      AND column_name = 'conversation_turn_id'
  ) THEN
    ALTER TABLE public.oasis_events ADD COLUMN conversation_turn_id text;
    RAISE NOTICE 'Added conversation_turn_id column to oasis_events';
  ELSE
    RAISE NOTICE 'conversation_turn_id column already exists';
  END IF;
END$$;

-- Step 6: Create indexes for the new columns
CREATE INDEX IF NOT EXISTS idx_oasis_events_actor_id
  ON public.oasis_events (actor_id)
  WHERE actor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_oasis_events_actor_email
  ON public.oasis_events (actor_email)
  WHERE actor_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_oasis_events_surface
  ON public.oasis_events (surface)
  WHERE surface IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_oasis_events_conversation_turn
  ON public.oasis_events (conversation_turn_id)
  WHERE conversation_turn_id IS NOT NULL;

-- Composite index for supervisor queries: surface + created_at
CREATE INDEX IF NOT EXISTS idx_oasis_events_surface_created
  ON public.oasis_events (surface, created_at DESC)
  WHERE surface IS NOT NULL;

-- Composite index for actor queries: actor_email + created_at
CREATE INDEX IF NOT EXISTS idx_oasis_events_actor_created
  ON public.oasis_events (actor_email, created_at DESC)
  WHERE actor_email IS NOT NULL;

-- Step 7: Add column comments
COMMENT ON COLUMN public.oasis_events.actor_id IS 'User/system identifier who triggered this event (VTID-01260)';
COMMENT ON COLUMN public.oasis_events.actor_email IS 'Human-readable email of the actor for supervisor display (VTID-01260)';
COMMENT ON COLUMN public.oasis_events.actor_role IS 'Role: user, operator, admin, system, agent (VTID-01260)';
COMMENT ON COLUMN public.oasis_events.surface IS 'Origin surface: orb, operator, command-hub, cicd, system, api (VTID-01260)';
COMMENT ON COLUMN public.oasis_events.conversation_turn_id IS 'Groups conversation pipeline events into a single turn (VTID-01260)';
