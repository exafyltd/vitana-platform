-- Vitana Intent Engine — P2-A · 5/9
-- VTID-01973
--
-- The kind-aware match function. Given a single intent, find the top N
-- compatible counterparties (or external products for commercial_buy) and
-- insert scored rows into intent_matches.
--
-- Score formula (P2-A baseline; per-kind sophistication grows in P2-B/C):
--   score = 0.40 × cosine(emb_a, emb_b)
--         + 0.20 × kind_specific_overlap   (budget for commercial / time for activity / age for partner / topic for social / direction-inverse for mutual_aid)
--         + 0.20 × geo_overlap             (label match for now; PostGIS in P2-C)
--         + 0.10 × recency_bonus           (newer counterparty intents get a small boost)
--         + 0.10 × compass_alignment_bonus (set when both parties' compass goals are in the boost matrix)
--
-- The application layer (intent-matcher.ts) wraps this fn and ALSO federates
-- against the affiliate products catalog for commercial_buy intents — that
-- federation lives in TS, not in this SQL fn, to keep the products domain
-- cleanly separated.
--
-- Returns: rows inserted into intent_matches (count via ROW_COUNT diagnostic).

CREATE OR REPLACE FUNCTION public.compute_intent_matches(
  p_intent_id   uuid,
  p_top_n       int  DEFAULT 5
) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  src              record;
  compat           record;
  v_inserted       int := 0;
BEGIN
  -- 1. Load source intent. Bail if it's not in a matchable state.
  SELECT * INTO src FROM public.user_intents WHERE intent_id = p_intent_id;
  IF NOT FOUND OR src.status NOT IN ('open','matched','engaged') OR src.embedding IS NULL THEN
    RETURN 0;
  END IF;

  -- 2. For every compatible kind, score candidates and insert.
  FOR compat IN
    SELECT kind_b, is_symmetric, requires_mutual_reveal
      FROM public.intent_compatibility
     WHERE kind_a = src.intent_kind
  LOOP

    WITH candidates AS (
      SELECT
        ui.intent_id                                       AS cand_intent_id,
        ui.requester_user_id                               AS cand_user_id,
        ui.requester_vitana_id                             AS cand_vitana_id,
        ui.intent_kind                                     AS cand_kind,
        ui.kind_payload                                    AS cand_payload,
        ui.embedding                                       AS cand_embedding,
        ui.created_at                                      AS cand_created_at,
        -- Cosine similarity (pgvector: <=> is cosine distance, range 0-2; convert).
        GREATEST(0, LEAST(1, 1 - (src.embedding <=> ui.embedding)))::numeric  AS cosine_sim,
        -- Kind-specific overlap (computed as numeric 0-1).
        CASE src.intent_kind
          WHEN 'commercial_buy' THEN public.intent_overlap_budget(src.kind_payload, ui.kind_payload)
          WHEN 'commercial_sell' THEN public.intent_overlap_budget(ui.kind_payload, src.kind_payload)
          WHEN 'activity_seek'  THEN public.intent_overlap_time(src.kind_payload, ui.kind_payload)
          WHEN 'partner_seek'   THEN public.intent_overlap_partner(src.kind_payload, ui.kind_payload)
          WHEN 'social_seek'    THEN public.intent_overlap_time(src.kind_payload, ui.kind_payload)
          WHEN 'mutual_aid'     THEN public.intent_overlap_mutual_aid(src.kind_payload, ui.kind_payload)
          ELSE 0::numeric
        END                                                AS kind_overlap,
        -- Geo overlap: label match for P2-A. PostGIS in P2-C.
        CASE
          WHEN src.kind_payload->>'location_label' IS NOT NULL
           AND ui.kind_payload->>'location_label' IS NOT NULL
           AND lower(src.kind_payload->>'location_label') = lower(ui.kind_payload->>'location_label')
          THEN 1.0::numeric
          WHEN src.kind_payload->>'location_mode' = 'remote'
            OR ui.kind_payload->>'location_mode' = 'remote'
          THEN 1.0::numeric
          ELSE 0.3::numeric
        END                                                AS geo_overlap,
        -- Recency bonus: 1.0 if created in last 7 days, decaying to 0 at 90 days.
        GREATEST(0, 1 - (extract(epoch from now() - ui.created_at) / 86400.0) / 90.0)::numeric AS recency_bonus
      FROM public.user_intents ui
      WHERE ui.intent_kind = compat.kind_b
        AND ui.status IN ('open','matched','engaged')
        AND ui.embedding IS NOT NULL
        AND ui.requester_user_id <> src.requester_user_id        -- never match self
        -- Tenant scope: same tenant unless the source intent is public.
        AND (ui.tenant_id = src.tenant_id OR src.visibility = 'public')
        -- Mutual_aid direction must be inverse (lend ↔ borrow, give ↔ receive).
        AND (
          src.intent_kind <> 'mutual_aid'
          OR public.intent_mutual_aid_inverse(src.kind_payload, ui.kind_payload)
        )
    ),
    scored AS (
      SELECT
        c.*,
        (0.40 * c.cosine_sim
         + 0.20 * c.kind_overlap
         + 0.20 * c.geo_overlap
         + 0.10 * c.recency_bonus
        )::numeric(4,3)                                    AS score_base,
        jsonb_build_object(
          'cosine',     c.cosine_sim,
          'kind_overlap', c.kind_overlap,
          'geo',        c.geo_overlap,
          'recency',    c.recency_bonus
        )                                                  AS reasons
      FROM candidates c
    ),
    ranked AS (
      SELECT *
        FROM scored
       WHERE score_base > 0.30                             -- floor; below this not worth surfacing
       ORDER BY score_base DESC
       LIMIT GREATEST(p_top_n, 1)
    )
    INSERT INTO public.intent_matches (
      intent_a_id, intent_b_id,
      vitana_id_a, vitana_id_b,
      kind_pairing, score, match_reasons,
      compass_aligned,                                     -- false at insert; compass_alignment_view + notifier flip later
      state
    )
    SELECT
      src.intent_id,
      r.cand_intent_id,
      src.requester_vitana_id,
      r.cand_vitana_id,
      src.intent_kind || '::' || r.cand_kind,
      r.score_base,
      r.reasons,
      false,
      'new'
    FROM ranked r
    ON CONFLICT (intent_a_id, intent_b_id, external_target_kind, external_target_id) DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;

  END LOOP;

  RETURN v_inserted;
END;
$$;

COMMENT ON FUNCTION public.compute_intent_matches(uuid, int) IS
  'Kind-aware match compute. Scores candidates using cosine + kind-specific overlap + geo + recency, inserts into intent_matches with vitana_id_a/b denorm. Application layer (intent-matcher.ts) federates against external products catalog for commercial_buy.';

-- ─── Per-kind overlap helper functions ───────────────────────────────

-- Budget overlap (commercial_buy ↔ commercial_sell): how much of the
-- demander's budget range fits inside the seller's price range.
CREATE OR REPLACE FUNCTION public.intent_overlap_budget(buy jsonb, sell jsonb)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  b_min numeric; b_max numeric;
  s_min numeric; s_max numeric;
  overlap numeric;
BEGIN
  b_min := (buy ->> 'budget_min')::numeric;
  b_max := (buy ->> 'budget_max')::numeric;
  s_min := (sell ->> 'price_floor')::numeric;
  s_max := (sell ->> 'price_ceiling')::numeric;

  -- Either side missing budget info: assume neutral 0.5 — don't kill the match,
  -- but don't reward it either.
  IF b_min IS NULL OR b_max IS NULL OR s_min IS NULL OR s_max IS NULL THEN
    RETURN 0.5;
  END IF;

  overlap := LEAST(b_max, s_max) - GREATEST(b_min, s_min);
  IF overlap <= 0 THEN
    RETURN 0;
  END IF;

  -- Normalise by demand range (we care about how well the supply fits the demand).
  RETURN LEAST(1, overlap / NULLIF(b_max - b_min, 0));
END;
$$;

-- Time overlap (activity_seek ↔ activity_seek, social_seek ↔ social_seek):
-- count overlap of time_windows arrays. Each time_window is a string slot
-- like "tue 18:00-20:00"; for P2-A we just check string equality. PostGIS-
-- style temporal overlap arrives in P2-C.
CREATE OR REPLACE FUNCTION public.intent_overlap_time(a jsonb, b jsonb)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  a_windows text[];
  b_windows text[];
  shared    int;
  total     int;
BEGIN
  IF a -> 'time_windows' IS NULL OR b -> 'time_windows' IS NULL THEN
    RETURN 0.4;  -- neutral when not specified
  END IF;

  SELECT ARRAY(SELECT lower(value::text) FROM jsonb_array_elements_text(a -> 'time_windows')) INTO a_windows;
  SELECT ARRAY(SELECT lower(value::text) FROM jsonb_array_elements_text(b -> 'time_windows')) INTO b_windows;

  shared := array_length(ARRAY(SELECT unnest(a_windows) INTERSECT SELECT unnest(b_windows)), 1);
  total  := GREATEST(array_length(a_windows, 1), array_length(b_windows, 1));

  IF shared IS NULL OR total IS NULL OR total = 0 THEN
    RETURN 0;
  END IF;

  RETURN LEAST(1, shared::numeric / total::numeric);
END;
$$;

-- Partner overlap (partner_seek ↔ partner_seek): age range + must_haves intersection.
-- Deal-breakers act as filters: any intersection between A's deal_breakers
-- and B's must_haves zeroes the row out.
CREATE OR REPLACE FUNCTION public.intent_overlap_partner(a jsonb, b jsonb)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  a_age_min int; a_age_max int;
  b_age_min int; b_age_max int;
  age_overlap_score numeric;
  a_breakers text[]; b_must text[];
  blocking int;
BEGIN
  -- Deal-breakers vs must-haves filter.
  IF a ? 'deal_breakers' AND b ? 'must_haves' THEN
    SELECT ARRAY(SELECT lower(value::text) FROM jsonb_array_elements_text(a -> 'deal_breakers')) INTO a_breakers;
    SELECT ARRAY(SELECT lower(value::text) FROM jsonb_array_elements_text(b -> 'must_haves')) INTO b_must;
    blocking := array_length(ARRAY(SELECT unnest(a_breakers) INTERSECT SELECT unnest(b_must)), 1);
    IF blocking IS NOT NULL AND blocking > 0 THEN
      RETURN 0;
    END IF;
  END IF;

  -- Age overlap: jaccard-style.
  a_age_min := COALESCE(((a -> 'age_range') ->> 0)::int, NULL);
  a_age_max := COALESCE(((a -> 'age_range') ->> 1)::int, NULL);
  b_age_min := COALESCE(((b -> 'age_range') ->> 0)::int, NULL);
  b_age_max := COALESCE(((b -> 'age_range') ->> 1)::int, NULL);

  IF a_age_min IS NULL OR b_age_min IS NULL THEN
    age_overlap_score := 0.5;
  ELSE
    age_overlap_score := GREATEST(0, LEAST(a_age_max, b_age_max) - GREATEST(a_age_min, b_age_min))::numeric
                       / NULLIF(GREATEST(a_age_max - a_age_min, b_age_max - b_age_min, 1), 0);
    age_overlap_score := LEAST(1, COALESCE(age_overlap_score, 0));
  END IF;

  RETURN age_overlap_score;
END;
$$;

-- Mutual-aid: the directions must be inverse (lend ↔ borrow, give ↔ receive,
-- help_me ↔ {anything offering help}). Returns 1.0 on match, 0.0 on mismatch.
CREATE OR REPLACE FUNCTION public.intent_mutual_aid_inverse(a jsonb, b jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    (a ->> 'direction' = 'lend'    AND b ->> 'direction' = 'borrow')
 OR (a ->> 'direction' = 'borrow'  AND b ->> 'direction' = 'lend')
 OR (a ->> 'direction' = 'give'    AND b ->> 'direction' = 'receive')
 OR (a ->> 'direction' = 'receive' AND b ->> 'direction' = 'give')
 OR (a ->> 'direction' = 'help_me' AND b ->> 'direction' IN ('lend','give'));
$$;

CREATE OR REPLACE FUNCTION public.intent_overlap_mutual_aid(a jsonb, b jsonb)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF NOT public.intent_mutual_aid_inverse(a, b) THEN
    RETURN 0;
  END IF;
  -- Object/skill overlap: simple text containment for P2-A.
  IF a ->> 'object_or_skill' IS NULL OR b ->> 'object_or_skill' IS NULL THEN
    RETURN 0.6;
  END IF;
  RETURN CASE
    WHEN lower(a ->> 'object_or_skill') = lower(b ->> 'object_or_skill') THEN 1.0
    WHEN lower(a ->> 'object_or_skill') LIKE '%' || lower(b ->> 'object_or_skill') || '%'
      OR lower(b ->> 'object_or_skill') LIKE '%' || lower(a ->> 'object_or_skill') || '%' THEN 0.7
    ELSE 0.3
  END;
END;
$$;
