-- Migration: Create skills_mcp table
-- DEV-AGENT-0200.B

CREATE TABLE IF NOT EXISTS skills_mcp (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id TEXT UNIQUE NOT NULL,
  server TEXT NOT NULL,
  description TEXT NOT NULL,
  params_schema JSONB,
  enabled BOOLEAN DEFAULT true,
  visibility TEXT DEFAULT 'dev',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_skills_mcp_server ON skills_mcp(server);
CREATE INDEX idx_skills_mcp_enabled ON skills_mcp(enabled);

-- Insert all 21 skills
INSERT INTO skills_mcp (skill_id, server, description, params_schema, visibility) VALUES
  ('github.repo.get_file', 'github-mcp', 'Get file content from GitHub repository', 
   '{"repo": "string", "path": "string", "ref": "string?"}', 'prod'),
  ('github.repo.search_code', 'github-mcp', 'Search code in GitHub repositories', 
   '{"query": "string", "repo": "string?"}', 'prod'),
  ('github.pr.list', 'github-mcp', 'List pull requests in a repository', 
   '{"repo": "string", "state": "string?"}', 'prod'),
  ('github.pr.get', 'github-mcp', 'Get details of a specific pull request', 
   '{"repo": "string", "pr_number": "number"}', 'prod'),
  ('supabase.schema.list_tables', 'supabase-mcp', 'List all tables in Supabase database', 
   '{}', 'prod'),
  ('supabase.schema.get_table', 'supabase-mcp', 'Get schema of a specific table', 
   '{"table": "string"}', 'prod'),
  ('supabase.read_query', 'supabase-mcp', 'Execute read-only SQL query', 
   '{"query": "string"}', 'prod'),
  ('perplexity.ask', 'perplexity-mcp', 'Ask Perplexity AI a question', 
   '{"question": "string", "model": "string?"}', 'prod'),
  ('perplexity.research', 'perplexity-mcp', 'Conduct in-depth research on a topic', 
   '{"topic": "string", "depth": "string?"}', 'prod'),
  ('linear.issue.list', 'linear-mcp', 'List issues from Linear', 
   '{"teamId": "string?", "state": "string?", "limit": "number?"}', 'prod'),
  ('linear.issue.get', 'linear-mcp', 'Get a specific Linear issue', 
   '{"id": "string?", "identifier": "string?"}', 'prod'),
  ('linear.issue.update_status', 'linear-mcp', 'Update Linear issue status', 
   '{"issueId": "string", "stateId": "string"}', 'prod'),
  ('linear.issue.create', 'linear-mcp', 'Create a new Linear issue', 
   '{"teamId": "string", "title": "string", "description": "string?"}', 'prod'),
  ('context7.space.list', 'context7-mcp', 'List available knowledge spaces', 
   '{"includeArchived": "boolean?"}', 'prod'),
  ('context7.search', 'context7-mcp', 'Search across knowledge base', 
   '{"query": "string", "spaceId": "string?", "limit": "number?"}', 'prod'),
  ('context7.doc.get', 'context7-mcp', 'Get a specific document', 
   '{"docId": "string", "includeContent": "boolean?"}', 'prod'),
  ('context7.doc.search', 'context7-mcp', 'Search documents in a space', 
   '{"spaceId": "string", "query": "string"}', 'prod'),
  ('testsprite.run_tests', 'testsprite-mcp', 'Run automated tests for a VTID', 
   '{"vtid": "string", "testType": "string?", "branch": "string?"}', 'prod'),
  ('testsprite.debug_code', 'testsprite-mcp', 'Debug code with AI assistance', 
   '{"code": "string", "error": "string", "context": "string?"}', 'prod'),
  ('testsprite.test.status', 'testsprite-mcp', 'Get test execution status', 
   '{"testId": "string"}', 'prod'),
  ('testsprite.test.results', 'testsprite-mcp', 'Get detailed test results', 
   '{"testId": "string"}', 'prod');
