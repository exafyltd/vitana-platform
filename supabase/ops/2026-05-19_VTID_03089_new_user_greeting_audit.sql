-- =============================================================================
-- VTID-03089 — Audit: did new users from the last 3 days send their greeting?
-- =============================================================================
-- Read-only. For every user registered since 2026-05-17 CET, shows:
--   * welcome_chat_sent flag (target of the idempotency gate)
--   * how many welcome_chat rows they actually sent (sender_id count)
--   * how many recipients they should have had (other tenant members)
--   * last_sign_in_at on auth.users — null/old = they never hit /auth/login,
--     which is the most likely root cause if the rule is wired but not firing
--   * whether they're in a primary tenant at all
-- =============================================================================

WITH cutoff AS (SELECT '2026-05-16T22:00:00Z'::timestamptz AS since),
candidates AS (
  SELECT
    u.user_id,
    u.display_name,
    u.email,
    u.welcome_chat_sent,
    u.created_at,
    (SELECT ut.tenant_id FROM public.user_tenants ut
       WHERE ut.user_id = u.user_id AND ut.is_primary = true LIMIT 1
    ) AS primary_tenant_id,
    (SELECT COUNT(*) FROM public.user_tenants ut
       WHERE ut.user_id = u.user_id
    ) AS user_tenants_rows,
    (SELECT au.last_sign_in_at FROM auth.users au WHERE au.id = u.user_id) AS last_sign_in_at,
    (SELECT au.email_confirmed_at FROM auth.users au WHERE au.id = u.user_id) AS email_confirmed_at,
    (SELECT au.created_at FROM auth.users au WHERE au.id = u.user_id) AS auth_created_at,
    (SELECT COUNT(*) FROM public.chat_messages cm
       WHERE cm.sender_id = u.user_id
         AND cm.metadata->>'source' = 'welcome_chat'
    ) AS welcome_msgs_sent
  FROM public.app_users u
  WHERE u.created_at >= (SELECT since FROM cutoff)
)
SELECT
  c.user_id,
  c.display_name,
  c.email,
  c.welcome_chat_sent,
  c.welcome_msgs_sent,
  c.primary_tenant_id IS NOT NULL AS has_primary_tenant,
  c.user_tenants_rows,
  (c.created_at AT TIME ZONE 'Europe/Berlin')::timestamp(0) AS app_users_created_cet,
  (c.auth_created_at AT TIME ZONE 'Europe/Berlin')::timestamp(0) AS auth_created_cet,
  (c.email_confirmed_at AT TIME ZONE 'Europe/Berlin')::timestamp(0) AS email_confirmed_cet,
  (c.last_sign_in_at AT TIME ZONE 'Europe/Berlin')::timestamp(0) AS last_sign_in_cet,
  CASE
    WHEN c.welcome_chat_sent AND c.welcome_msgs_sent > 0
      THEN 'OK_sent_and_flagged'
    WHEN c.welcome_chat_sent AND c.welcome_msgs_sent = 0
      THEN 'FLAGGED_BUT_NEVER_SENT'
    WHEN NOT c.welcome_chat_sent AND c.last_sign_in_at IS NULL
      THEN 'NEVER_LOGGED_IN'
    WHEN NOT c.welcome_chat_sent AND c.last_sign_in_at IS NOT NULL
      THEN 'LOGGED_IN_BUT_NO_GREETING'
    ELSE 'OTHER'
  END AS verdict
FROM candidates c
ORDER BY c.created_at DESC;

-- Summary buckets.
WITH cutoff AS (SELECT '2026-05-16T22:00:00Z'::timestamptz AS since),
buckets AS (
  SELECT
    CASE
      WHEN u.welcome_chat_sent AND (SELECT COUNT(*) FROM public.chat_messages cm WHERE cm.sender_id = u.user_id AND cm.metadata->>'source' = 'welcome_chat') > 0
        THEN 'OK_sent_and_flagged'
      WHEN u.welcome_chat_sent
        THEN 'FLAGGED_BUT_NEVER_SENT'
      WHEN (SELECT au.last_sign_in_at FROM auth.users au WHERE au.id = u.user_id) IS NULL
        THEN 'NEVER_LOGGED_IN'
      WHEN (SELECT au.last_sign_in_at FROM auth.users au WHERE au.id = u.user_id) IS NOT NULL
        THEN 'LOGGED_IN_BUT_NO_GREETING'
      ELSE 'OTHER'
    END AS verdict,
    u.user_id
  FROM public.app_users u
  WHERE u.created_at >= (SELECT since FROM cutoff)
)
SELECT verdict, COUNT(*) AS users FROM buckets GROUP BY verdict ORDER BY users DESC;
