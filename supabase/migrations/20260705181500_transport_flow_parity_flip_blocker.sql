-- =============================================================================
-- Dev Autopilot — flip 'transport-flow-parity' severity warning → blocker
-- =============================================================================
-- Conversation-flow roadmap v3, END of Step 1c (VTID-03366). The transport-parity
-- scanner (scripts/ci/impact-rules/transport-flow-parity.mjs) ran at 'warning'
-- throughout the Step 1a–1c strangler-fig extraction so it reported fragmentation
-- without blocking in-flight work. Step 1c is now complete: every Vertex opening
-- rung — the sync ladder (silent_reconnect / override_v2 / silenced_on_cadence /
-- legacy default) and the async safe-fast ladder (rungs 1–6) — delegates to the
-- shared brain (services/gateway/src/services/conversation/compute-greeting-decision.ts),
-- and routes/orb-live.ts carries ZERO inline wake_opener branches.
--
-- Flipping to 'blocker' turns the rule from a progress indicator into an
-- enforcement gate: any PR that reintroduces inline register / recency /
-- wake_opener decision logic into a transport (orb-live.ts / orb-livekit.ts)
-- now fails CI. Keeps the Command Hub → Autopilot → Impact Rules tab in sync
-- with the code (authoritative list: scripts/ci/impact-rules/registry.mjs).
--
-- Re-runnable via ON CONFLICT DO UPDATE.
-- =============================================================================

INSERT INTO public.dev_autopilot_impact_rules
  (rule, title, description, category, severity, enabled)
VALUES
  ('transport-flow-parity',
   'Transport owns conversation-flow decision logic instead of delegating',
   'The conversation flow must be ONE transport-independent brain (services/gateway/src/services/conversation). Transports (routes/orb-live.ts = Vertex, routes/orb-livekit.ts = LiveKit) must be thin adapters: gather context, call the brain, render. This rule fires when a PR touching a transport file leaves its own register / recency / wake_opener decision logic inline (it counts the inline wake_opener branches plus per-language directive maps). Blocker as of the end of Step 1c (VTID-03366): every Vertex opening rung (sync + safe-fast) now delegates and orb-live.ts carries zero inline branches, so the rule enforces "one brain, every surface" — reintroducing inline decision logic into a transport fails CI. (Was warning throughout the 1a-1c strangler-fig extraction.)',
   'semantic', 'blocker', TRUE)
ON CONFLICT (rule) DO UPDATE SET
  title       = EXCLUDED.title,
  description = EXCLUDED.description,
  category    = EXCLUDED.category,
  severity    = EXCLUDED.severity,
  enabled     = EXCLUDED.enabled,
  updated_at  = NOW();
