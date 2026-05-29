-- =============================================================================
-- VTID-03089 — Post-trigger audit
-- =============================================================================
-- Read-only. Confirms:
--   1. The new trigger is installed and enabled.
--   2. No user has duplicate hellos from any single sender.
--   3. All users registered since 2026-05-18 have welcome_chat_sent=true.
--   4. FIRST 100 group has expected member count and no duplicate members.
-- =============================================================================

-- 1) Trigger is present + enabled.
SELECT '─── trigger state ───' AS section;
SELECT tgname, tgenabled
  FROM pg_trigger
 WHERE tgname = 'welcome_chat_on_primary_membership';

-- 2) Duplicate detection: any (sender, receiver) pair with > 1 welcome_chat row.
SELECT '─── duplicate hellos (should be 0 rows) ───' AS section;
SELECT sender_id, receiver_id, COUNT(*) AS dupes
  FROM public.chat_messages
 WHERE metadata->>'source' = 'welcome_chat'
 GROUP BY sender_id, receiver_id
HAVING COUNT(*) > 1
 ORDER BY dupes DESC
 LIMIT 50;

-- 3) Recent registrations: how many still have welcome_chat_sent=false?
SELECT '─── unflagged recent users (target 0) ───' AS section;
SELECT
  (SELECT COUNT(*) FROM public.app_users u
    WHERE u.created_at >= '2026-05-16T22:00:00Z'::timestamptz
      AND COALESCE(u.welcome_chat_sent, false) = false
      AND u.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
  ) AS unflagged_since_2026_05_17,
  (SELECT COUNT(*) FROM public.app_users u
    WHERE u.created_at >= '2026-05-18T22:30:00Z'::timestamptz
      AND COALESCE(u.welcome_chat_sent, false) = true
      AND u.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
  ) AS flagged_since_2026_05_19;

-- 4) FIRST 100 group state.
SELECT '─── FIRST 100 membership ───' AS section;
SELECT
  g.id, g.name,
  (SELECT COUNT(*) FROM public.chat_group_members m WHERE m.group_id = g.id) AS member_count,
  (SELECT COUNT(*) FROM (
     SELECT user_id, COUNT(*) AS n FROM public.chat_group_members
      WHERE group_id = g.id GROUP BY user_id HAVING COUNT(*) > 1
   ) dupes
  ) AS duplicate_memberships
FROM public.chat_groups g
WHERE g.name = '🎆 FIRST 100';
