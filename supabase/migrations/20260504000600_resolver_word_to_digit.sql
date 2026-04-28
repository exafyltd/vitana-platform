-- Dance specialized market — Phase D3 resolver helper (VTID-DANCE-D3)
-- ASR slips like "send to dragan one" → token "dragan one" (literal "one"
-- not "1") miss the exact-match path. This migration adds a lightweight
-- word-to-digit pre-normalizer in resolve_recipient_candidates() so spelled
-- numbers (0..20) collapse to digits before lookup. Also covers German
-- digit words.
--
-- Implementation: keep the canonical resolver body from
-- 20260427000800_resolve_recipient_rpc.sql intact; only replace the
-- token-normalization block at the top to use the new helper. Recent-chat
-- boost, tenant scoping, phonetic boost, fuzzy match — all preserved verbatim.

-- 1. Helper: normalize a spoken token by stripping @, lowercasing,
--    collapsing spelled-digit words 0..20 (EN + DE) to numerals, and
--    removing whitespace between base name and number.
CREATE OR REPLACE FUNCTION public.vitana_id_normalize_token(p_token text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  norm text;
BEGIN
  IF p_token IS NULL THEN
    RETURN NULL;
  END IF;
  norm := lower(public.unaccent(trim(p_token)));
  norm := ltrim(norm, '@');
  norm := regexp_replace(norm, '\m(zero|null)\M',                                                      '0', 'g');
  norm := regexp_replace(norm, '\m(one|eins)\M',                                                       '1', 'g');
  norm := regexp_replace(norm, '\m(two|zwei)\M',                                                       '2', 'g');
  norm := regexp_replace(norm, '\m(three|drei)\M',                                                     '3', 'g');
  norm := regexp_replace(norm, '\m(four|vier)\M',                                                      '4', 'g');
  norm := regexp_replace(norm, '\m(five|funf)\M',                                                      '5', 'g');
  norm := regexp_replace(norm, '\m(six|sechs)\M',                                                      '6', 'g');
  norm := regexp_replace(norm, '\m(seven|sieben)\M',                                                   '7', 'g');
  norm := regexp_replace(norm, '\m(eight|acht)\M',                                                     '8', 'g');
  norm := regexp_replace(norm, '\m(nine|neun)\M',                                                      '9', 'g');
  norm := regexp_replace(norm, '\m(ten|zehn)\M',                                                       '10', 'g');
  norm := regexp_replace(norm, '\m(eleven|elf)\M',                                                     '11', 'g');
  norm := regexp_replace(norm, '\m(twelve|zwolf)\M',                                                   '12', 'g');
  norm := regexp_replace(norm, '\m(thirteen|dreizehn)\M',                                              '13', 'g');
  norm := regexp_replace(norm, '\m(fourteen|vierzehn)\M',                                              '14', 'g');
  norm := regexp_replace(norm, '\m(fifteen|funfzehn)\M',                                               '15', 'g');
  norm := regexp_replace(norm, '\m(sixteen|sechzehn)\M',                                               '16', 'g');
  norm := regexp_replace(norm, '\m(seventeen|siebzehn)\M',                                             '17', 'g');
  norm := regexp_replace(norm, '\m(eighteen|achtzehn)\M',                                              '18', 'g');
  norm := regexp_replace(norm, '\m(nineteen|neunzehn)\M',                                              '19', 'g');
  norm := regexp_replace(norm, '\m(twenty|zwanzig)\M',                                                 '20', 'g');
  norm := regexp_replace(norm, '([a-z])\s+([0-9])', '\1\2', 'g');
  norm := regexp_replace(norm, '\s+', '', 'g');
  RETURN norm;
END;
$$;

COMMENT ON FUNCTION public.vitana_id_normalize_token(text) IS
  'Normalize an ASR-transcribed token to a candidate vitana_id: strips @, unaccents, lowercases, expands EN/DE spelled digits 0-20 to numerals, and collapses whitespace between base and number.';

-- 2. Replace resolve_recipient_candidates with the canonical body from
-- 20260427000800_resolve_recipient_rpc.sql, modifying ONLY the token
-- normalization at the top to use vitana_id_normalize_token().

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
  -- 1. Normalize the spoken token. VTID-DANCE-D3: now via vitana_id_normalize_token
  --    so spelled digits ("dragan one") collapse to numerals ("dragan1") before
  --    the exact-match path.
  v_token := public.vitana_id_normalize_token(p_token);

  IF v_token IS NULL OR v_token = '' THEN
    RETURN;
  END IF;

  -- 2. For peer scope, find the actor's active tenant.
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

  -- 3. Build candidates and rank. (Body verbatim from canonical
  --    20260427000800_resolve_recipient_rpc.sql — preserved exactly.)
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
  'VTID-01967 + VTID-DANCE-D3. Voice-resolver primitive. Pre-normalizes p_token via vitana_id_normalize_token() so spelled digits (one→1) match exactly. Recent-chat + phonetic boosts preserved.';
