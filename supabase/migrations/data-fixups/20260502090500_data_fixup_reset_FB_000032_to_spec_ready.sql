-- DATA FIXUP — VTID-02669
--
-- FB-2026-05-000032 is currently `status='in_progress'` but
-- linked_finding_id is NULL (never made it through the bridge — the
-- earlier dispatch attempts hit safety-gate / integer-type bugs).
-- Under the Phase 7 contract, in_progress without linked_finding_id is
-- invalid: the ticket can't auto-close because nothing's running.
--
-- Reset to spec_ready so the supervisor's next Activate goes through the
-- new atomic dispatch path: it will pre-flight Devon's spec against
-- allow_scope, dispatch on success, or return structured violations on
-- failure. supervisor_notes + spec_md are preserved.

UPDATE public.feedback_tickets
SET
  status = 'spec_ready',
  linked_finding_id = NULL,
  resolved_at = NULL,
  auto_resolved = FALSE
WHERE
  ticket_number = 'FB-2026-05-000032'
  AND status = 'in_progress'
  AND linked_finding_id IS NULL;

-- Sanity check
SELECT
  ticket_number,
  kind,
  status,
  spec_md IS NOT NULL AS spec_present,
  supervisor_notes IS NOT NULL AS notes_present,
  linked_finding_id IS NULL AS no_link
FROM public.feedback_tickets
WHERE ticket_number = 'FB-2026-05-000032';
