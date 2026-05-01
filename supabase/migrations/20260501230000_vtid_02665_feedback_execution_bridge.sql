-- VTID-02665: Feedback execution bridge.
-- When a tenant admin Activates a bug/ux_issue ticket, the gateway now
-- creates a row in autopilot_recommendations and bridges it to a
-- dev_autopilot_executions row. We need a column on feedback_tickets
-- to point at the resulting recommendation so the supervisor's drawer
-- can show "dispatched to dev autopilot, execution ID xxx" and so we
-- never accidentally dispatch the same ticket twice.

ALTER TABLE public.feedback_tickets
  ADD COLUMN IF NOT EXISTS linked_finding_id UUID
    REFERENCES public.autopilot_recommendations(id)
    ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_feedback_tickets_linked_finding_id
  ON public.feedback_tickets (linked_finding_id)
  WHERE linked_finding_id IS NOT NULL;

COMMENT ON COLUMN public.feedback_tickets.linked_finding_id IS
  'VTID-02665: when /activate dispatches a bug/ux_issue ticket through '
  'the dev autopilot pipeline, the resulting autopilot_recommendations.id '
  'is stored here. Single source of truth for "is this ticket already '
  'dispatched?" — used to make Activate idempotent.';
