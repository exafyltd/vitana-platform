-- =============================================================================
-- Dev Autopilot — register the 'conversation-flow-change-needs-test' impact rule
-- =============================================================================
-- Seed row for scripts/ci/impact-rules/conversation-flow-change-needs-test.mjs
-- (authoritative list: scripts/ci/impact-rules/registry.mjs). Keeps the Command
-- Hub → Autopilot → Impact Rules tab in sync with the code, per the
-- new-impact-rule-needs-seed-migration companion rule.
--
-- Re-runnable via ON CONFLICT DO UPDATE.
-- =============================================================================

INSERT INTO public.dev_autopilot_impact_rules
  (rule, title, description, category, severity, enabled)
VALUES
  ('conversation-flow-change-needs-test',
   'Conversation-flow change without a flow test',
   'The conversation flow is the product: any change to how Vitana decides what to say / which guided-journey session to surface / what context she carries (services/gateway/src/services/conversation, assistant-continuation, guide, guided-journey, orb-tools-shared.ts, orb/live/instruction, live-session-controller.ts) MUST ship with a conversation-flow test under services/gateway/test/ in the same PR. Mirrors new-route-needs-test but as a hard gate for the flow surface, so behaviour like "offer session 1 while the user is on session 10" can never silently regress. Escape hatch for behaviour-free edits: flow-test-exempt: <reason> in a changed flow file.',
   'companion', 'blocker', TRUE)
ON CONFLICT (rule) DO UPDATE SET
  title       = EXCLUDED.title,
  description = EXCLUDED.description,
  category    = EXCLUDED.category,
  severity    = EXCLUDED.severity,
  enabled     = EXCLUDED.enabled,
  updated_at  = NOW();
