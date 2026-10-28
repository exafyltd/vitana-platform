-- VTID-04503 (Community Autopilot CA-3): a suggestion can carry a typed action.
--
-- { "kind": "<registry kind>", "params": { ... } }
-- Kinds are defined in services/gateway/src/services/community-autopilot/action-registry.ts
-- (a closed list; unknown kinds are ignored). NULL = informational suggestion.
-- Additive and nullable; no existing row changes.

ALTER TABLE public.autopilot_recommendations
  ADD COLUMN IF NOT EXISTS action jsonb;

COMMENT ON COLUMN public.autopilot_recommendations.action IS
  'VTID-04503: typed executable action {kind, params}; NULL = informational. Executed once per suggestion, recorded in agent_runs (plane community_autopilot).';
