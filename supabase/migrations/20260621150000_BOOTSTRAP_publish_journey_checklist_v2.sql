-- BOOTSTRAP — publish the v2 Guided Journey curriculum (durable source of truth).
--
-- impact-allow-solo-migration: pure data backfill (status draft→published). No
-- code change needed — narrate_guided_session already queries status='published';
-- this migration only flips existing rows to the state the code expects.
--
-- WHY: the seed (20260608170100_VTID_03277_journey_checklist_seed) and the
-- onboarding sessions (20260613003000_BOOTSTRAP_first_time_onboarding_sessions)
-- both INSERT their topics with status='draft'. Publishing the curriculum was
-- only ever done as a manual SQL step in the dashboard — it was never captured
-- in a migration. As a result, any re-apply / re-seed silently reverted ALL 254
-- topics to 'draft'. narrate_guided_session filters on status='published', so it
-- then saw ZERO rows and degraded to a generic one-line "Welcome to Vitanaland"
-- — the ORB could not play ANY guided session (e.g. "play session 1" produced a
-- single welcome sentence instead of the authored T251 script).
--
-- This migration makes "published" the tracked source of truth. It runs after
-- both seed migrations (later timestamp), is idempotent, and re-publishes the
-- curriculum on every apply so the draft-revert can no longer take the ORB down.
-- Scope: ONLY the migration-seeded curriculum rows (topic_id T001..T254 — the
-- exact set inserted by the seed + onboarding migrations). This deliberately
-- does NOT blanket-publish every v2 row: any topic an admin later creates/edits
-- in the Command Hub uses a different id scheme and must stay 'draft' until it
-- is reviewed, so unreviewed content is never narrated live by this backfill.
UPDATE journey_checklist_topics
SET status = 'published',
    updated_at = now()
WHERE curriculum_version = 'v2'
  AND topic_id ~ '^T[0-9]+$'
  AND status <> 'published';

INSERT INTO journey_checklist_audit (action, detail)
VALUES (
  'publish',
  'Published v2 curriculum (all topics) — durable migration replacing the manual publish step; prevents narrate_guided_session degrading when a re-seed reverts status to draft.'
);
