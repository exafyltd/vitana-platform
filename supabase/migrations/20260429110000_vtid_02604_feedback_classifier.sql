-- VTID-02604: Unified Feedback Pipeline — classifier + dedupe (parent plan PR 6)
--
-- v1 classifier: keyword-based, runs in SQL. No LLM yet — that lands as a
-- follow-up when we wire the LLM router in. This baseline is good enough
-- to route the 80% of tickets where the user's text contains an obvious
-- domain keyword. Tickets that don't keyword-match stay as kind='feedback'
-- and bubble up to the supervisor inbox for manual triage.
--
-- Dedupe v1: exact normalized-text match against open same-user tickets.
-- Embedding-based dedupe (semantic match) is the next iteration once the
-- embedding worker is wired.
--
-- Trigger: pg_cron schedule, every 5 minutes.

-- ===========================================================================
-- 1. classify_pending_feedback_tickets() — bulk classifier
-- ===========================================================================

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
           classifier_meta
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

    -- Surface: derive from screen_path
    v_surface := CASE
      WHEN r.screen_path LIKE '/admin/%' THEN 'admin'
      WHEN r.screen_path LIKE '/command-hub/%' THEN 'command-hub'
      WHEN r.screen_path LIKE '/comm/%' OR r.screen_path LIKE '/community/%' THEN 'community'
      ELSE 'community'
    END;

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
           classifier_meta = jsonb_build_object(
             'version', 'v1-keyword',
             'matched_keyword', v_pick.matched_keyword,
             'pick_score', v_pick.score,
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

-- ===========================================================================
-- 2. pg_cron schedule — every 5 minutes
-- ===========================================================================
-- Idempotent: drops + recreates the schedule. Same pattern as the
-- oasis-events-info-retention job documented in supabase_io_playbook.md.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('feedback-classifier')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'feedback-classifier');
    PERFORM cron.schedule(
      'feedback-classifier',
      '*/5 * * * *',
      $cron$SELECT public.classify_pending_feedback_tickets()$cron$
    );
  END IF;
END
$$;
