-- =============================================================================
-- VTID-03089 — Hello-message backfill (corrected cutoff)
-- =============================================================================
-- The first seed used a too-late cutoff (start of May 19 CET) and matched
-- zero May-18-registered users. This run widens the cutoff to start of
-- May 18 CET (2026-05-17T22:00:00Z UTC) so the 28 users from yesterday
-- (and any registered today) all fire their hello messages.
--
-- Idempotent — only touches users where welcome_chat_sent is still false.
-- =============================================================================

BEGIN;

WITH cutoff AS (SELECT '2026-05-17T22:00:00Z'::timestamptz AS since),
new_users AS (
  SELECT u.user_id, u.display_name, ut.tenant_id
  FROM public.app_users u
  JOIN public.user_tenants ut
    ON ut.user_id = u.user_id
   AND ut.is_primary = true
  WHERE u.created_at >= (SELECT since FROM cutoff)
    AND COALESCE(u.welcome_chat_sent, false) = false
    AND u.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
),
qualifying AS (
  SELECT nu.user_id, nu.display_name, nu.tenant_id,
    (SELECT COUNT(*) FROM public.user_tenants ut3
      WHERE ut3.tenant_id = nu.tenant_id
        AND ut3.user_id <> nu.user_id
        AND ut3.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
    ) AS member_count
  FROM new_users nu
),
recipients AS (
  SELECT
    q.user_id AS sender_id,
    q.tenant_id,
    COALESCE(NULLIF(TRIM(q.display_name), ''), 'a new member') AS name,
    ut.user_id AS receiver_id
  FROM qualifying q
  JOIN public.user_tenants ut ON ut.tenant_id = q.tenant_id
  WHERE q.member_count BETWEEN 1 AND 1000
    AND ut.user_id <> q.user_id
    AND ut.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
),
inserted AS (
  INSERT INTO public.chat_messages
    (tenant_id, sender_id, receiver_id, content, message_type, metadata)
  SELECT
    tenant_id,
    sender_id,
    receiver_id,
    'Hello! My name is ' || name || ' — I just joined the community and I''m excited to connect with you! 🙌',
    'text',
    jsonb_build_object(
      'source', 'welcome_chat',
      'automated', true,
      'backfill', true,
      'backfill_run', '2026-05-19',
      'seeded_by', 'VTID-03089'
    )
  FROM recipients
  RETURNING sender_id
),
inserted_summary AS (
  SELECT sender_id, COUNT(*) AS n FROM inserted GROUP BY sender_id
)
UPDATE public.app_users
SET welcome_chat_sent = true
WHERE user_id IN (SELECT sender_id FROM inserted_summary);

COMMIT;

-- Tally for the workflow log.
SELECT
  (SELECT COUNT(*) FROM public.chat_messages
     WHERE metadata->>'backfill_run' = '2026-05-19'
  ) AS hello_backfill_rows_total,
  (SELECT COUNT(DISTINCT sender_id) FROM public.chat_messages
     WHERE metadata->>'backfill_run' = '2026-05-19'
  ) AS senders_fired,
  (SELECT COUNT(*) FROM public.app_users u
     WHERE u.created_at >= '2026-05-17T22:00:00Z'::timestamptz
       AND COALESCE(u.welcome_chat_sent, false) = false
  ) AS still_unsent_after_run;
