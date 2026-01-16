-- Migration: Register VTID-01178 in OASIS Ledger
-- Purpose: Make Tool Registry MCP, Sentry MCP, and Code Review Agent visible in Command Hub

INSERT INTO vtid_ledger (
  vtid,
  title,
  status,
  tenant,
  layer,
  module,
  task_family,
  task_type,
  summary,
  description,
  is_test,
  metadata,
  created_at,
  updated_at
) VALUES (
  'VTID-01178',
  'Context Pollution Management: Tool Registry, Sentry MCP, Code Review Agent',
  'in_progress',
  'vitana',
  'DEV',
  'AICOR',
  'DEV',
  'FEATURE',
  'Dynamic tool loading to reduce context usage at scale',
  E'## Deliverables\n\n### Tool Registry MCP\n- tool.filter: Metadata + text filtering (NOT semantic search)\n- tool.semantic_search: Embedding-based search (falls back to filter until Qdrant ready)\n- tool.get_schema: Get tool definition with visibility gating + OASIS audit\n- tool.suggest: Suggest tools based on task description\n- tool.list_tier: List tools by tier (essential/domain/specialty)\n- tool.batch_load: Batch load schemas with visibility gating\n\n### Sentry MCP\n- sentry.list_issues: List recent errors\n- sentry.get_issue: Get issue details\n- sentry.get_stacktrace: Get full stacktrace + breadcrumbs\n- sentry.search_similar: Find similar issues\n- sentry.list_events: List events for an issue\n\n### Code Review Agent\n- Pre-merge gate in orchestrator pipeline\n- Security, performance, quality, style checks\n- Blocking severities: CRITICAL, HIGH\n- Wired into routing.yaml\n\n### Security\n- Visibility gating (public/dev/prod/internal/admin)\n- Caller role validation\n- OASIS audit logging for all schema fetches\n\n## Files\n- services/mcp-gateway/src/connectors/tool-registry-mcp.ts\n- services/mcp-gateway/src/connectors/sentry-mcp.ts\n- services/mcp-gateway/config/tool-tiers.yaml\n- services/mcp-gateway/migrations/002_add_tool_registry_skills.sql\n- services/mcp-gateway/migrations/003_add_sentry_and_review_skills.sql\n- services/agents/workforce/subagents/code-review/agent.yaml\n- services/agents/workforce/subagents/worker-orchestrator/routing.yaml',
  false,
  jsonb_build_object(
    'source', 'claude-code',
    'branch', 'claude/analyze-agents-mcps-skills-35c5R',
    'components', jsonb_build_array(
      'tool-registry-mcp',
      'sentry-mcp',
      'code-review-agent'
    ),
    'new_skills', 16,
    'new_mcps', 2,
    'new_agents', 1
  ),
  NOW(),
  NOW()
)
ON CONFLICT (vtid) DO UPDATE SET
  title = EXCLUDED.title,
  status = EXCLUDED.status,
  summary = EXCLUDED.summary,
  description = EXCLUDED.description,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

-- Also update the sequence if needed to avoid collision
-- (only if current value is less than 1178)
DO $$
DECLARE
  current_val BIGINT;
BEGIN
  SELECT last_value INTO current_val FROM global_vtid_seq;
  IF current_val < 1178 THEN
    PERFORM setval('global_vtid_seq', 1178, true);
  END IF;
END $$;
