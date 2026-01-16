-- Migration: Add Sentry MCP and Code Review skills
-- VTID-01177: Error tracking and automated code review

-- Insert Sentry MCP skills
INSERT INTO skills_mcp (skill_id, server, description, params_schema, visibility, tool_tier, tool_domain) VALUES
  ('sentry.list_issues', 'sentry-mcp', 'List recent errors/issues from Sentry',
   '{"project": "string?", "query": "string?", "status": "string?", "level": "string?", "limit": "number?"}', 'prod', 'specialty', 'sentry'),
  ('sentry.get_issue', 'sentry-mcp', 'Get detailed information about a specific Sentry issue',
   '{"issue_id": "string"}', 'prod', 'specialty', 'sentry'),
  ('sentry.get_stacktrace', 'sentry-mcp', 'Get full stacktrace and breadcrumbs for an issue',
   '{"issue_id": "string"}', 'prod', 'specialty', 'sentry'),
  ('sentry.search_similar', 'sentry-mcp', 'Find similar issues based on error message',
   '{"issue_id": "string?", "error_message": "string?", "limit": "number?"}', 'prod', 'specialty', 'sentry'),
  ('sentry.list_events', 'sentry-mcp', 'List events/occurrences for a specific issue',
   '{"issue_id": "string", "limit": "number?"}', 'prod', 'specialty', 'sentry')
ON CONFLICT (skill_id) DO UPDATE SET
  description = EXCLUDED.description,
  params_schema = EXCLUDED.params_schema,
  visibility = EXCLUDED.visibility,
  tool_tier = EXCLUDED.tool_tier,
  tool_domain = EXCLUDED.tool_domain,
  updated_at = NOW();

-- Insert Code Review skills
INSERT INTO skills_mcp (skill_id, server, description, params_schema, visibility, tool_tier, tool_domain) VALUES
  ('review.analyze_diff', 'code-review-agent', 'Analyze git diff for quality issues, patterns, and improvements',
   '{"diff": "string?", "base_ref": "string?", "head_ref": "string?", "paths": "array?"}', 'prod', 'specialty', 'code_review'),
  ('review.security_scan', 'code-review-agent', 'Deep security analysis of code changes',
   '{"paths": "array?", "depth": "string?"}', 'prod', 'specialty', 'code_review'),
  ('review.type_check', 'code-review-agent', 'Validate TypeScript types and patterns',
   '{"paths": "array?", "strict": "boolean?"}', 'prod', 'specialty', 'code_review'),
  ('review.lint_check', 'code-review-agent', 'Run ESLint and Prettier checks',
   '{"paths": "array?", "fix": "boolean?"}', 'prod', 'specialty', 'code_review'),
  ('review.suggest_improvements', 'code-review-agent', 'Generate improvement suggestions for code',
   '{"paths": "array?", "focus": "string?"}', 'prod', 'specialty', 'code_review')
ON CONFLICT (skill_id) DO UPDATE SET
  description = EXCLUDED.description,
  params_schema = EXCLUDED.params_schema,
  visibility = EXCLUDED.visibility,
  tool_tier = EXCLUDED.tool_tier,
  tool_domain = EXCLUDED.tool_domain,
  updated_at = NOW();
