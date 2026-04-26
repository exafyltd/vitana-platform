-- Vitana ID — Release A · 9/9
-- resolve_recipient_candidates(p_actor, p_token, p_limit, p_global)
--
-- The voice-resolver primitive. Given a spoken-name token, returns ranked
-- candidates with scores in [0, 1.05]. The Release B endpoint
-- POST /api/v1/users/resolve calls this with p_global = false (tenant-scoped);
-- the admin lookup endpoint calls it with p_global = true.
--
-- Ranking:
--   exact vitana_id match           -> 1.00
--   handle_aliases match            -> 0.92
--   trigram similarity > 0.4        -> 0.55 + sim * 0.30   (range 0.67-0.85)
--   metaphone match boost           -> +0.10
--   recent chat partner boost       -> +0.15  (last 200 chat_messages of actor)
--
-- Deferred to Release B: friend-in-relationship_edges boost (+0.08). The
-- relationship_edges table is owned by the gateway side; we will wire it in
-- once Release B confirms the column shape and adds the appropriate join.
--
-- Hard constraints:
--   - WHERE user_id <> p_actor                (no self-resolution; per BC contract)
--   - p_token normalized: lower(ltrim(token, '@'))   (per BC contract)
--   - tenant scope when p_global = false      (peer privacy)
--
-- The boolean p_global is gateway-controlled — the route layer must enforce
-- admin/developer role before forwarding p_global = true. The SQL function
-- trusts the flag.

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
  -- 1. Normalize the spoken token: strip leading '@', lowercase, unaccent.
  v_token := lower(public.unaccent(coalesce(p_token, '')));
  v_token := ltrim(v_token, '@');
  v_token := trim(v_token);

  IF v_token = '' THEN
    RETURN;  -- empty input, no candidates
  END IF;

  -- 2. For peer scope, find the actor's active tenant. Falls back to the
  --    first membership row if active_tenant_id is unset.
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

    -- If we still don't know the tenant, return nothing rather than leaking
    -- across tenants. Better to fail-closed.
    IF v_actor_tenant IS NULL THEN
      RETURN;
    END IF;
  END IF;

  -- 3. Build candidates and rank.
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
        -- Phonetic boost: reward names that sound like the spoken token.
        + CASE
            WHEN b.base_reason IN ('fuzzy_name', 'none')
             AND b.display_name IS NOT NULL
             AND length(v_token) >= 3
             AND metaphone(lower(public.unaccent(split_part(b.display_name, ' ', 1))), 6)
               = metaphone(v_token, 6)
            THEN 0.10
            ELSE 0
          END
        -- Recent chat partner boost: people the actor has DM'd recently.
        + CASE
            WHEN EXISTS (
              SELECT 1
                FROM (
                  SELECT cm.sender_id AS peer FROM public.chat_messages cm
                   WHERE cm.receiver_id = p_actor
                   ORDER BY cm.created_at DESC LIMIT 200
                  UNION ALL
                  SELECT cm.receiver_id AS peer FROM public.chat_messages cm
                   WHERE cm.sender_id = p_actor
                   ORDER BY cm.created_at DESC LIMIT 200
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

COMMENT ON FUNCTION public.resolve_recipient_candidates(uuid, text, int, boolean) IS
  'Voice-resolver primitive. Given a spoken-name token, returns ranked candidates. Tenant-scoped when p_global=false (peer privacy). Gateway must gate p_global=true behind admin/developer role.';
