-- VTID-02669: Feedback Autonomous Close.
--
-- Adds the playwright_verified flag the completion reconciler stamps when
-- the dev autopilot execution that closed the ticket was followed by a
-- successful playwright.visual.success / deploy.gateway.success OASIS
-- event in the verification window.
--
-- The drawer renders a green "✓ Visually verified" chip alongside the
-- Completed stage of the progress bar when this is true.

ALTER TABLE public.feedback_tickets
  ADD COLUMN IF NOT EXISTS playwright_verified BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.feedback_tickets.playwright_verified IS
  'VTID-02669: stamped TRUE by feedback-completion-reconciler.ts when an '
  'OASIS event (playwright.visual.success or deploy.gateway.success) was '
  'recorded within 30 min of the linked autopilot execution closing. '
  'Surfaces as a green chip in the supervisor drawer next to the Completed '
  'progress-bar stage.';
