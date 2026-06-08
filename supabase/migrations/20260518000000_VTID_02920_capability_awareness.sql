-- B0e.1 (orb-live-refactor) — capability awareness foundation.
--
-- VTID-02920. Creates the two tables the Onboarding & Feature
-- Discovery Coach (B0e provider) needs to pick ONE unexplored
-- capability per turn:
--
--   system_capabilities       — catalog of features Vitana can introduce
--   user_capability_awareness — per-user state ladder per capability
--
-- The plan originally placed both in B0c, but B0c shipped only the
-- user_assistant_state table. We create them here in B0e.1 with the
-- full awareness-state ladder (B0e extension) folded in from the
-- start — there is no separate B0c → B0e migration to coordinate.
--
-- Hard rule (carried from the plan):
--   The Feature Discovery Coach picks ONE capability per turn — never
--   a list. The "marketing-dump" failure mode is forbidden by
--   construction at the provider level (B0e.2); the schema makes it
--   easy to enforce by tracking dismiss_count + last_introduced_at
--   so the ranker can dampen recently-suggested or twice-dismissed
--   capabilities.
--
-- RLS: tenant-scoped read/write — only the session's tenant can
-- see/mutate its rows. system_capabilities is a global catalog
-- (read-only for authenticated users, write requires service role).

-- ---------------------------------------------------------------
-- system_capabilities — global catalog
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS system_capabilities (
  capability_key            TEXT PRIMARY KEY,
  display_name              TEXT NOT NULL,
  description               TEXT NOT NULL,
  required_role             TEXT,                          -- community | admin | developer | NULL
  required_tenant_features  TEXT[],                        -- e.g. ARRAY['life_compass_enabled']
  required_integrations     TEXT[],                        -- e.g. ARRAY['google_calendar']
  helpful_for_intents       TEXT[],                        -- e.g. ARRAY['log_meal','set_goal']
  enabled                   BOOLEAN NOT NULL DEFAULT true,
  surfaced_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS system_capabilities_enabled_idx
  ON system_capabilities (enabled)
  WHERE enabled = true;

CREATE OR REPLACE FUNCTION system_capabilities_touch_updated_at()
  RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS system_capabilities_updated_at_trigger ON system_capabilities;
CREATE TRIGGER system_capabilities_updated_at_trigger
  BEFORE UPDATE ON system_capabilities
  FOR EACH ROW
  EXECUTE FUNCTION system_capabilities_touch_updated_at();

-- Read-only for authenticated users; service role bypasses RLS.
ALTER TABLE system_capabilities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS system_capabilities_authenticated_read ON system_capabilities;
CREATE POLICY system_capabilities_authenticated_read
  ON system_capabilities
  FOR SELECT
  TO authenticated
  USING (true);

-- ---------------------------------------------------------------
-- user_capability_awareness — per-user state ladder
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_capability_awareness (
  tenant_id            UUID NOT NULL,
  user_id              UUID NOT NULL,
  capability_key       TEXT NOT NULL REFERENCES system_capabilities(capability_key) ON DELETE CASCADE,
  awareness_state      TEXT NOT NULL DEFAULT 'unknown'
    CHECK (awareness_state IN (
      'unknown',       -- never surfaced
      'introduced',    -- coach mentioned it
      'seen',          -- user opened a related screen
      'tried',         -- user invoked the capability once
      'completed',     -- user finished a meaningful flow
      'dismissed',     -- user said no
      'mastered'       -- repeated successful use over time
    )),
  first_introduced_at  TIMESTAMPTZ,
  last_introduced_at   TIMESTAMPTZ,
  first_used_at        TIMESTAMPTZ,
  last_used_at         TIMESTAMPTZ,
  use_count            INT NOT NULL DEFAULT 0,
  dismiss_count        INT NOT NULL DEFAULT 0,
  mastery_confidence   NUMERIC(4,3),                       -- 0.000–1.000
  last_surface         TEXT,                               -- where it was last surfaced (orb_wake / home / ...)
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, capability_key)
);

-- Per-user lookup is the most common access pattern (ranker reads it
-- on every wake to find unexplored capabilities).
CREATE INDEX IF NOT EXISTS user_capability_awareness_user_idx
  ON user_capability_awareness (tenant_id, user_id);

-- State histogram for operators (Command Hub Feature Discovery panel).
CREATE INDEX IF NOT EXISTS user_capability_awareness_state_idx
  ON user_capability_awareness (awareness_state);

CREATE OR REPLACE FUNCTION user_capability_awareness_touch_updated_at()
  RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS user_capability_awareness_updated_at_trigger ON user_capability_awareness;
CREATE TRIGGER user_capability_awareness_updated_at_trigger
  BEFORE UPDATE ON user_capability_awareness
  FOR EACH ROW
  EXECUTE FUNCTION user_capability_awareness_touch_updated_at();

ALTER TABLE user_capability_awareness ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_capability_awareness_tenant_isolation ON user_capability_awareness;
CREATE POLICY user_capability_awareness_tenant_isolation
  ON user_capability_awareness
  FOR ALL
  TO authenticated
  USING (
    tenant_id IN (
      SELECT tenant_id FROM user_tenants WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    tenant_id IN (
      SELECT tenant_id FROM user_tenants WHERE user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------
-- Seed the 14 canonical capabilities the plan documents.
--
-- Match-journey capability seeds (pre_match_whois, draft_opener, etc.)
-- are NOT included here — they belong to the match-concierge reservation
-- (B0a–B0e match-journey hooks) and stay deferred until that feature
-- ships. Adding them now would create stale catalog entries.
-- ---------------------------------------------------------------

INSERT INTO system_capabilities (
  capability_key, display_name, description,
  required_role, required_integrations, helpful_for_intents
) VALUES
  -- Tier 0: orientation
  ('life_compass',
   'Life Compass',
   'Define your single active longevity goal — feeds every recommendation Vitana makes.',
   'community', NULL, ARRAY['set_goal','clarify_priorities']),

  ('vitana_index',
   'Vitana Index',
   'Your 5-pillar longevity score (Nutrition, Hydration, Exercise, Sleep, Mental) + balance factor.',
   'community', NULL, ARRAY['understand_progress','learn_index']),

  -- Tier 1: daily capture
  ('diary_entry',
   'Diary Entry',
   'Save what you ate / how you slept / how you trained — the simplest way to keep the Index moving.',
   'community', NULL, ARRAY['log_meal','log_workout','log_sleep','daily_reflection']),

  ('community_post',
   'Community Post',
   'Share progress or ask a question in your community — earns reach and reactions.',
   'community', NULL, ARRAY['share_progress','ask_question']),

  -- Tier 2: scheduling + integrations
  ('reminders',
   'Reminders',
   'Voice-set reminders that fire as push notifications when the time comes.',
   'community', NULL, ARRAY['remember_to_x','schedule_action']),

  ('calendar_connect',
   'Calendar Connect',
   'Connect Google Calendar so Vitana can see meetings + meal/workout windows.',
   'community', ARRAY['google_calendar'], ARRAY['schedule_activity','avoid_conflict']),

  -- Tier 3: matching + community
  ('activity_match',
   'Activity Match',
   'Find a hiking / chess / language-exchange partner in your community.',
   'community', NULL, ARRAY['find_partner','plan_activity']),

  ('live_room',
   'Live Room',
   'Drop into or host a live conversation room with community members.',
   'community', NULL, ARRAY['talk_with_others','host_conversation']),

  ('community_intent',
   'Community Intent',
   'Publish a public intent — anyone in your community can respond and join.',
   'community', NULL, ARRAY['ask_for_help','organize_group']),

  ('invite_contact',
   'Invite Contact',
   'Invite friends to your community — earns invite-bonus and grows your network.',
   'community', NULL, ARRAY['grow_network','invite_friend']),

  -- Tier 4: autopilot + advanced
  ('autopilot',
   'Autopilot',
   'Vitana proposes batched actions you can accept in one tap — frees you from micro-decisions.',
   'community', NULL, ARRAY['save_time','delegate_routine']),

  ('memory_garden',
   'Memory Garden',
   'See and curate what Vitana has learned about you — full transparency.',
   'community', NULL, ARRAY['review_memory','correct_facts']),

  ('marketplace',
   'Marketplace',
   'Discover services and products curated for your goal (coaches, supplements, workshops).',
   'community', NULL, ARRAY['find_service','find_product']),

  -- Tier 5: deep features
  ('scheduling',
   'Activity Plan',
   'Generate a structured plan (route, time, kit list) for a match-confirmed activity.',
   'community', NULL, ARRAY['plan_activity','organize_outing'])
ON CONFLICT (capability_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  required_role = EXCLUDED.required_role,
  required_integrations = EXCLUDED.required_integrations,
  helpful_for_intents = EXCLUDED.helpful_for_intents,
  enabled = true,
  updated_at = now();

-- ---------------------------------------------------------------
-- Documentation
-- ---------------------------------------------------------------

COMMENT ON TABLE system_capabilities IS
  'B0e.1 (orb-live-refactor): global catalog of features Vitana can introduce. '
  'The Feature Discovery Coach (B0e.2 provider) reads this to pick ONE unexplored '
  'capability per turn. Marketing-dump failure mode forbidden — coach NEVER lists.';

COMMENT ON TABLE user_capability_awareness IS
  'B0e.1 (orb-live-refactor): per-user state ladder for each known capability. '
  'awareness_state advances unknown → introduced → seen → tried → completed (→ mastered) '
  'OR settles at dismissed when the user says no. The ranker reads dismiss_count + '
  'last_introduced_at to dampen recently-surfaced or twice-rejected capabilities.';

COMMENT ON COLUMN user_capability_awareness.awareness_state IS
  'Ladder: unknown / introduced / seen / tried / completed / dismissed / mastered. '
  'Provider transitions: unknown → introduced (coach mentioned). introduced → seen '
  '(user opened related screen). seen → tried (user invoked). tried → completed '
  '(user finished a meaningful flow). completed → mastered (sustained successful use). '
  'Any state → dismissed when the user explicitly declines.';
