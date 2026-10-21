-- Support → Contact: distinct, human-only feedback queue (surface = 'support')
--
-- The member-facing Support → Contact screen now files into the unified
-- feedback pipeline (feedback_tickets) and pins surface='support'. We want
-- those tickets to:
--   1. carry a stable 'support' surface (so the admin dashboard can show a
--      distinct, clearly-labeled queue), and
--   2. NEVER be auto-drafted/auto-assigned by the auto_triage routine — a
--      human always reviews them (human-only queue).
--
-- Three changes:
--   A. CHECK constraint on feedback_tickets.surface (adds 'support' to the
--      documented enum; NULL still allowed).
--   B. classify_pending_feedback_tickets(): PRESERVE an explicitly-pinned
--      surface instead of overwriting it, and recognize the support screen
--      path as a backup. (Previously it always re-derived surface from
--      screen_path and would clobber 'support' → 'community'.)
--   C. auto_triage_pending_feedback_tickets(): skip surface='support' so
--      Sage/Devon/Mira never auto-draft on support tickets.

-- ===========================================================================
-- A. CHECK constraint
-- ===========================================================================

ALTER TABLE public.feedback_tickets
  DROP CONSTRAINT IF EXISTS feedback_tickets_surface_check;

ALTER TABLE public.feedback_tickets
  ADD CONSTRAINT feedback_tickets_surface_check
  CHECK (surface IS NULL OR surface IN (
    'community', 'admin', 'command-hub', 'mobile-only',
    'marketplace', 'infrastructure', 'support'
  ));

-- ===========================================================================
-- B. classifier — preserve pinned surface, recognize support screen
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
-- C. auto-triage — skip the human-only support queue
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.auto_triage_pending_feedback_tickets()
RETURNS TABLE (
  auto_drafted_answers INT,
  auto_drafted_specs INT,
  auto_drafted_resolutions INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_answers INT := 0;
  v_specs INT := 0;
  v_resolutions INT := 0;
  r RECORD;
BEGIN
  FOR r IN
    SELECT id, kind, priority, classifier_meta, raw_transcript, structured_fields
      FROM public.feedback_tickets
     WHERE status = 'triaged'
       AND triaged_at < NOW() - INTERVAL '5 minutes'
       AND duplicate_of IS NULL
       AND classifier_meta IS NOT NULL
       -- Human-only queue: never auto-draft/auto-assign support tickets.
       AND COALESCE(surface, '') <> 'support'
     ORDER BY triaged_at
     LIMIT 100
  LOOP
    -- support_question → Sage drafts answer if confidence high enough
    IF r.kind = 'support_question'
       AND COALESCE((r.classifier_meta->>'pick_confidence')::REAL, 0) >= 0.5 THEN
      UPDATE public.feedback_tickets
         SET status = 'answer_ready',
             resolver_agent = 'sage',
             draft_answer_md = '**Sage auto-draft (placeholder)**' || chr(10) || chr(10) ||
                              '_Generated by auto_triage routine. LLM-backed retrieval lands in resolver-agents follow-up._' || chr(10) || chr(10) ||
                              'User asked: ' || COALESCE(r.raw_transcript, '(no transcript)')
       WHERE id = r.id;
      v_answers := v_answers + 1;

    -- p3 bug → Devon drafts spec (low-priority, low-risk to auto-process)
    ELSIF r.kind = 'bug' AND r.priority = 'p3' THEN
      UPDATE public.feedback_tickets
         SET status = 'spec_ready',
             resolver_agent = 'devon',
             spec_md = '# Devon auto-draft spec (placeholder)' || chr(10) ||
                      '## User report' || chr(10) || COALESCE(r.raw_transcript, '(no transcript)') || chr(10) || chr(10) ||
                      '## Root cause hypothesis' || chr(10) || 'TBD' || chr(10) || chr(10) ||
                      '## Risk + rollback' || chr(10) || 'Low (p3 ticket).' || chr(10) || chr(10) ||
                      '_Generated by auto_triage routine._'
       WHERE id = r.id;
      v_specs := v_specs + 1;

    -- account_issue with low-risk keywords → Mira drafts resolution
    ELSIF r.kind = 'account_issue'
       AND COALESCE(r.raw_transcript, '') ~* '(password|email|verification|verify)' THEN
      UPDATE public.feedback_tickets
         SET status = 'spec_ready',
             resolver_agent = 'mira',
             resolution_md = '# Mira auto-draft resolution (placeholder)' || chr(10) ||
                            '## User report' || chr(10) || COALESCE(r.raw_transcript, '(no transcript)') || chr(10) || chr(10) ||
                            '## Proposed action' || chr(10) || 'Trigger password reset or resend verification email.' || chr(10) || chr(10) ||
                            '## Risk' || chr(10) || 'Low — runbook covered.' || chr(10) || chr(10) ||
                            '_Generated by auto_triage routine. Supervisor approves before action._'
       WHERE id = r.id;
      v_resolutions := v_resolutions + 1;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_answers, v_specs, v_resolutions;
END;
$$;

GRANT EXECUTE ON FUNCTION public.auto_triage_pending_feedback_tickets() TO service_role;
