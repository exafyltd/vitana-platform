-- VTID-03108 (Item 3): "No hardcoding when it comes to intelligence."
--
-- Adds a context-aware pedagogical order to `system_capabilities`. The
-- Teacher's `pickCapability` used to fall back to ALPHABETICAL tie-break
-- when multiple unknown capabilities were eligible — so every new
-- community user got "activity_match" (alphabetically first) as their
-- first taught feature, instead of the foundational concepts (Five
-- Pillars, Vitana ID, the daily loop) that the manuals teach first.
--
-- This migration:
--   1. Adds `pedagogical_order INTEGER` (lower = earlier in the
--      curriculum). NULL means "no preferred order; alphabetical
--      tie-break still applies after this column is sorted".
--   2. Seeds a sensible default curriculum so the system has data on
--      day-1. Operators tune the order live via the system_capabilities
--      table (or a Command Hub editor in a later slice) — the logic in
--      `pickCapability` reads the column, never a hardcoded list.
--
-- Curriculum philosophy: teach foundations first (what the platform is +
-- how the user identifies themself), then engagement primitives (daily
-- loop, diary, reminders, calendar), then community + advanced.

ALTER TABLE system_capabilities
  ADD COLUMN IF NOT EXISTS pedagogical_order INTEGER;

COMMENT ON COLUMN system_capabilities.pedagogical_order IS
  'VTID-03108: lower = earlier in the Teacher curriculum. The Teacher provider sorts unknown-state capabilities by this column ASC before alphabetical tie-break, so first-time users meet foundational concepts before advanced features. NULL = no preference (sorts last, then alphabetical).';

-- Foundations (00-concepts manuals) — what Vitanaland is + who the user is.
UPDATE system_capabilities SET pedagogical_order = 10
  WHERE capability_key = 'five_pillars'        AND pedagogical_order IS NULL;
UPDATE system_capabilities SET pedagogical_order = 20
  WHERE capability_key = 'journey_daily_loop'  AND pedagogical_order IS NULL;
UPDATE system_capabilities SET pedagogical_order = 30
  WHERE capability_key = 'vitana_id'           AND pedagogical_order IS NULL;
UPDATE system_capabilities SET pedagogical_order = 40
  WHERE capability_key = 'did_you_know'        AND pedagogical_order IS NULL;

-- The Index (the platform's measurement layer the user will see daily).
UPDATE system_capabilities SET pedagogical_order = 50
  WHERE capability_key = 'vitana_index'        AND pedagogical_order IS NULL;
UPDATE system_capabilities SET pedagogical_order = 60
  WHERE capability_key = 'life_compass'        AND pedagogical_order IS NULL;

-- Daily-loop primitives (capture, plan, reflect).
UPDATE system_capabilities SET pedagogical_order = 70
  WHERE capability_key = 'diary_entry'         AND pedagogical_order IS NULL;
UPDATE system_capabilities SET pedagogical_order = 80
  WHERE capability_key = 'reminders'           AND pedagogical_order IS NULL;
UPDATE system_capabilities SET pedagogical_order = 90
  WHERE capability_key = 'calendar_connect'    AND pedagogical_order IS NULL;
UPDATE system_capabilities SET pedagogical_order = 95
  WHERE capability_key = 'scheduling'          AND pedagogical_order IS NULL;
UPDATE system_capabilities SET pedagogical_order = 100
  WHERE capability_key = 'biomarkers'          AND pedagogical_order IS NULL;
UPDATE system_capabilities SET pedagogical_order = 110
  WHERE capability_key = 'memory_garden'       AND pedagogical_order IS NULL;

-- Community + connection layer.
UPDATE system_capabilities SET pedagogical_order = 120
  WHERE capability_key = 'community_post'      AND pedagogical_order IS NULL;
UPDATE system_capabilities SET pedagogical_order = 130
  WHERE capability_key = 'community_intent'    AND pedagogical_order IS NULL;
UPDATE system_capabilities SET pedagogical_order = 140
  WHERE capability_key = 'activity_match'      AND pedagogical_order IS NULL;
UPDATE system_capabilities SET pedagogical_order = 150
  WHERE capability_key = 'events'              AND pedagogical_order IS NULL;
UPDATE system_capabilities SET pedagogical_order = 160
  WHERE capability_key = 'live_room'           AND pedagogical_order IS NULL;
UPDATE system_capabilities SET pedagogical_order = 170
  WHERE capability_key = 'invite_contact'      AND pedagogical_order IS NULL;

-- Advanced (autopilot, marketplace) — last because they assume the user
-- already understands the platform.
UPDATE system_capabilities SET pedagogical_order = 200
  WHERE capability_key = 'autopilot'           AND pedagogical_order IS NULL;
UPDATE system_capabilities SET pedagogical_order = 210
  WHERE capability_key = 'marketplace'         AND pedagogical_order IS NULL;

-- Index for the ORDER BY in pickCapability so the Teacher hot path
-- doesn't degrade as the catalog grows.
CREATE INDEX IF NOT EXISTS system_capabilities_pedagogical_order_idx
  ON system_capabilities (pedagogical_order ASC NULLS LAST, capability_key ASC)
  WHERE enabled = true;
