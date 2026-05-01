-- Resolver fix: promote frequent chat partners into the candidate set
-- even when the spoken token doesn't trigram-match strongly.
--
-- Symptom: voice user said "send a message to Maria Maksina, I think
-- it's maria6" — first attempt failed ("can't find that user"), retry
-- succeeded. Root cause was twofold:
--
--   1. Gemini Live didn't always call resolve_recipient (fixed in
--      gateway/orb-live.ts, paired PR).
--   2. The SQL only surfaced candidates with trigram similarity > 0.4.
--      ASR mishears + foreign names regularly fall below that line, so
--      a frequent chat partner could be invisible. The +0.15 chat boost
--      only applied AFTER a name match — never enough to pull a
--      candidate INTO the result set.
--
-- This migration relaxes the trigram threshold to 0.15 for users the
-- actor has chatted with in the last 200 chat_messages. The base score
-- is also lowered (0.45 instead of 0.55) so chat-peer matches don't
-- outrank exact name matches, and the existing +0.15 chat boost still
-- applies on top — making frequent peers consistently surface as
-- candidates without crowding out better matches.
--
-- Worst-case behavior: when ASR is decent ("maria maksina" → similarity
-- ~0.95), the existing 0.4-threshold path still applies and the chat
-- peer gets the higher 0.55 + 0.30*sim baseline, not the 0.45 path.
-- The relaxed path only kicks in when the regular path would have
-- failed to return them.

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
    RETURN;
  END IF;

  -- 2. Tenant scoping (unchanged).
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

  -- 3. Build candidates and rank.
  RETURN QUERY
  -- Pre-compute the actor's recent chat-peer set ONCE, used both for
  -- the relaxed-threshold inclusion AND for the +0.15 score boost.
  WITH chat_peers AS (
    SELECT DISTINCT peer
      FROM (
        SELECT cm.sender_id   AS peer FROM public.chat_messages cm
         WHERE cm.receiver_id = p_actor
         ORDER BY cm.created_at DESC LIMIT 200
        UNION ALL
        SELECT cm.receiver_id AS peer FROM public.chat_messages cm
         WHERE cm.sender_id   = p_actor
         ORDER BY cm.created_at DESC LIMIT 200
      ) recent
     WHERE peer IS NOT NULL
  ),
  base AS (
    SELECT
      p.user_id,
      p.vitana_id,
      p.display_name,
      p.avatar_url,
      EXISTS (SELECT 1 FROM chat_peers cp WHERE cp.peer = p.user_id) AS is_chat_peer,
      similarity(lower(public.unaccent(coalesce(p.display_name, ''))), v_token) AS sim,
      CASE
        WHEN p.vitana_id = v_token THEN 1.00::numeric
        WHEN EXISTS (
          SELECT 1 FROM public.handle_aliases ha
           WHERE ha.user_id = p.user_id
             AND ha.old_handle = v_token
        ) THEN 0.92::numeric
        WHEN similarity(lower(public.unaccent(coalesce(p.display_name, ''))), v_token) > 0.4
          THEN (0.55 + similarity(lower(public.unaccent(coalesce(p.display_name, ''))), v_token) * 0.30)::numeric
        -- NEW: relaxed threshold for chat peers — surfaces foreign-name
        -- ASR slips that the regular 0.4 threshold would drop. Baseline
        -- 0.45 keeps these below exact / alias / strong-fuzzy matches.
        WHEN EXISTS (SELECT 1 FROM chat_peers cp WHERE cp.peer = p.user_id)
         AND similarity(lower(public.unaccent(coalesce(p.display_name, ''))), v_token) > 0.15
          THEN (0.45 + similarity(lower(public.unaccent(coalesce(p.display_name, ''))), v_token) * 0.30)::numeric
        ELSE 0.00::numeric
      END AS base_score,
      CASE
        WHEN p.vitana_id = v_token THEN 'vitana_id_exact'
        WHEN EXISTS (
          SELECT 1 FROM public.handle_aliases ha
           WHERE ha.user_id = p.user_id
             AND ha.old_handle = v_token
        ) THEN 'legacy_handle'
        WHEN similarity(lower(public.unaccent(coalesce(p.display_name, ''))), v_token) > 0.4
          THEN 'fuzzy_name'
        WHEN EXISTS (SELECT 1 FROM chat_peers cp WHERE cp.peer = p.user_id)
         AND similarity(lower(public.unaccent(coalesce(p.display_name, ''))), v_token) > 0.15
          THEN 'fuzzy_chat_peer'
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
        -- Phonetic boost (unchanged).
        + CASE
            WHEN b.base_reason IN ('fuzzy_name', 'fuzzy_chat_peer', 'none')
             AND b.display_name IS NOT NULL
             AND length(v_token) >= 3
             AND metaphone(lower(public.unaccent(split_part(b.display_name, ' ', 1))), 6)
               = metaphone(v_token, 6)
            THEN 0.10
            ELSE 0
          END
        -- Recent chat partner boost (unchanged).
        + CASE
            WHEN b.is_chat_peer THEN 0.15
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
  'Voice-resolver primitive. Given a spoken-name token, returns ranked candidates. Tenant-scoped when p_global=false. Relaxed trigram threshold (0.15 vs 0.4) for users in the actor''s recent chat-peer set so frequent contacts surface even with ASR slips.';
