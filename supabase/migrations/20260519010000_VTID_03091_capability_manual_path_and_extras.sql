-- VTID-03091 (Teacher PR 1) — extend system_capabilities with manual_path +
-- 11 more catalog rows so the Teacher (Feature Discovery Coach) can reach
-- 25 capabilities grounded in real Vitanaland instruction-manual pages.
--
-- Idempotent: every operation guarded by IF NOT EXISTS / ON CONFLICT.
-- Safe to re-run.
--
-- Assumes the prior migrations have been applied:
--   20260518000000_VTID_02920_capability_awareness.sql
--   20260519000000_VTID_02924_capability_awareness_events.sql
-- If either is missing this migration upserts the catalog rows but the
-- ALTER and the 11 new rows will fail. Apply the prior two FIRST.

-- ---------------------------------------------------------------
-- New column: manual_path (per-capability instruction-manual route)
-- ---------------------------------------------------------------

ALTER TABLE system_capabilities
  ADD COLUMN IF NOT EXISTS manual_path TEXT;

COMMENT ON COLUMN system_capabilities.manual_path IS
  'Relative path to the instruction-manual page for this capability '
  '(e.g. /manuals/maxina/00-concepts/life-compass). The Teacher provider '
  'navigates the user to this page when they accept the introduction. '
  'NULL means no manual page exists yet — the Teacher falls back to a '
  'spoken summary only.';

-- ---------------------------------------------------------------
-- Backfill manual_path for the 14 capabilities already seeded.
-- These keys MUST match the seed in 20260518000000.
-- ---------------------------------------------------------------

UPDATE system_capabilities SET manual_path = '/manuals/maxina/00-concepts/life-compass'
  WHERE capability_key = 'life_compass' AND manual_path IS NULL;
UPDATE system_capabilities SET manual_path = '/manuals/maxina/00-concepts/vitana-index'
  WHERE capability_key = 'vitana_index' AND manual_path IS NULL;
UPDATE system_capabilities SET manual_path = '/manuals/maxina/10-memory/diary'
  WHERE capability_key = 'diary_entry' AND manual_path IS NULL;
UPDATE system_capabilities SET manual_path = '/manuals/maxina/03-community/feed'
  WHERE capability_key = 'community_post' AND manual_path IS NULL;
UPDATE system_capabilities SET manual_path = '/manuals/maxina/06-inbox/inbox-reminder'
  WHERE capability_key = 'reminders' AND manual_path IS NULL;
UPDATE system_capabilities SET manual_path = '/manuals/maxina/12-utility/calendar'
  WHERE capability_key = 'calendar_connect' AND manual_path IS NULL;
UPDATE system_capabilities SET manual_path = '/manuals/maxina/02-home/home-matches'
  WHERE capability_key = 'activity_match' AND manual_path IS NULL;
UPDATE system_capabilities SET manual_path = '/manuals/maxina/03-community/live-rooms'
  WHERE capability_key = 'live_room' AND manual_path IS NULL;
UPDATE system_capabilities SET manual_path = '/manuals/maxina/03-community/community'
  WHERE capability_key = 'community_intent' AND manual_path IS NULL;
UPDATE system_capabilities SET manual_path = '/manuals/maxina/09-sharing/sharing'
  WHERE capability_key = 'invite_contact' AND manual_path IS NULL;
UPDATE system_capabilities SET manual_path = '/manuals/maxina/00-concepts/autopilot'
  WHERE capability_key = 'autopilot' AND manual_path IS NULL;
UPDATE system_capabilities SET manual_path = '/manuals/maxina/00-concepts/memory'
  WHERE capability_key = 'memory_garden' AND manual_path IS NULL;
UPDATE system_capabilities SET manual_path = '/manuals/maxina/04-discover/discover'
  WHERE capability_key = 'marketplace' AND manual_path IS NULL;
UPDATE system_capabilities SET manual_path = '/manuals/maxina/03-community/events'
  WHERE capability_key = 'scheduling' AND manual_path IS NULL;

-- ---------------------------------------------------------------
-- 11 new catalog rows to bring the Teacher to 25 capabilities.
-- Each one corresponds to a real on-disk manual page.
-- ---------------------------------------------------------------

INSERT INTO system_capabilities (
  capability_key, display_name, description,
  required_role, required_integrations, helpful_for_intents, manual_path
) VALUES
  ('five_pillars',
   'The Five Pillars',
   'Nutrition, Hydration, Exercise, Sleep, Mental — the five pillars that drive your Vitana Index.',
   'community', NULL, ARRAY['understand_progress','learn_index'],
   '/manuals/maxina/00-concepts/five-pillars'),

  ('journey_daily_loop',
   'Your Daily Loop',
   'The daily rhythm in Vitanaland — check in, capture, learn, share, repeat.',
   'community', NULL, ARRAY['learn_routine','understand_journey'],
   '/manuals/maxina/00-concepts/journey-daily-loop'),

  ('did_you_know',
   'Did-You-Know Tips',
   'Short, friendly tips that surface across Vitanaland to help you discover features.',
   'community', NULL, ARRAY['learn_routine','discover_feature'],
   '/manuals/maxina/00-concepts/did-you-know'),

  ('vitana_id',
   'Your Vitana ID',
   'Your handle in the Maxina community — how other members find and recognize you.',
   'community', NULL, ARRAY['identity','community'],
   '/manuals/maxina/00-concepts/vitana-id'),

  ('biomarkers',
   'Biomarkers',
   'Track lab values, vitals, and other health biomarkers — Vitana folds them into your Index.',
   'community', NULL, ARRAY['track_health','log_biomarker'],
   '/manuals/maxina/05-health/biomarkers'),

  ('events',
   'Community Events',
   'Find local and online events hosted by the Maxina community.',
   'community', NULL, ARRAY['attend_event','meet_people'],
   '/manuals/maxina/03-community/events'),

  ('groups',
   'Groups',
   'Topic-based and interest-based groups inside the Maxina community.',
   'community', NULL, ARRAY['join_group','find_community'],
   '/manuals/maxina/03-community/groups'),

  ('challenges',
   'Challenges',
   'Time-boxed community challenges — train a habit together with other Vitanaland members.',
   'community', NULL, ARRAY['build_habit','join_challenge'],
   '/manuals/maxina/03-community/challenges'),

  ('ai_companion',
   'Your AI Companion',
   'How Vitana works as your AI companion — voice, text, and the orb that connects them.',
   'community', NULL, ARRAY['learn_orb','use_voice'],
   '/manuals/maxina/07-ai/ai-companion'),

  ('timeline',
   'Your Timeline',
   'Your personal Vitanaland timeline — every diary entry, milestone, and reflection in one view.',
   'community', NULL, ARRAY['review_history','reflect'],
   '/manuals/maxina/10-memory/timeline'),

  ('wallet',
   'Your Wallet',
   'Vitanaland Wallet — rewards, subscriptions, balance, and how the Maxina economy works for you.',
   'community', NULL, ARRAY['view_wallet','understand_rewards'],
   '/manuals/maxina/08-wallet/wallet')
ON CONFLICT (capability_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  manual_path = EXCLUDED.manual_path,
  enabled = true,
  updated_at = now();
