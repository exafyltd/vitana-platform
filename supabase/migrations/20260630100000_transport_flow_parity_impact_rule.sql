-- =============================================================================
-- Dev Autopilot — register the 'transport-flow-parity' impact rule
-- =============================================================================
-- Seed row for scripts/ci/impact-rules/transport-flow-parity.mjs (authoritative
-- list: scripts/ci/impact-rules/registry.mjs). Keeps the Command Hub → Autopilot
-- → Impact Rules tab in sync with the code, per the
-- new-impact-rule-needs-seed-migration companion rule.
--
-- Conversation-flow roadmap v3, Step 1a: the transport-parity scanner. Severity
-- is 'warning' while the strangler-fig extraction (Steps 1a–1c) is in flight —
-- it reports fragmentation without blocking in-flight work. It flips to 'blocker'
-- at the end of Step 1c, when every transport delegates to the shared brain and
-- the inline wake_opener branch count reaches zero.
--
-- Re-runnable via ON CONFLICT DO UPDATE.
-- =============================================================================

INSERT INTO public.dev_autopilot_impact_rules
  (rule, title, description, category, severity, enabled)
VALUES
  ('transport-flow-parity',
   'Transport owns conversation-flow decision logic instead of delegating',
   'The conversation flow must be ONE transport-independent brain (services/gateway/src/services/conversation). Transports (routes/orb-live.ts = Vertex, routes/orb-livekit.ts = LiveKit) must be thin adapters: gather context, call the brain, render. This rule fires when a PR touching a transport file leaves its own register / recency / wake_opener decision logic inline (it counts the inline wake_opener branches plus per-language directive maps). Warning during the Step 1a-1c strangler-fig extraction; flips to blocker at the end of Step 1c when every surface delegates and the inline branch count reaches zero.',
   'semantic', 'warning', TRUE)
ON CONFLICT (rule) DO UPDATE SET
  title       = EXCLUDED.title,
  description = EXCLUDED.description,
  category    = EXCLUDED.category,
  severity    = EXCLUDED.severity,
  enabled     = EXCLUDED.enabled,
  updated_at  = NOW();
