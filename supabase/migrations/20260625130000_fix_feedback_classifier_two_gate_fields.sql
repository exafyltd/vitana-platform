-- Fix: feedback classifier references removed columns of pick_specialist_for_text
--
-- SYMPTOM (reported): "Bugs reported to Devon via Vitana are not updated at
-- https://vitanaland.com/admin/feedback/tickets" — feedback tickets stop
-- advancing through the pipeline; new/triaged tickets never get classified,
-- de-duped, prioritised or auto-drafted.
--
-- ROOT CAUSE: the `feedback-classifier` pg_cron job (every 5 min) calls
-- classify_pending_feedback_tickets(), which does:
--
--     SELECT * INTO v_pick FROM public.pick_specialist_for_text(...);
--     ... classifier_meta = jsonb_build_object(
--           'matched_keyword', v_pick.matched_keyword,   -- removed column
--           'pick_score',      v_pick.score, ...)         -- removed column
--
-- On 2026-05-08 the two-gate migration (20260508000000_forwarding_rules_two_gate)
-- redefined pick_specialist_for_text() to RETURN TABLE(decision, persona_key,
-- matched_phrase, gate, confidence) — it no longer has `matched_keyword` or
-- `score`. So every run threw:
--
--     ERROR: record "v_pick" has no field "matched_keyword"
--
-- on the FIRST row and aborted the whole batch. classifier_meta therefore
-- stayed NULL on every ticket, which in turn starved
-- auto_triage_pending_feedback_tickets() (it only processes rows WHERE
-- classifier_meta IS NOT NULL and reads classifier_meta->>'pick_confidence').
-- Net effect: the entire feedback pipeline has been frozen since 2026-05-08.
--
-- FIX: map to the current two-gate return columns —
--   matched_keyword  -> v_pick.matched_phrase  (json key kept for consumers)
--   pick_score       -> dropped (no longer exists); expose gate/decision instead
--   pick_confidence  -> v_pick.confidence       (unchanged; auto_triage reads it)
--
-- Idempotent CREATE OR REPLACE; body otherwise identical to
-- 20260604123000_support_surface_human_only_queue.sql. Once applied, the next
-- cron run (≤5 min) classifies the backlog of stuck tickets automatically.

CREATE OR REPLACE FUNCTION public.classify_pending_feedback_tickets()
RETURNS TABLE (classified_count INT, dedup_count INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_classified INT := 0;
  v_dedup INT := 0;
  r RECORD;
  v_pick RECORD;
  v_kind TEXT;
  v_priority TEXT;
  v_surface TEXT;
  v_dup_id UUID;
BEGIN
  FOR r IN
    SELECT id, user_id, kind, status, raw_transcript, screen_path, structured_fields,
           classifier_meta, surface
      FROM public.feedback_tickets
     WHERE classifier_meta IS NULL
       AND status IN ('new','triaged')
     ORDER BY created_at
     LIMIT 200
  LOOP
    -- Re-run keyword router on raw_transcript when present
    SELECT * INTO v_pick
      FROM public.pick_specialist_for_text(coalesce(r.raw_transcript, ''));

    -- Kind: respect existing kind from intake (specialist set it on /start);
    -- only override if it's still the default 'feedback' AND keyword matched.
    v_kind := r.kind;
    IF r.kind = 'feedback' AND v_pick.persona_key IS NOT NULL THEN
      v_kind := CASE v_pick.persona_key
        WHEN 'devon' THEN 'bug'
        WHEN 'sage' THEN 'support_question'
        WHEN 'atlas' THEN 'marketplace_claim'
        WHEN 'mira' THEN 'account_issue'
        ELSE 'feedback'
      END;
    END IF;

    -- Priority: p1 if user-blocking words present, p2 default.
    v_priority := CASE
      WHEN coalesce(r.raw_transcript, '') ~* '(can''t|cannot|locked out|broken|crashed|won''t open|won''t load|stuck|losing money|urgent)' THEN 'p1'
      WHEN v_kind = 'feature_request' OR v_kind = 'feedback' THEN 'p3'
      ELSE 'p2'
    END;

    -- Surface: preserve an explicitly-pinned surface (e.g. 'support' from the
    -- Support → Contact screen) instead of overwriting it. Otherwise derive
    -- from screen_path; recognize the support screen as a backup so the queue
    -- still works even if the surface wasn't pinned at insert.
    v_surface := COALESCE(r.surface, CASE
      WHEN r.screen_path LIKE 'support/%' OR r.screen_path LIKE '/support/%' THEN 'support'
      WHEN r.screen_path LIKE '/admin/%' THEN 'admin'
      WHEN r.screen_path LIKE '/command-hub/%' THEN 'command-hub'
      WHEN r.screen_path LIKE '/comm/%' OR r.screen_path LIKE '/community/%' THEN 'community'
      ELSE 'community'
    END);

    -- Dedupe: same user, open status, exact normalized raw_transcript match
    -- within the last 24h. Cheap and catches double-submits.
    v_dup_id := NULL;
    IF r.raw_transcript IS NOT NULL THEN
      SELECT t.id INTO v_dup_id
        FROM public.feedback_tickets t
       WHERE t.user_id = r.user_id
         AND t.id <> r.id
         AND lower(trim(coalesce(t.raw_transcript, ''))) = lower(trim(r.raw_transcript))
         AND t.status NOT IN ('rejected','wont_fix','duplicate')
         AND t.created_at > NOW() - INTERVAL '24 hours'
       ORDER BY t.created_at ASC
       LIMIT 1;
    END IF;

    UPDATE public.feedback_tickets
       SET kind = v_kind,
           priority = v_priority,
           surface = v_surface,
           status = CASE
             WHEN v_dup_id IS NOT NULL THEN 'duplicate'
             WHEN status = 'new' THEN 'triaged'
             ELSE status
           END,
           duplicate_of = v_dup_id,
           triaged_at = COALESCE(triaged_at, NOW()),
           -- Two-gate pick_specialist_for_text() exposes:
           --   decision, persona_key, matched_phrase, gate, confidence
           -- (matched_keyword + score were removed on 2026-05-08).
           classifier_meta = jsonb_build_object(
             'version', 'v1-keyword',
             'matched_keyword', v_pick.matched_phrase,
             'pick_gate', v_pick.gate,
             'pick_decision', v_pick.decision,
             'pick_confidence', v_pick.confidence,
             'classified_at', NOW()
           )
     WHERE id = r.id;

    v_classified := v_classified + 1;
    IF v_dup_id IS NOT NULL THEN v_dedup := v_dedup + 1; END IF;
  END LOOP;

  RETURN QUERY SELECT v_classified, v_dedup;
END;
$$;

GRANT EXECUTE ON FUNCTION public.classify_pending_feedback_tickets() TO service_role;
