-- Dance specialized market — Phase D2 SQL (VTID-DANCE-D2)
-- Add a dance-overlap helper and extend compute_intent_matches() to handle
-- learning_seek ↔ mentor_seek pairings + a +0.10 bonus when both sides
-- carry a dance facet with matching variety.

-- 1. Dance overlap helper: variety match (heavy weight) + level proximity.
CREATE OR REPLACE FUNCTION public.intent_overlap_dance(a jsonb, b jsonb)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  a_variety text;
  b_variety text;
  a_level   text;
  b_level   text;
  level_score numeric := 0.5;
  level_order text[] := ARRAY['beginner','social','intermediate','advanced','professional'];
  a_idx int; b_idx int;
BEGIN
  -- A 'dance' block must exist on both sides for this overlap to count.
  IF a -> 'dance' IS NULL OR b -> 'dance' IS NULL THEN
    RETURN 0.4;  -- neutral when one or both sides have no dance facet
  END IF;

  a_variety := lower((a -> 'dance') ->> 'variety');
  b_variety := lower((b -> 'dance') ->> 'variety');

  -- Variety mismatch is essentially disqualifying for dance pairings.
  -- A 'other' variety on either side falls back to neutral 0.5.
  IF a_variety IS NULL OR b_variety IS NULL THEN
    RETURN 0.4;
  END IF;
  IF a_variety = 'other' OR b_variety = 'other' THEN
    RETURN 0.5;
  END IF;
  IF a_variety <> b_variety THEN
    RETURN 0.05;
  END IF;

  -- Same variety: level proximity bonus.
  a_level := lower((a -> 'dance') ->> 'level_target');
  b_level := lower((b -> 'dance') ->> 'level_target');
  IF a_level IS NOT NULL AND b_level IS NOT NULL THEN
    SELECT array_position(level_order, a_level) INTO a_idx;
    SELECT array_position(level_order, b_level) INTO b_idx;
    IF a_idx IS NOT NULL AND b_idx IS NOT NULL THEN
      level_score := GREATEST(0, 1 - abs(a_idx - b_idx)::numeric / 4.0);
    END IF;
  END IF;

  -- Same variety = 0.85 baseline + up to +0.15 from level proximity = 1.00.
  RETURN LEAST(1.0, 0.85 + 0.15 * level_score);
END;
$$;

COMMENT ON FUNCTION public.intent_overlap_dance(jsonb, jsonb) IS
  'Returns a 0-1 dance compatibility score. Variety match is heavy (mismatch ≈0.05); within same variety, level proximity adds up to +0.15.';

-- 2. Replace compute_intent_matches() with the version that handles
--    learning_seek + mentor_seek and adds a dance bonus on the score.
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
  SELECT * INTO src FROM public.user_intents WHERE intent_id = p_intent_id;
  IF NOT FOUND OR src.status NOT IN ('open','matched','engaged') OR src.embedding IS NULL THEN
    RETURN 0;
  END IF;

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
        GREATEST(0, LEAST(1, 1 - (src.embedding <=> ui.embedding)))::numeric  AS cosine_sim,
        CASE src.intent_kind
          WHEN 'commercial_buy'  THEN public.intent_overlap_budget(src.kind_payload, ui.kind_payload)
          WHEN 'commercial_sell' THEN public.intent_overlap_budget(ui.kind_payload, src.kind_payload)
          WHEN 'activity_seek'   THEN public.intent_overlap_time(src.kind_payload, ui.kind_payload)
          WHEN 'partner_seek'    THEN public.intent_overlap_partner(src.kind_payload, ui.kind_payload)
          WHEN 'social_seek'     THEN public.intent_overlap_time(src.kind_payload, ui.kind_payload)
          WHEN 'mutual_aid'      THEN public.intent_overlap_mutual_aid(src.kind_payload, ui.kind_payload)
          -- VTID-DANCE-D2: learning ↔ mentor (and vice-versa) are scored on
          -- dance facet when present, falling back to time overlap otherwise.
          WHEN 'learning_seek'   THEN public.intent_overlap_dance(src.kind_payload, ui.kind_payload)
          WHEN 'mentor_seek'     THEN public.intent_overlap_dance(src.kind_payload, ui.kind_payload)
          ELSE 0::numeric
        END                                                AS kind_overlap,
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
        GREATEST(0, 1 - (extract(epoch from now() - ui.created_at) / 86400.0) / 90.0)::numeric AS recency_bonus,
        -- VTID-DANCE-D2: dance-variety bonus, applied as +0.10 on top of the
        -- weighted base when both sides carry a matching dance variety.
        CASE
          WHEN src.kind_payload -> 'dance' IS NOT NULL
           AND ui.kind_payload -> 'dance' IS NOT NULL
           AND lower((src.kind_payload -> 'dance') ->> 'variety')
             = lower((ui.kind_payload -> 'dance') ->> 'variety')
           AND lower((src.kind_payload -> 'dance') ->> 'variety') NOT IN ('other','')
          THEN 0.10::numeric
          ELSE 0::numeric
        END                                                AS dance_bonus
      FROM public.user_intents ui
      WHERE ui.intent_kind = compat.kind_b
        AND ui.status IN ('open','matched','engaged')
        AND ui.embedding IS NOT NULL
        AND ui.requester_user_id <> src.requester_user_id
        AND (ui.tenant_id = src.tenant_id OR src.visibility = 'public')
        AND (
          src.intent_kind <> 'mutual_aid'
          OR public.intent_mutual_aid_inverse(src.kind_payload, ui.kind_payload)
        )
    ),
    scored AS (
      SELECT
        c.*,
        LEAST(1.0,
          0.40 * c.cosine_sim
          + 0.20 * c.kind_overlap
          + 0.20 * c.geo_overlap
          + 0.10 * c.recency_bonus
          + c.dance_bonus
        )::numeric(4,3)                                    AS score_base,
        jsonb_build_object(
          'cosine',     c.cosine_sim,
          'kind_overlap', c.kind_overlap,
          'geo',        c.geo_overlap,
          'recency',    c.recency_bonus,
          'dance_bonus', c.dance_bonus
        )                                                  AS reasons
      FROM candidates c
    ),
    ranked AS (
      SELECT *
        FROM scored
       WHERE score_base > 0.30
       ORDER BY score_base DESC
       LIMIT GREATEST(p_top_n, 1)
    )
    INSERT INTO public.intent_matches (
      intent_a_id, intent_b_id,
      vitana_id_a, vitana_id_b,
      kind_pairing, score, match_reasons,
      compass_aligned,
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
  'Kind-aware match compute (VTID-DANCE-D2). Adds learning_seek + mentor_seek branches; applies +0.10 dance bonus when both sides carry matching dance.variety.';
