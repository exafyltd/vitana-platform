-- BOOTSTRAP: Canonical people search for the voice resolver.
--
-- Symptom (reported via ORB voice):
--   "Send a text message to Maria Maxina" -> "I can't find that user", even
--   though Mariia Maksina IS a registered, community-visible account in the
--   speaker's own tenant.
--
-- Root cause (data-verified against prod):
--   resolve_recipient_candidates() built its candidate pool from
--   public.profiles and then HARD-FILTERED to rows that have an `active`
--   row in public.memberships for the actor's tenant. But the canonical
--   messaging tenant lives on public.app_users.tenant_id, and ~20% of
--   registered users (17/98 app_users at time of writing, including BOTH
--   "Mariia Maksina" accounts) have NO membership row at all. Those users
--   were silently dropped from the candidate set BEFORE any name matching
--   ran — so they were unreachable no matter how their name was spelled.
--   The resolver instead surfaced unrelated chat-peers ("Marion", "Marc")
--   via the relaxed trigram lane, making it look like a fuzzy-match problem
--   when it was really an eligibility problem.
--
--   Secondary issues fixed here:
--     * Name search only looked at profiles.display_name. Names also live in
--       app_users.display_name, global_community_profiles.display_name,
--       profiles.full_name and first/last. We now coalesce across all of
--       them and score the BEST form.
--     * No exact lanes for vitana_id-as-spoken, @handle, or email.
--     * The 0.4 trigram floor dropped foreign-name ASR slips for anyone the
--       actor had not already chatted with. Relaxed to 0.2 for everyone,
--       with same-tenant + chat-peer + phonetic boosts used for RANKING
--       (not eligibility) so exact/strong matches still win.
--     * When the actor's tenant could not be resolved the function used to
--       RETURN empty (zero candidates). It now degrades to a global search
--       instead of returning nothing.
--
-- Tenant model: p_global=false keeps results scoped to the actor's tenant
-- (now resolved from auth meta -> app_users.tenant_id -> memberships, in that
-- order). p_global=true searches every tenant but ranks the actor's own
-- tenant first via a +0.15 same-tenant boost. The voice tools call with
-- p_global=true so a speaker can reach a registered member who happens to sit
-- in the sibling tenant, while local members still rank above them.

-- Trigram indexes on the real name columns (cheap now, future-proofs growth).
CREATE INDEX IF NOT EXISTS idx_app_users_display_name_trgm
  ON public.app_users USING gin (lower(coalesce(display_name, '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_profiles_display_name_trgm
  ON public.profiles USING gin (lower(coalesce(display_name, '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_profiles_full_name_trgm
  ON public.profiles USING gin (lower(coalesce(full_name, '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_gcp_display_name_trgm
  ON public.global_community_profiles USING gin (lower(coalesce(display_name, '')) gin_trgm_ops);

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
  v_token := trim(ltrim(v_token, '@'));
  IF v_token = '' THEN
    RETURN;
  END IF;

  -- 2. Resolve the actor's tenant. Canonical messaging tenant is
  --    app_users.tenant_id; auth metadata is the fast path; memberships is a
  --    last resort. We do NOT return early when this is null any more — an
  --    unknown tenant degrades to a global search rather than zero results.
  SELECT (au.raw_app_meta_data ->> 'active_tenant_id')::uuid
    INTO v_actor_tenant
    FROM auth.users au
   WHERE au.id = p_actor;

  IF v_actor_tenant IS NULL THEN
    SELECT a.tenant_id INTO v_actor_tenant
      FROM public.app_users a
     WHERE a.user_id = p_actor;
  END IF;

  IF v_actor_tenant IS NULL THEN
    SELECT m.tenant_id INTO v_actor_tenant
      FROM public.memberships m
     WHERE m.user_id = p_actor
       AND m.status = 'active'
     ORDER BY m.created_at ASC
     LIMIT 1;
  END IF;

  RETURN QUERY
  WITH chat_peers AS (
    -- Recent two-way chat partners, used for a RANKING boost only.
    SELECT DISTINCT peer
      FROM (
        (SELECT cm.sender_id   AS peer FROM public.chat_messages cm
          WHERE cm.receiver_id = p_actor
          ORDER BY cm.created_at DESC LIMIT 200)
        UNION ALL
        (SELECT cm.receiver_id AS peer FROM public.chat_messages cm
          WHERE cm.sender_id   = p_actor
          ORDER BY cm.created_at DESC LIMIT 200)
      ) recent
     WHERE peer IS NOT NULL
  ),
  cand AS (
    -- Candidate pool = every active app_users row (the canonical account +
    -- tenant table). NO membership gate. Names coalesced across all stores.
    SELECT
      au.user_id,
      au.vitana_id,
      au.tenant_id,
      g.avatar_url,
      coalesce(
        nullif(trim(au.display_name), ''),
        nullif(trim(p.display_name), ''),
        nullif(trim(g.display_name), ''),
        nullif(trim(p.full_name), ''),
        nullif(trim(concat_ws(' ', p.first_name, p.last_name)), '')
      ) AS name,
      lower(coalesce(p.handle, '')) AS handle,
      lower(coalesce(au.email, '')) AS email,
      EXISTS (SELECT 1 FROM chat_peers cp WHERE cp.peer = au.user_id) AS is_chat_peer
    FROM public.app_users au
    LEFT JOIN public.profiles p ON p.user_id = au.user_id
    LEFT JOIN public.global_community_profiles g ON g.user_id = au.user_id
    WHERE au.user_id <> p_actor
      AND coalesce(au.status, 'active') = 'active'
  ),
  scored AS (
    SELECT
      c.user_id,
      c.vitana_id,
      c.name AS display_name,
      c.avatar_url,
      c.is_chat_peer,
      c.tenant_id,
      similarity(lower(public.unaccent(coalesce(c.name, ''))), v_token) AS name_sim,
      CASE
        WHEN lower(coalesce(c.vitana_id, '')) = v_token THEN 1.00::numeric
        WHEN c.handle <> '' AND c.handle = v_token THEN 0.97::numeric
        WHEN c.email <> '' AND c.email = v_token THEN 0.95::numeric
        WHEN EXISTS (
          SELECT 1 FROM public.handle_aliases ha
           WHERE ha.user_id = c.user_id AND ha.old_handle = v_token
        ) THEN 0.92::numeric
        WHEN similarity(lower(public.unaccent(coalesce(c.name, ''))), v_token) > 0.4
          THEN (0.55 + similarity(lower(public.unaccent(coalesce(c.name, ''))), v_token) * 0.30)::numeric
        WHEN similarity(lower(public.unaccent(coalesce(c.name, ''))), v_token) > 0.2
          THEN (0.42 + similarity(lower(public.unaccent(coalesce(c.name, ''))), v_token) * 0.30)::numeric
        ELSE 0.00::numeric
      END AS base_score,
      CASE
        WHEN lower(coalesce(c.vitana_id, '')) = v_token THEN 'vitana_id_exact'
        WHEN c.handle <> '' AND c.handle = v_token THEN 'handle_exact'
        WHEN c.email <> '' AND c.email = v_token THEN 'email_exact'
        WHEN EXISTS (
          SELECT 1 FROM public.handle_aliases ha
           WHERE ha.user_id = c.user_id AND ha.old_handle = v_token
        ) THEN 'legacy_handle'
        WHEN similarity(lower(public.unaccent(coalesce(c.name, ''))), v_token) > 0.4
          THEN 'fuzzy_name'
        WHEN similarity(lower(public.unaccent(coalesce(c.name, ''))), v_token) > 0.2
          THEN 'fuzzy_name_relaxed'
        ELSE 'none'
      END AS base_reason
    FROM cand c
  ),
  ranked AS (
    SELECT
      s.user_id,
      s.vitana_id,
      s.display_name,
      s.avatar_url,
      (
        s.base_score
        + CASE
            WHEN s.base_reason IN ('fuzzy_name', 'fuzzy_name_relaxed', 'none')
             AND s.display_name IS NOT NULL
             AND length(v_token) >= 3
             AND metaphone(lower(public.unaccent(split_part(s.display_name, ' ', 1))), 6)
               = metaphone(v_token, 6)
            THEN 0.10 ELSE 0
          END
        + CASE WHEN s.is_chat_peer THEN 0.10 ELSE 0 END
        + CASE
            WHEN v_actor_tenant IS NOT NULL AND s.tenant_id = v_actor_tenant
            THEN 0.15 ELSE 0
          END
      ) AS score,
      s.base_reason AS reason
    FROM scored s
    WHERE s.base_score > 0
      -- Eligibility: when not global, scope to the actor's tenant IF it is
      -- known. If tenant is unknown, fall through to a global search so we
      -- never silently return nothing.
      AND (
        p_global = true
        OR v_actor_tenant IS NULL
        OR s.tenant_id = v_actor_tenant
      )
  )
  SELECT r.user_id, r.vitana_id, r.display_name, r.avatar_url, r.score, r.reason
  FROM ranked r
  ORDER BY r.score DESC, r.display_name ASC
  LIMIT GREATEST(coalesce(p_limit, 5), 1);
END;
$$;

COMMENT ON FUNCTION public.resolve_recipient_candidates(uuid, text, int, boolean) IS
  'Canonical voice/people resolver. Candidate pool = active app_users (no membership gate); tenant from app_users.tenant_id. Matches on exact vitana_id/@handle/email + legacy alias + fuzzy name (>=0.2) coalesced across app_users/profiles/global_community_profiles. p_global=false scopes to actor tenant when known (else global); p_global=true searches all tenants with a +0.15 same-tenant ranking boost.';
