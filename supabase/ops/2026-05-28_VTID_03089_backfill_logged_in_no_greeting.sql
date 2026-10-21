-- =============================================================================
-- VTID-03089 — One-shot backfill for the 28 users registered between
-- 2026-05-18 and now whose greeting never fired (the audit's
-- "LOGGED_IN_BUT_NO_GREETING" cohort, plus 1 "NEVER_LOGGED_IN").
-- =============================================================================
-- Runs the same logic the new trigger does, but for users whose
-- user_tenants row was inserted BEFORE the trigger existed. Idempotent
-- against welcome_chat_sent — if any of these users somehow got greeted
-- in the meantime, the WHERE clause skips them.
--
-- Cutoff: 2026-05-18T22:30:00Z (just after the May-18 batch landed).
-- =============================================================================

BEGIN;

WITH cutoff AS (SELECT '2026-05-18T22:30:00Z'::timestamptz AS since),
new_users AS (
  SELECT u.user_id, u.display_name, u.vitana_id, ut.tenant_id
  FROM public.app_users u
  JOIN public.user_tenants ut
    ON ut.user_id = u.user_id
   AND ut.is_primary = true
  WHERE u.created_at >= (SELECT since FROM cutoff)
    AND COALESCE(u.welcome_chat_sent, false) = false
    AND u.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
),
qualifying AS (
  SELECT
    nu.user_id, nu.display_name, nu.tenant_id, nu.vitana_id,
    (SELECT COUNT(*) FROM public.user_tenants ut3
      WHERE ut3.tenant_id = nu.tenant_id
        AND ut3.user_id <> nu.user_id
        AND ut3.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
    ) AS member_count
  FROM new_users nu
),
recipients AS (
  SELECT
    q.user_id  AS sender_id,
    q.tenant_id,
    COALESCE(NULLIF(TRIM(q.display_name), ''), 'a new member') AS name,
    q.vitana_id AS sender_vid,
    ut.user_id AS receiver_id,
    (SELECT au.vitana_id FROM public.app_users au WHERE au.user_id = ut.user_id) AS receiver_vid
  FROM qualifying q
  JOIN public.user_tenants ut ON ut.tenant_id = q.tenant_id
  WHERE q.member_count BETWEEN 1 AND 1000
    AND ut.user_id <> q.user_id
    AND ut.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
),
inserted AS (
  INSERT INTO public.chat_messages (
    tenant_id, sender_id, receiver_id, content, message_type, metadata,
    sender_vitana_id, receiver_vitana_id
  )
  SELECT
    tenant_id, sender_id, receiver_id,
    'Hello! My name is ' || name || ' — I just joined the community and I''m excited to connect with you! 🙌',
    'text',
    jsonb_build_object(
      'source', 'welcome_chat',
      'automated', true,
      'backfill', true,
      'backfill_run', '2026-05-28',
      'seeded_by', 'VTID-03089'
    ),
    sender_vid,
    receiver_vid
  FROM recipients
  RETURNING sender_id
),
flag_updates AS (
  UPDATE public.app_users
     SET welcome_chat_sent = true
   WHERE user_id IN (SELECT DISTINCT sender_id FROM inserted)
  RETURNING user_id, (SELECT tenant_id FROM public.user_tenants WHERE user_id = app_users.user_id AND is_primary = true LIMIT 1) AS tenant_id
)
SELECT
  (SELECT COUNT(*) FROM inserted)        AS total_messages_inserted,
  (SELECT COUNT(DISTINCT sender_id) FROM inserted) AS senders_fired,
  (SELECT COUNT(*) FROM flag_updates)    AS users_flagged_sent;

-- Auto-enrol the now-flagged users into any system chat groups in their
-- tenant (cap 100 per group). ON CONFLICT keeps repeat runs harmless.
INSERT INTO public.chat_group_members (group_id, user_id, tenant_id, role)
SELECT g.id, au.user_id, ut.tenant_id, 'member'
FROM public.app_users au
JOIN public.user_tenants ut
  ON ut.user_id = au.user_id
 AND ut.is_primary = true
JOIN public.chat_groups g
  ON g.tenant_id = ut.tenant_id
 AND g.is_system = true
WHERE au.welcome_chat_sent = true
  AND au.created_at >= '2026-05-18T22:30:00Z'::timestamptz
  AND au.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
  AND (SELECT COUNT(*) FROM public.chat_group_members m WHERE m.group_id = g.id) < 100
ON CONFLICT (group_id, user_id) DO NOTHING;

COMMIT;

-- Tally verification.
SELECT
  (SELECT COUNT(*) FROM public.chat_messages
     WHERE metadata->>'backfill_run' = '2026-05-28'
  ) AS rows_from_2026_05_28_backfill,
  (SELECT COUNT(*) FROM public.app_users u
     WHERE u.created_at >= '2026-05-18T22:30:00Z'::timestamptz
       AND COALESCE(u.welcome_chat_sent, false) = false
       AND u.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
  ) AS users_still_unflagged_after_run,
  (SELECT COUNT(*) FROM public.chat_group_members m
     JOIN public.chat_groups g ON g.id = m.group_id
    WHERE g.name = '🎆 FIRST 100'
  ) AS first_100_members_now;
