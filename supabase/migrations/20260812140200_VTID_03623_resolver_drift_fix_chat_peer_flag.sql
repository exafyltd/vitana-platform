-- VTID-03623: two fixes bundled because the second depends on the first.
--
-- FINDING (production drift, confirmed via pg_get_functiondef() against prod
-- 2026-08-12): the function actually LIVE was NEITHER committed version of
-- resolve_recipient_candidates() — not 20260618000000_BOOTSTRAP_canonical_
-- people_search.sql, and not 20260618120000_BOOTSTRAP_resolver_match_
-- quality_dominant.sql. It was an older, unclamped variant: chat-peer boost
-- +0.15 (not +0.01), phonetic boost +0.10 (not +0.01), NO same-tenant term,
-- candidate pool sourced directly from public.profiles (not the canonical
-- public.app_users join both committed versions use), and no LEAST(1.0, ...)
-- score clamp. This is exactly the "Anna/Anne" misrouting failure mode
-- 20260618120000's own header describes and claims to fix (a well-connected
-- but weakly-matching candidate outranking the person actually named) — that
-- fix never reached this database.
--
-- Reproduced live: for one real actor, "Maria Dier" (a recent chat contact,
-- weak name match, base ~0.51 sim) outscored "Mariia Maksina" (not a recent
-- contact, much closer name match, ~0.41 sim) because of the +0.15
-- unclamped chat-peer boost — 0.7125 vs 0.6735. Under the fixed/clamped
-- scoring (chat-peer capped at +0.01, total connection-boost ceiling 0.05,
-- strictly below every match-quality band gap) the better name match always
-- wins, which is the whole point of the never-applied fix.
--
-- This migration:
--   1. Re-applies 20260618120000's corrected, clamped scoring VERBATIM
--      (candidate pool = app_users; base_score / match quality dominates;
--      same-tenant +0.03 / chat-peer +0.01 / phonetic +0.01 tie-breakers,
--      sum capped well under every band gap; final score clamped to 1.0) —
--      restoring a fix that was authored, reviewed, and committed, but never
--      actually took effect on production.
--   2. Adds `is_chat_peer boolean` + `last_chat_at timestamptz` to the
--      output. Requested live: "make the matching robust by checking who
--      I'm actually chatting with — if I say 'Maria Maxina' and I chatted
--      with a 'Maria' 5 days ago, that history should confirm the match."
--      That needs a signal independent of the (still score-based, still
--      sub-0.85-for-most-fuzzy-matches) ranking, AND a recency figure so
--      "we exchanged one message two years ago" isn't treated the same as
--      "we spoke five days ago" — the caller-side fix in orb-tools-shared.ts
--      consumes both directly instead of inferring recency from the
--      `reason` string, which is also used for other things (phonetic/
--      relaxed-match hints).
--
-- DROP + CREATE (not CREATE OR REPLACE) because the return signature is
-- changing — Postgres refuses CREATE OR REPLACE across a column-set change.
DROP FUNCTION IF EXISTS public.resolve_recipient_candidates(uuid, text, int, boolean);

CREATE FUNCTION public.resolve_recipient_candidates(
  p_actor  uuid,
  p_token  text,
  p_limit  int  DEFAULT 5,
  p_global boolean DEFAULT false
) RETURNS TABLE (
  user_id       uuid,
  vitana_id     text,
  display_name  text,
  avatar_url    text,
  score         numeric,
  reason        text,
  is_chat_peer  boolean,
  last_chat_at  timestamptz
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
    -- Recent two-way chat partners, WITH the most recent exchange timestamp
    -- per peer — used for the is_chat_peer/last_chat_at OUTPUT columns (new)
    -- and for the same small ranking tie-break as before. Scanning the
    -- actor's own last 200 messages (either direction) is a bounded,
    -- indexed-on-created_at scan, not a full-table peer lookup.
    SELECT peer, max(created_at) AS last_chat_at
      FROM (
        (SELECT cm.sender_id   AS peer, cm.created_at FROM public.chat_messages cm
          WHERE cm.receiver_id = p_actor
          ORDER BY cm.created_at DESC LIMIT 200)
        UNION ALL
        (SELECT cm.receiver_id AS peer, cm.created_at FROM public.chat_messages cm
          WHERE cm.sender_id   = p_actor
          ORDER BY cm.created_at DESC LIMIT 200)
      ) recent
     WHERE peer IS NOT NULL
     GROUP BY peer
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
      cp.last_chat_at,
      (cp.last_chat_at IS NOT NULL) AS is_chat_peer
    FROM public.app_users au
    LEFT JOIN public.profiles p ON p.user_id = au.user_id
    LEFT JOIN public.global_community_profiles g ON g.user_id = au.user_id
    LEFT JOIN chat_peers cp ON cp.peer = au.user_id
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
      c.last_chat_at,
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
      s.is_chat_peer,
      s.last_chat_at,
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
  SELECT r.user_id, r.vitana_id, r.display_name, r.avatar_url, r.score, r.reason, r.is_chat_peer, r.last_chat_at
  FROM ranked r
  ORDER BY r.score DESC, r.display_name ASC
  LIMIT GREATEST(coalesce(p_limit, 5), 1);
END;
$$;

COMMENT ON FUNCTION public.resolve_recipient_candidates(uuid, text, int, boolean) IS
  'Canonical voice/text-chat people resolver (VTID-03623: re-applied the 20260618120000 dominant-match-quality fix that never reached prod, + added is_chat_peer/last_chat_at output). Candidate pool = active app_users (no membership gate); tenant from app_users.tenant_id. Matches on exact vitana_id/@handle/email + legacy alias + fuzzy name (>=0.2) coalesced across app_users/profiles/global_community_profiles. Ranking: match quality (base_score) DOMINATES; same-tenant (+0.03)/chat-peer (+0.01)/phonetic (+0.01) are clamp-safe tie-breakers (max +0.05 < band gaps) and the score is clamped to 1.0, so a stronger name/id match is never overtaken by a weaker but better-connected one. is_chat_peer/last_chat_at independently report whether and when the actor last exchanged chat_messages with this candidate (scanning the actor''s own last 200 messages either direction) — for callers that want recent-contact status as a confirmation-skip signal rather than a ranking boost. p_global=false scopes to actor tenant when known (else global); p_global=true searches all tenants, same-tenant ranked first.';
