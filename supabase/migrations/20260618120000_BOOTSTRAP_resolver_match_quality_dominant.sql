-- BOOTSTRAP: People resolver — make match quality the dominant ranking signal.
--
-- Symptom (reported):
--   "I asked for one specific user — just that one — and it matched the wrong
--   person." The voice/people resolver returned (and silently auto-acted on)
--   a DIFFERENT user than the one named.
--
-- Root cause:
--   resolve_recipient_candidates() (20260618000000_BOOTSTRAP_canonical_people_search)
--   ranks each candidate as:
--     score = base_score            -- match QUALITY (exact id / fuzzy name)
--           + same_tenant_boost     -- +0.15
--           + chat_peer_boost       -- +0.10
--           + phonetic_boost        -- +0.10
--   The boosts were intended only to break ties among similarly-named
--   candidates, but at +0.15/+0.10/+0.10 they sum to +0.35 — LARGER than the
--   gaps between the match-quality bands:
--     relaxed name (0.48–0.54) < strong name (0.67–0.85) < exact id (0.92–1.00).
--   So a weakly-matching but well-connected candidate (same tenant + a prior
--   chat + a phonetic hit) could overtake the person whose name/identifier
--   actually matched. With nothing clamping the sum, scores also exceeded 1.0
--   (e.g. a "120% confidence" readback) and tripped the callers' 0.85/0.90
--   auto-act thresholds, so voice tools (tool_resolve_recipient,
--   resolveAndValidateRecipient, tool_send_chat_message) — which all consume
--   candidates[0] — locked onto the wrong user.
--
--   Worked example (the reported failure):
--     Ask for "Anna Schmidt".
--       • Anna Schmidt   — exact name, sibling tenant  → 0.85, no boosts        = 0.85
--       • Anne (a local chat peer, phonetic "Anne"≈"Anna")
--                        → 0.70 + 0.15 + 0.10 + 0.10                            = 1.05  ← wins
--     The resolver returned Anne and voice auto-sent to her.
--
-- Fix (this migration):
--   Keep base_score (match quality) as the DOMINANT term and demote the
--   connection signals to true tie-breakers whose TOTAL can never cross a
--   quality band:
--     same_tenant +0.15 → +0.03
--     chat_peer   +0.10 → +0.01
--     phonetic    +0.10 → +0.01   (still gated to non-exact base reasons)
--   Max total boost is now +0.05, which is strictly smaller than every
--   meaningful band gap:
--     relaxed_top 0.54 + 0.05 = 0.59 < strong_name_floor 0.67
--     name_top    0.85 + 0.05 = 0.90 < exact_id_floor    0.92
--   so a stronger name/identifier match ALWAYS outranks a weaker but
--   better-connected one, while same-tenant/chat-peer/phonetic still order
--   candidates that genuinely tie on name. The final score is clamped to 1.0
--   so the callers' confidence thresholds and the spoken "N% confidence"
--   readback stay sane. (A name-only match now tops out at 0.90, just under the
--   0.90 auto-recover gate — exactly the "don't silently send on a fuzzy name"
--   behavior the send path already documents.)
--
--   Nothing else changes: the candidate pool, tenant resolution, exact lanes
--   (vitana_id/@handle/email/legacy alias), the >=0.2 fuzzy floor and the
--   global/same-tenant eligibility rules are all identical to 20260618000000.

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
  --    last resort. We do NOT return early when this is null — an unknown
  --    tenant degrades to a global search rather than zero results.
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
    -- Recent two-way chat partners, used for a RANKING tie-break only.
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
      -- Match quality dominates; connection signals are clamp-safe tie-breakers
      -- (max total +0.05 < every band gap), and the sum is capped at 1.0 so
      -- a stronger name/identifier match can never be overtaken by a weaker
      -- but better-connected one.
      LEAST(
        1.0,
        s.base_score
        + CASE
            WHEN s.base_reason IN ('fuzzy_name', 'fuzzy_name_relaxed', 'none')
             AND s.display_name IS NOT NULL
             AND length(v_token) >= 3
             AND metaphone(lower(public.unaccent(split_part(s.display_name, ' ', 1))), 6)
               = metaphone(v_token, 6)
            THEN 0.01 ELSE 0
          END
        + CASE WHEN s.is_chat_peer THEN 0.01 ELSE 0 END
        + CASE
            WHEN v_actor_tenant IS NOT NULL AND s.tenant_id = v_actor_tenant
            THEN 0.03 ELSE 0
          END
      )::numeric AS score,
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
  'Canonical voice/people resolver. Candidate pool = active app_users (no membership gate); tenant from app_users.tenant_id. Matches on exact vitana_id/@handle/email + legacy alias + fuzzy name (>=0.2) coalesced across app_users/profiles/global_community_profiles. Ranking: match quality (base_score) DOMINATES; same-tenant (+0.03)/chat-peer (+0.01)/phonetic (+0.01) are clamp-safe tie-breakers (max +0.05 < band gaps) and the score is clamped to 1.0, so a stronger name/id match is never overtaken by a weaker but better-connected one. p_global=false scopes to actor tenant when known (else global); p_global=true searches all tenants, same-tenant ranked first.';
