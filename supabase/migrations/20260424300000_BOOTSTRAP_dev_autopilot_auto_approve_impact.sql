-- =============================================================================
-- Dev Autopilot — auto-approve for impact findings
-- =============================================================================
-- PR #869 added auto_approve_* columns for the baseline scanners. Impact
-- findings (source_type='dev_autopilot_impact') were deliberately excluded
-- so operators could validate the PR-time → autopilot queue flow by hand
-- before trusting it to self-drive.
--
-- This migration adds the second (independent) gate: an enabled flag + an
-- explicit per-rule allowlist. Two separate toggles so baseline and impact
-- auto-approval evolve independently.
--
--   auto_approve_impact_enabled   operator master switch (default FALSE)
--   auto_approve_impact_rules[]   allowlist of impact rule ids that are
--                                 OK to auto-approve (default empty — every
--                                 rule is manual-only until explicitly opted in)
--
-- Unlike the baseline auto-approve gate, the impact gate does NOT filter
-- by risk_class or effort_score. The operator's presence in the allowlist
-- IS the approval signal: you don't name a rule in there unless you trust
-- the autopilot to fix it.
--
-- The UI to build + extend the list lives at:
--   Command Hub → Autopilot → Auto-Approve
-- =============================================================================

ALTER TABLE public.dev_autopilot_config
  ADD COLUMN IF NOT EXISTS auto_approve_impact_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auto_approve_impact_rules   TEXT[]  NOT NULL DEFAULT ARRAY[]::text[];
