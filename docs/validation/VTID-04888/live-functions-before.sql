-- VTID-04888: live definitions captured 2026-10-05 with pg_get_functiondef() from the production
-- Supabase project before the rule-45 migration was applied. Line endings normalised to LF (the two
-- v1 bodies were stored with CRLF). This file is the rollback for the four functions and the base the
-- contract test diffs the migration against (only the VTID-04888 lines may differ).

CREATE OR REPLACE FUNCTION public.search_intent_catalog_v2(p_user_id uuid, p_tenant_id uuid, p_intent_kind text, p_category text, p_kind_payload jsonb, p_embedding text DEFAULT NULL::text, p_visibility text DEFAULT 'public'::text, p_top_n integer DEFAULT 5)
 RETURNS TABLE(cand_intent_id uuid, cand_user_id uuid, cand_vitana_id text, cand_kind text, cand_title text, cand_scope text, score numeric, reasons jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_embedding vector(1024);
  v_is_online boolean := (p_kind_payload->>'location_mode' = 'remote');
  v_is_business boolean := p_intent_kind IN ('commercial_buy','commercial_sell','learning_seek','mentor_seek','mutual_aid');
  v_ctx text; v_wl numeric; v_wt numeric; v_wa numeric; v_wp numeric; v_pool_size int := 0;
BEGIN
  BEGIN v_embedding := NULLIF(coalesce(p_embedding,''),'')::vector(1024);
  EXCEPTION WHEN others THEN v_embedding := NULL; END;
  v_ctx := CASE WHEN v_is_business THEN 'business' WHEN v_is_online THEN 'online_social' ELSE 'physical_social' END;
  IF v_ctx = 'business' THEN v_wl:=0.20; v_wt:=0.10; v_wa:=0.45; v_wp:=0.25;
  ELSIF v_ctx = 'online_social' THEN v_wl:=0.00; v_wt:=0.40; v_wa:=0.35; v_wp:=0.25;
  ELSE v_wl:=0.35; v_wt:=0.30; v_wa:=0.25; v_wp:=0.10; END IF;
  SELECT count(*) INTO v_pool_size FROM public.user_intents ui
    JOIN public.intent_compatibility ic ON ic.kind_a = p_intent_kind AND ic.kind_b = ui.intent_kind
   WHERE ui.status IN ('open','matched','engaged') AND ui.requester_user_id <> p_user_id
     AND (ui.tenant_id = p_tenant_id OR p_visibility = 'public');
  RETURN QUERY
  WITH compat AS (SELECT ic.kind_b FROM public.intent_compatibility ic WHERE ic.kind_a = p_intent_kind),
  fits AS (
    SELECT ui.intent_id AS c_intent_id, ui.requester_user_id AS c_user_id, ui.requester_vitana_id AS c_vitana_id,
      ui.intent_kind AS c_kind, ui.title AS c_title, ui.scope AS c_scope,
      public.intent_location_fit(p_kind_payload, ui.kind_payload) AS location_fit,
      public.intent_overlap_time(p_kind_payload, ui.kind_payload) AS time_fit,
      CASE WHEN v_is_business THEN
        0.5*(CASE WHEN p_category IS NOT NULL AND ui.category IS NOT NULL AND p_category=ui.category THEN 1.0
                  WHEN p_category IS NOT NULL AND ui.category IS NOT NULL AND split_part(p_category,'.',1)=split_part(ui.category,'.',1) THEN 0.6 ELSE 0.3 END)
        + 0.5*(CASE p_intent_kind
                 WHEN 'commercial_buy' THEN public.intent_overlap_budget(p_kind_payload, ui.kind_payload)
                 WHEN 'commercial_sell' THEN public.intent_overlap_budget(ui.kind_payload, p_kind_payload)
                 WHEN 'learning_seek' THEN public.intent_overlap_dance(p_kind_payload, ui.kind_payload)
                 WHEN 'mentor_seek' THEN public.intent_overlap_dance(p_kind_payload, ui.kind_payload)
                 WHEN 'mutual_aid' THEN public.intent_overlap_mutual_aid(p_kind_payload, ui.kind_payload) ELSE 0.5 END)
        ELSE public.intent_activity_fit_social(p_category, ui.category,
               CASE WHEN v_embedding IS NULL OR ui.embedding_v2 IS NULL THEN NULL::numeric
                    ELSE (GREATEST(0, LEAST(1, 1 - (v_embedding <=> ui.embedding_v2))))::numeric END) END AS activity_fit,
      ((public.intent_skill_fit(p_kind_payload, ui.kind_payload)
        + GREATEST(0, 1 - (extract(epoch from now() - ui.created_at)/86400.0)/90.0))/2.0)::numeric AS profile_fit,
      CASE WHEN v_is_business THEN true ELSE public.intent_activity_exact(p_category, ui.category) END AS activity_exact
    FROM public.user_intents ui JOIN compat c ON c.kind_b = ui.intent_kind
    WHERE ui.status IN ('open','matched','engaged') AND ui.requester_user_id <> p_user_id
      AND (ui.tenant_id = p_tenant_id OR p_visibility = 'public')
      AND (p_intent_kind <> 'mutual_aid' OR public.intent_mutual_aid_inverse(p_kind_payload, ui.kind_payload))
  ),
  scored AS (
    SELECT f.*, LEAST(1.0, v_wl*f.location_fit + v_wt*f.time_fit + v_wa*f.activity_fit + v_wp*f.profile_fit)::numeric(4,3) AS s FROM fits f
  )
  SELECT s.c_intent_id, s.c_user_id, s.c_vitana_id, s.c_kind, s.c_title, s.c_scope, s.s,
    jsonb_build_object('score', s.s, 'tier', public.intent_match_tier(s.s), 'context', v_ctx,
      'location_fit', round(s.location_fit,3), 'time_fit', round(s.time_fit,3),
      'activity_fit', round(s.activity_fit,3), 'profile_fit', round(s.profile_fit,3),
      'activity_exact', s.activity_exact, 'pool_size', v_pool_size, 'source', 'search_intent_catalog_v3')
  FROM scored s ORDER BY s.s DESC LIMIT GREATEST(p_top_n, 1);
END;
$function$;

CREATE OR REPLACE FUNCTION public.compute_intent_matches_v2(p_intent_id uuid, p_top_n integer DEFAULT 5)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  src record; v_is_online boolean; v_is_business boolean; v_ctx text;
  v_wl numeric; v_wt numeric; v_wa numeric; v_wp numeric; v_pool_size int := 0; v_inserted int := 0;
BEGIN
  SELECT * INTO src FROM public.user_intents WHERE intent_id = p_intent_id;
  IF NOT FOUND OR src.status NOT IN ('open','matched','engaged') THEN RETURN 0; END IF;
  v_is_online := (src.kind_payload->>'location_mode' = 'remote');
  v_is_business := src.intent_kind IN ('commercial_buy','commercial_sell','learning_seek','mentor_seek','mutual_aid');
  v_ctx := CASE WHEN v_is_business THEN 'business' WHEN v_is_online THEN 'online_social' ELSE 'physical_social' END;
  IF v_ctx = 'business' THEN v_wl:=0.20; v_wt:=0.10; v_wa:=0.45; v_wp:=0.25;
  ELSIF v_ctx = 'online_social' THEN v_wl:=0.00; v_wt:=0.40; v_wa:=0.35; v_wp:=0.25;
  ELSE v_wl:=0.35; v_wt:=0.30; v_wa:=0.25; v_wp:=0.10; END IF;
  SELECT count(*) INTO v_pool_size FROM public.user_intents ui
    JOIN public.intent_compatibility ic ON ic.kind_a = src.intent_kind AND ic.kind_b = ui.intent_kind
   WHERE ui.status IN ('open','matched','engaged') AND ui.requester_user_id <> src.requester_user_id
     AND (ui.tenant_id = src.tenant_id OR src.visibility = 'public');
  WITH compat AS (SELECT ic.kind_b FROM public.intent_compatibility ic WHERE ic.kind_a = src.intent_kind),
  fits AS (
    SELECT ui.intent_id AS c_intent_id, ui.requester_user_id AS c_user_id, ui.requester_vitana_id AS c_vitana_id,
      ui.intent_kind AS c_kind,
      public.intent_location_fit(src.kind_payload, ui.kind_payload) AS location_fit,
      public.intent_overlap_time(src.kind_payload, ui.kind_payload) AS time_fit,
      CASE WHEN v_is_business THEN
        0.5*(CASE WHEN src.category IS NOT NULL AND ui.category IS NOT NULL AND src.category=ui.category THEN 1.0
                  WHEN src.category IS NOT NULL AND ui.category IS NOT NULL AND split_part(src.category,'.',1)=split_part(ui.category,'.',1) THEN 0.6 ELSE 0.3 END)
        + 0.5*(CASE src.intent_kind
                 WHEN 'commercial_buy' THEN public.intent_overlap_budget(src.kind_payload, ui.kind_payload)
                 WHEN 'commercial_sell' THEN public.intent_overlap_budget(ui.kind_payload, src.kind_payload)
                 WHEN 'learning_seek' THEN public.intent_overlap_dance(src.kind_payload, ui.kind_payload)
                 WHEN 'mentor_seek' THEN public.intent_overlap_dance(src.kind_payload, ui.kind_payload)
                 WHEN 'mutual_aid' THEN public.intent_overlap_mutual_aid(src.kind_payload, ui.kind_payload) ELSE 0.5 END)
        ELSE public.intent_activity_fit_social(src.category, ui.category,
               CASE WHEN src.embedding_v2 IS NULL OR ui.embedding_v2 IS NULL THEN NULL::numeric
                    ELSE (GREATEST(0, LEAST(1, 1 - (src.embedding_v2 <=> ui.embedding_v2))))::numeric END) END AS activity_fit,
      ((public.intent_skill_fit(src.kind_payload, ui.kind_payload)
        + GREATEST(0, 1 - (extract(epoch from now() - ui.created_at)/86400.0)/90.0))/2.0)::numeric AS profile_fit,
      CASE WHEN v_is_business THEN true ELSE public.intent_activity_exact(src.category, ui.category) END AS activity_exact
    FROM public.user_intents ui JOIN compat c ON c.kind_b = ui.intent_kind
    WHERE ui.status IN ('open','matched','engaged') AND ui.requester_user_id <> src.requester_user_id
      AND (ui.tenant_id = src.tenant_id OR src.visibility = 'public')
      AND (src.intent_kind <> 'mutual_aid' OR public.intent_mutual_aid_inverse(src.kind_payload, ui.kind_payload))
  ),
  scored AS (SELECT f.*, LEAST(1.0, v_wl*f.location_fit + v_wt*f.time_fit + v_wa*f.activity_fit + v_wp*f.profile_fit)::numeric(4,3) AS s FROM fits f),
  ranked AS (SELECT * FROM scored ORDER BY s DESC LIMIT GREATEST(p_top_n, 1)),
  inserted AS (
    INSERT INTO public.intent_matches (intent_a_id, intent_b_id, vitana_id_a, vitana_id_b, kind_pairing, score, match_reasons, compass_aligned, state)
    SELECT src.intent_id, r.c_intent_id, src.requester_vitana_id, r.c_vitana_id,
      src.intent_kind || '::' || r.c_kind, r.s,
      jsonb_build_object('score', r.s, 'tier', public.intent_match_tier(r.s), 'context', v_ctx,
        'location_fit', round(r.location_fit,3), 'time_fit', round(r.time_fit,3),
        'activity_fit', round(r.activity_fit,3), 'profile_fit', round(r.profile_fit,3),
        'activity_exact', r.activity_exact, 'pool_size', v_pool_size, 'source', 'compute_intent_matches_v5'),
      false, 'new'
    FROM ranked r
    ON CONFLICT (intent_a_id, intent_b_id, external_target_kind, external_target_id) DO NOTHING
    RETURNING intent_b_id
  )
  UPDATE public.user_intents ui SET match_count = ui.match_count + 1 FROM inserted i WHERE ui.intent_id = i.intent_b_id;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  UPDATE public.user_intents SET match_count = (SELECT count(*) FROM public.intent_matches WHERE intent_a_id = src.intent_id) WHERE intent_id = src.intent_id;
  RETURN v_inserted;
END;
$function$;

CREATE OR REPLACE FUNCTION public.search_intent_catalog(p_user_id uuid, p_tenant_id uuid, p_intent_kind text, p_category text, p_kind_payload jsonb, p_embedding text DEFAULT NULL::text, p_visibility text DEFAULT 'public'::text, p_top_n integer DEFAULT 5)
 RETURNS TABLE(cand_intent_id uuid, cand_user_id uuid, cand_vitana_id text, cand_kind text, cand_title text, cand_scope text, score numeric, reasons jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_embedding vector(768);
  v_is_online boolean := (p_kind_payload->>'location_mode' = 'remote');
  v_is_business boolean := p_intent_kind IN ('commercial_buy','commercial_sell','learning_seek','mentor_seek','mutual_aid');
  v_ctx text; v_wl numeric; v_wt numeric; v_wa numeric; v_wp numeric; v_pool_size int := 0;
BEGIN
  BEGIN v_embedding := NULLIF(coalesce(p_embedding,''),'')::vector(768);
  EXCEPTION WHEN others THEN v_embedding := NULL; END;
  v_ctx := CASE WHEN v_is_business THEN 'business' WHEN v_is_online THEN 'online_social' ELSE 'physical_social' END;
  IF v_ctx = 'business' THEN v_wl:=0.20; v_wt:=0.10; v_wa:=0.45; v_wp:=0.25;
  ELSIF v_ctx = 'online_social' THEN v_wl:=0.00; v_wt:=0.40; v_wa:=0.35; v_wp:=0.25;
  ELSE v_wl:=0.35; v_wt:=0.30; v_wa:=0.25; v_wp:=0.10; END IF;
  SELECT count(*) INTO v_pool_size FROM public.user_intents ui
    JOIN public.intent_compatibility ic ON ic.kind_a = p_intent_kind AND ic.kind_b = ui.intent_kind
   WHERE ui.status IN ('open','matched','engaged') AND ui.requester_user_id <> p_user_id
     AND (ui.tenant_id = p_tenant_id OR p_visibility = 'public');
  RETURN QUERY
  WITH compat AS (SELECT ic.kind_b FROM public.intent_compatibility ic WHERE ic.kind_a = p_intent_kind),
  fits AS (
    SELECT ui.intent_id AS c_intent_id, ui.requester_user_id AS c_user_id, ui.requester_vitana_id AS c_vitana_id,
      ui.intent_kind AS c_kind, ui.title AS c_title, ui.scope AS c_scope,
      public.intent_location_fit(p_kind_payload, ui.kind_payload) AS location_fit,
      public.intent_overlap_time(p_kind_payload, ui.kind_payload) AS time_fit,
      CASE WHEN v_is_business THEN
        0.5*(CASE WHEN p_category IS NOT NULL AND ui.category IS NOT NULL AND p_category=ui.category THEN 1.0
                  WHEN p_category IS NOT NULL AND ui.category IS NOT NULL AND split_part(p_category,'.',1)=split_part(ui.category,'.',1) THEN 0.6 ELSE 0.3 END)
        + 0.5*(CASE p_intent_kind
                 WHEN 'commercial_buy' THEN public.intent_overlap_budget(p_kind_payload, ui.kind_payload)
                 WHEN 'commercial_sell' THEN public.intent_overlap_budget(ui.kind_payload, p_kind_payload)
                 WHEN 'learning_seek' THEN public.intent_overlap_dance(p_kind_payload, ui.kind_payload)
                 WHEN 'mentor_seek' THEN public.intent_overlap_dance(p_kind_payload, ui.kind_payload)
                 WHEN 'mutual_aid' THEN public.intent_overlap_mutual_aid(p_kind_payload, ui.kind_payload) ELSE 0.5 END)
        ELSE public.intent_activity_fit_social(p_category, ui.category,
               CASE WHEN v_embedding IS NULL OR ui.embedding IS NULL THEN NULL::numeric
                    ELSE (GREATEST(0, LEAST(1, 1 - (v_embedding <=> ui.embedding))))::numeric END) END AS activity_fit,
      ((public.intent_skill_fit(p_kind_payload, ui.kind_payload)
        + GREATEST(0, 1 - (extract(epoch from now() - ui.created_at)/86400.0)/90.0))/2.0)::numeric AS profile_fit,
      CASE WHEN v_is_business THEN true ELSE public.intent_activity_exact(p_category, ui.category) END AS activity_exact
    FROM public.user_intents ui JOIN compat c ON c.kind_b = ui.intent_kind
    WHERE ui.status IN ('open','matched','engaged') AND ui.requester_user_id <> p_user_id
      AND (ui.tenant_id = p_tenant_id OR p_visibility = 'public')
      AND (p_intent_kind <> 'mutual_aid' OR public.intent_mutual_aid_inverse(p_kind_payload, ui.kind_payload))
  ),
  scored AS (
    SELECT f.*, LEAST(1.0, v_wl*f.location_fit + v_wt*f.time_fit + v_wa*f.activity_fit + v_wp*f.profile_fit)::numeric(4,3) AS s FROM fits f
  )
  SELECT s.c_intent_id, s.c_user_id, s.c_vitana_id, s.c_kind, s.c_title, s.c_scope, s.s,
    jsonb_build_object('score', s.s, 'tier', public.intent_match_tier(s.s), 'context', v_ctx,
      'location_fit', round(s.location_fit,3), 'time_fit', round(s.time_fit,3),
      'activity_fit', round(s.activity_fit,3), 'profile_fit', round(s.profile_fit,3),
      'activity_exact', s.activity_exact, 'pool_size', v_pool_size, 'source', 'search_intent_catalog_v2')
  FROM scored s ORDER BY s.s DESC LIMIT GREATEST(p_top_n, 1);
END;
$function$;

CREATE OR REPLACE FUNCTION public.compute_intent_matches(p_intent_id uuid, p_top_n integer DEFAULT 5)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  src record; v_is_online boolean; v_is_business boolean; v_ctx text;
  v_wl numeric; v_wt numeric; v_wa numeric; v_wp numeric; v_pool_size int := 0; v_inserted int := 0;
BEGIN
  SELECT * INTO src FROM public.user_intents WHERE intent_id = p_intent_id;
  IF NOT FOUND OR src.status NOT IN ('open','matched','engaged') THEN RETURN 0; END IF;
  v_is_online := (src.kind_payload->>'location_mode' = 'remote');
  v_is_business := src.intent_kind IN ('commercial_buy','commercial_sell','learning_seek','mentor_seek','mutual_aid');
  v_ctx := CASE WHEN v_is_business THEN 'business' WHEN v_is_online THEN 'online_social' ELSE 'physical_social' END;
  IF v_ctx = 'business' THEN v_wl:=0.20; v_wt:=0.10; v_wa:=0.45; v_wp:=0.25;
  ELSIF v_ctx = 'online_social' THEN v_wl:=0.00; v_wt:=0.40; v_wa:=0.35; v_wp:=0.25;
  ELSE v_wl:=0.35; v_wt:=0.30; v_wa:=0.25; v_wp:=0.10; END IF;
  SELECT count(*) INTO v_pool_size FROM public.user_intents ui
    JOIN public.intent_compatibility ic ON ic.kind_a = src.intent_kind AND ic.kind_b = ui.intent_kind
   WHERE ui.status IN ('open','matched','engaged') AND ui.requester_user_id <> src.requester_user_id
     AND (ui.tenant_id = src.tenant_id OR src.visibility = 'public');
  WITH compat AS (SELECT ic.kind_b FROM public.intent_compatibility ic WHERE ic.kind_a = src.intent_kind),
  fits AS (
    SELECT ui.intent_id AS c_intent_id, ui.requester_user_id AS c_user_id, ui.requester_vitana_id AS c_vitana_id,
      ui.intent_kind AS c_kind,
      public.intent_location_fit(src.kind_payload, ui.kind_payload) AS location_fit,
      public.intent_overlap_time(src.kind_payload, ui.kind_payload) AS time_fit,
      CASE WHEN v_is_business THEN
        0.5*(CASE WHEN src.category IS NOT NULL AND ui.category IS NOT NULL AND src.category=ui.category THEN 1.0
                  WHEN src.category IS NOT NULL AND ui.category IS NOT NULL AND split_part(src.category,'.',1)=split_part(ui.category,'.',1) THEN 0.6 ELSE 0.3 END)
        + 0.5*(CASE src.intent_kind
                 WHEN 'commercial_buy' THEN public.intent_overlap_budget(src.kind_payload, ui.kind_payload)
                 WHEN 'commercial_sell' THEN public.intent_overlap_budget(ui.kind_payload, src.kind_payload)
                 WHEN 'learning_seek' THEN public.intent_overlap_dance(src.kind_payload, ui.kind_payload)
                 WHEN 'mentor_seek' THEN public.intent_overlap_dance(src.kind_payload, ui.kind_payload)
                 WHEN 'mutual_aid' THEN public.intent_overlap_mutual_aid(src.kind_payload, ui.kind_payload) ELSE 0.5 END)
        ELSE public.intent_activity_fit_social(src.category, ui.category,
               CASE WHEN src.embedding IS NULL OR ui.embedding IS NULL THEN NULL::numeric
                    ELSE (GREATEST(0, LEAST(1, 1 - (src.embedding <=> ui.embedding))))::numeric END) END AS activity_fit,
      ((public.intent_skill_fit(src.kind_payload, ui.kind_payload)
        + GREATEST(0, 1 - (extract(epoch from now() - ui.created_at)/86400.0)/90.0))/2.0)::numeric AS profile_fit,
      CASE WHEN v_is_business THEN true ELSE public.intent_activity_exact(src.category, ui.category) END AS activity_exact
    FROM public.user_intents ui JOIN compat c ON c.kind_b = ui.intent_kind
    WHERE ui.status IN ('open','matched','engaged') AND ui.requester_user_id <> src.requester_user_id
      AND (ui.tenant_id = src.tenant_id OR src.visibility = 'public')
      AND (src.intent_kind <> 'mutual_aid' OR public.intent_mutual_aid_inverse(src.kind_payload, ui.kind_payload))
  ),
  scored AS (SELECT f.*, LEAST(1.0, v_wl*f.location_fit + v_wt*f.time_fit + v_wa*f.activity_fit + v_wp*f.profile_fit)::numeric(4,3) AS s FROM fits f),
  ranked AS (SELECT * FROM scored ORDER BY s DESC LIMIT GREATEST(p_top_n, 1)),
  inserted AS (
    INSERT INTO public.intent_matches (intent_a_id, intent_b_id, vitana_id_a, vitana_id_b, kind_pairing, score, match_reasons, compass_aligned, state)
    SELECT src.intent_id, r.c_intent_id, src.requester_vitana_id, r.c_vitana_id,
      src.intent_kind || '::' || r.c_kind, r.s,
      jsonb_build_object('score', r.s, 'tier', public.intent_match_tier(r.s), 'context', v_ctx,
        'location_fit', round(r.location_fit,3), 'time_fit', round(r.time_fit,3),
        'activity_fit', round(r.activity_fit,3), 'profile_fit', round(r.profile_fit,3),
        'activity_exact', r.activity_exact, 'pool_size', v_pool_size, 'source', 'compute_intent_matches_v4'),
      false, 'new'
    FROM ranked r
    ON CONFLICT (intent_a_id, intent_b_id, external_target_kind, external_target_id) DO NOTHING
    RETURNING intent_b_id
  )
  UPDATE public.user_intents ui SET match_count = ui.match_count + 1 FROM inserted i WHERE ui.intent_id = i.intent_b_id;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  UPDATE public.user_intents SET match_count = (SELECT count(*) FROM public.intent_matches WHERE intent_a_id = src.intent_id) WHERE intent_id = src.intent_id;
  RETURN v_inserted;
END;
$function$;
