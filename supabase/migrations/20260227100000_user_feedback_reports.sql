-- =============================================================================
-- User Feedback Reports: Test user bug reports & UX improvement suggestions
-- Dictated via voice on the Wellness Diary screen, sent to Exafy team,
-- ingested to Command Hub for task creation.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.user_feedback_reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id     UUID REFERENCES public.tenants(tenant_id) ON DELETE SET NULL,

  -- Report content
  transcript    TEXT NOT NULL CHECK (char_length(transcript) > 0),
  report_type   TEXT NOT NULL DEFAULT 'bug_report'
                CHECK (report_type IN ('bug_report', 'ux_improvement')),
  severity      TEXT NOT NULL DEFAULT 'medium'
                CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  affected_screen TEXT,                         -- e.g. 'memory/diary', 'community/events'
  attachments   TEXT[] DEFAULT '{}',            -- signed URLs to screenshots

  -- Lifecycle
  status        TEXT NOT NULL DEFAULT 'received'
                CHECK (status IN ('received', 'under_review', 'in_progress', 'fixed', 'wont_fix', 'duplicate')),
  vtid          TEXT,                           -- populated when converted to Command Hub task
  admin_notes   TEXT,                           -- internal notes from Exafy team

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_user_feedback_reports_user    ON public.user_feedback_reports(user_id);
CREATE INDEX idx_user_feedback_reports_status  ON public.user_feedback_reports(status);
CREATE INDEX idx_user_feedback_reports_created ON public.user_feedback_reports(created_at DESC);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.user_feedback_reports_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_user_feedback_reports_updated_at
  BEFORE UPDATE ON public.user_feedback_reports
  FOR EACH ROW EXECUTE FUNCTION public.user_feedback_reports_updated_at();

-- =============================================================================
-- RLS: Users insert + read own reports; staff/admin read all + update status
-- =============================================================================
ALTER TABLE public.user_feedback_reports ENABLE ROW LEVEL SECURITY;

-- Users can insert their own reports
CREATE POLICY user_feedback_reports_insert_own
  ON public.user_feedback_reports FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can read their own reports
CREATE POLICY user_feedback_reports_select_own
  ON public.user_feedback_reports FOR SELECT
  USING (auth.uid() = user_id);

-- Service role can do everything (for Gateway admin endpoints)
CREATE POLICY user_feedback_reports_service_role
  ON public.user_feedback_reports FOR ALL
  USING (auth.role() = 'service_role');
