-- Migration: Add Tool Registry MCP skills
-- VTID-01177: Context Pollution Management

-- Add tool_tier and tool_domain columns for hierarchical loading
ALTER TABLE skills_mcp ADD COLUMN IF NOT EXISTS tool_tier TEXT DEFAULT 'specialty';
ALTER TABLE skills_mcp ADD COLUMN IF NOT EXISTS tool_domain TEXT;

-- Create index for tier-based queries
CREATE INDEX IF NOT EXISTS idx_skills_mcp_tier ON skills_mcp(tool_tier);
CREATE INDEX IF NOT EXISTS idx_skills_mcp_domain ON skills_mcp(tool_domain);

-- Insert Tool Registry MCP skills
INSERT INTO skills_mcp (skill_id, server, description, params_schema, visibility, tool_tier) VALUES
  ('tool.search', 'tool-registry-mcp', 'Semantic search for relevant tools based on task description',
   '{"query": "string", "domain": "string?", "tier": "string?", "limit": "number?"}', 'prod', 'essential'),
  ('tool.get_schema', 'tool-registry-mcp', 'Get specific tool definition and parameters',
   '{"tool_id": "string"}', 'prod', 'essential'),
  ('tool.suggest', 'tool-registry-mcp', 'AI-suggested tools based on task description and detected domains',
   '{"task_description": "string", "vtid": "string?", "include_essential": "boolean?"}', 'prod', 'essential'),
  ('tool.list_tier', 'tool-registry-mcp', 'List tools by tier (essential/domain/specialty)',
   '{"tier": "string", "domain": "string?"}', 'prod', 'essential'),
  ('tool.batch_load', 'tool-registry-mcp', 'Batch load multiple tool schemas efficiently to minimize context usage',
   '{"tool_ids": "array"}', 'prod', 'essential')
ON CONFLICT (skill_id) DO UPDATE SET
  description = EXCLUDED.description,
  params_schema = EXCLUDED.params_schema,
  visibility = EXCLUDED.visibility,
  tool_tier = EXCLUDED.tool_tier,
  updated_at = NOW();

-- Update existing skills with tier information
UPDATE skills_mcp SET tool_tier = 'specialty', tool_domain = 'github'
WHERE server = 'github-mcp';

UPDATE skills_mcp SET tool_tier = 'specialty', tool_domain = 'supabase'
WHERE server = 'supabase-mcp';

UPDATE skills_mcp SET tool_tier = 'specialty', tool_domain = 'perplexity'
WHERE server = 'perplexity-mcp';

UPDATE skills_mcp SET tool_tier = 'specialty', tool_domain = 'linear'
WHERE server = 'linear-mcp';

UPDATE skills_mcp SET tool_tier = 'specialty', tool_domain = 'context7'
WHERE server = 'context7-mcp';

UPDATE skills_mcp SET tool_tier = 'specialty', tool_domain = 'testsprite'
WHERE server = 'testsprite-mcp';
