-- Hotfix for 20260504000600 — the resolve_recipient_candidates body had
-- UNION ALL legs WITHOUT parentheses around the ORDER BY/LIMIT, which
-- silently failed (psql -f doesn't ON_ERROR_STOP) leaving the function
-- definition rolled back to the pre-D3 version.
--
-- This migration re-applies the wrapper with parenthesised UNION ALL legs,
-- mirroring the original 20260427000900_resolve_recipient_rpc_fix.sql hotfix.

CREATE OR REPLACE FUNCTION public.resolve_recipient_candidates(
  p_actor  uuid,
  p_token  text,
  p_limit  int  DEFAULT 5,
  p_global boolean DEFAULT false
) RETURNS TABLE (
  user_id      uuid,
  vitana_id    text,
  display_name text,
  avatar_url   text,
  score        numeric,
  reason       text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token        text;
  v_actor_tenant uuid;
BEGIN
  -- VTID-DANCE-D3: pre-normalize spoken tokens (digit words -> numerals).
  v_token := public.vitana_id_normalize_token(p_token);

  IF v_token IS NULL OR v_token = '' THEN
    RETURN;
  END IF;

  IF NOT p_global THEN
    SELECT (au.raw_app_meta_data ->> 'active_tenant_id')::uuid
      INTO v_actor_tenant
      FROM auth.users au
     WHERE au.id = p_actor;

    IF v_actor_tenant IS NULL THEN
      SELECT m.tenant_id INTO v_actor_tenant
        FROM public.memberships m
       WHERE m.user_id = p_actor
         AND m.status = 'active'
       ORDER BY m.created_at ASC
       LIMIT 1;
    END IF;

    IF v_actor_tenant IS NULL THEN
      RETURN;
    END IF;
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT
      p.user_id,
      p.vitana_id,
      p.display_name,
      p.avatar_url,
      CASE
        WHEN p.vitana_id = v_token THEN 1.00::numeric
        WHEN EXISTS (
          SELECT 1 FROM public.handle_aliases ha
           WHERE ha.user_id = p.user_id
             AND ha.old_handle = v_token
        ) THEN 0.92::numeric
        WHEN similarity(lower(public.unaccent(p.display_name)), v_token) > 0.4
          THEN (0.55 + similarity(lower(public.unaccent(p.display_name)), v_token) * 0.30)::numeric
        ELSE 0.00::numeric
      END AS base_score,
      CASE
        WHEN p.vitana_id = v_token THEN 'vitana_id_exact'
        WHEN EXISTS (
          SELECT 1 FROM public.handle_aliases ha
           WHERE ha.user_id = p.user_id
             AND ha.old_handle = v_token
        ) THEN 'legacy_handle'
        WHEN similarity(lower(public.unaccent(p.display_name)), v_token) > 0.4
          THEN 'fuzzy_name'
        ELSE 'none'
      END AS base_reason
    FROM public.profiles p
    WHERE p.user_id <> p_actor
      AND (
        p_global = true
        OR EXISTS (
          SELECT 1 FROM public.memberships m
           WHERE m.user_id = p.user_id
             AND m.tenant_id = v_actor_tenant
             AND m.status = 'active'
        )
      )
  ),
  scored AS (
    SELECT
      b.user_id,
      b.vitana_id,
      b.display_name,
      b.avatar_url,
      b.base_score
        + CASE
            WHEN b.base_reason IN ('fuzzy_name', 'none')
             AND b.display_name IS NOT NULL
             AND length(v_token) >= 3
             AND metaphone(lower(public.unaccent(split_part(b.display_name, ' ', 1))), 6)
               = metaphone(v_token, 6)
            THEN 0.10
            ELSE 0
          END
        + CASE
            WHEN EXISTS (
              SELECT 1
                FROM (
                  (SELECT cm.sender_id AS peer FROM public.chat_messages cm
                    WHERE cm.receiver_id = p_actor
                    ORDER BY cm.created_at DESC LIMIT 200)
                  UNION ALL
                  (SELECT cm.receiver_id AS peer FROM public.chat_messages cm
                    WHERE cm.sender_id = p_actor
                    ORDER BY cm.created_at DESC LIMIT 200)
                ) recent
               WHERE recent.peer = b.user_id
            )
            THEN 0.15
            ELSE 0
          END
        AS score,
      b.base_reason AS reason
    FROM base b
    WHERE b.base_score > 0
  )
  SELECT
    s.user_id,
    s.vitana_id,
    s.display_name,
    s.avatar_url,
    s.score,
    s.reason
  FROM scored s
  ORDER BY s.score DESC, s.display_name ASC
  LIMIT GREATEST(coalesce(p_limit, 5), 1);
END;
$$;
