-- D11.A + D11.D — compute_intent_matches v3 (VTID-DANCE-D11/D12)
--
-- Three changes vs v2:
--   1. NULL-embedding tolerance — when either side has embedding=NULL,
--      cosine_sim falls back to 0.5 (neutral) instead of being filtered.
--      Lets sparse-pool matching work even if embedding worker hasn't
--      run yet. Once embeddings populate, cosine kicks in for real.
--   2. Density-aware score floor — counts the candidate pool BEFORE
--      filtering by score, then picks the floor:
--         pool < 5  → solo mode  → floor 0.05
--         pool < 50 → early mode → floor 0.15
--         pool ≥ 50 → growth+    → floor 0.30 (current)
--      Ensures we always surface SOMETHING when there's any signal.
--   3. match_count retrofit — when a new match row inserts pairing intent A
--      (new) with intent B (existing), increment B's match_count too.
--      Today only A's count moves; B stays at 0 even after matching.

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
  v_pool_size      int := 0;
  v_floor          numeric;
BEGIN
  SELECT * INTO src FROM public.user_intents WHERE intent_id = p_intent_id;
  IF NOT FOUND OR src.status NOT IN ('open','matched','engaged') THEN
    RETURN 0;
  END IF;

  -- D11.D — Density probe: count addressable pool across all compatible
  -- kinds in the same scope (tenant when private, all when public).
  SELECT count(*) INTO v_pool_size
    FROM public.user_intents ui
    JOIN public.intent_compatibility ic
      ON ic.kind_a = src.intent_kind AND ic.kind_b = ui.intent_kind
   WHERE ui.status IN ('open','matched','engaged')
     AND ui.requester_user_id <> src.requester_user_id
     AND (ui.tenant_id = src.tenant_id OR src.visibility = 'public');

  v_floor := CASE
    WHEN v_pool_size < 5  THEN 0.05::numeric  -- solo mode
    WHEN v_pool_size < 50 THEN 0.15::numeric  -- early mode
    ELSE                       0.30::numeric  -- growth+ mode
  END;

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
        -- D11.A — graceful NULL embedding handling.
        CASE
          WHEN src.embedding IS NULL OR ui.embedding IS NULL THEN 0.5::numeric
          ELSE GREATEST(0, LEAST(1, 1 - (src.embedding <=> ui.embedding)))::numeric
        END                                                AS cosine_sim,
        CASE src.intent_kind
          WHEN 'commercial_buy'  THEN public.intent_overlap_budget(src.kind_payload, ui.kind_payload)
          WHEN 'commercial_sell' THEN public.intent_overlap_budget(ui.kind_payload, src.kind_payload)
          WHEN 'activity_seek'   THEN public.intent_overlap_time(src.kind_payload, ui.kind_payload)
          WHEN 'partner_seek'    THEN public.intent_overlap_partner(src.kind_payload, ui.kind_payload)
          WHEN 'social_seek'     THEN public.intent_overlap_time(src.kind_payload, ui.kind_payload)
          WHEN 'mutual_aid'      THEN public.intent_overlap_mutual_aid(src.kind_payload, ui.kind_payload)
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
        CASE
          WHEN src.kind_payload -> 'dance' IS NOT NULL
           AND ui.kind_payload -> 'dance' IS NOT NULL
           AND lower((src.kind_payload -> 'dance') ->> 'variety')
             = lower((ui.kind_payload -> 'dance') ->> 'variety')
           AND lower((src.kind_payload -> 'dance') ->> 'variety') NOT IN ('other','')
          THEN 0.10::numeric
          ELSE 0::numeric
        END                                                AS dance_bonus,
        -- D11.D — category-prefix bonus when both candidates share a
        -- prefix (e.g. both 'dance.*' or both 'home_services.*'), so
        -- vague intents in the same broad space still match.
        CASE
          WHEN src.category IS NOT NULL
           AND ui.category IS NOT NULL
           AND split_part(src.category, '.', 1) = split_part(ui.category, '.', 1)
          THEN 0.10::numeric
          ELSE 0::numeric
        END                                                AS category_prefix_bonus
      FROM public.user_intents ui
      WHERE ui.intent_kind = compat.kind_b
        AND ui.status IN ('open','matched','engaged')
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
          + c.category_prefix_bonus
        )::numeric(4,3)                                    AS score_base,
        jsonb_build_object(
          'cosine',     c.cosine_sim,
          'kind_overlap', c.kind_overlap,
          'geo',        c.geo_overlap,
          'recency',    c.recency_bonus,
          'dance_bonus', c.dance_bonus,
          'category_prefix_bonus', c.category_prefix_bonus,
          'pool_size',  v_pool_size,
          'mode',       CASE WHEN v_pool_size < 5 THEN 'solo' WHEN v_pool_size < 50 THEN 'early' ELSE 'growth' END,
          'embedding_present', src.embedding IS NOT NULL AND c.cand_embedding IS NOT NULL
        )                                                  AS reasons
      FROM candidates c
    ),
    ranked AS (
      SELECT *
        FROM scored
       WHERE score_base >= v_floor   -- D11.D — density-aware floor
       ORDER BY score_base DESC
       LIMIT GREATEST(p_top_n, 1)
    ),
    inserted AS (
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
      ON CONFLICT (intent_a_id, intent_b_id, external_target_kind, external_target_id) DO NOTHING
      RETURNING intent_b_id
    )
    -- D11.A3 — retrofit match_count on the OTHER side.
    UPDATE public.user_intents ui
       SET match_count = ui.match_count + 1
      FROM inserted i
     WHERE ui.intent_id = i.intent_b_id;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
  END LOOP;

  -- Update src side too based on inserted rows above (best-effort).
  UPDATE public.user_intents
     SET match_count = (
       SELECT count(*) FROM public.intent_matches
        WHERE intent_a_id = src.intent_id
     )
   WHERE intent_id = src.intent_id;

  RETURN v_inserted;
END;
$$;

COMMENT ON FUNCTION public.compute_intent_matches(uuid, int) IS
  'v3 (D11): NULL-embedding tolerance (cosine=0.5 fallback) + density-aware score floor (0.05 solo / 0.15 early / 0.30 growth) + match_count retrofit on the OTHER side + category-prefix bonus.';
