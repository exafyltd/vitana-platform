-- Migration: Add Tool Registry MCP skills
-- VTID-01178: Context Pollution Management
--
-- NOTE: tool.filter is metadata + text filtering, NOT semantic search
-- tool.semantic_search will use embeddings when Qdrant is configured

-- Add tool_tier and tool_domain columns for hierarchical loading
ALTER TABLE skills_mcp ADD COLUMN IF NOT EXISTS tool_tier TEXT DEFAULT 'specialty';
ALTER TABLE skills_mcp ADD COLUMN IF NOT EXISTS tool_domain TEXT;

-- Create index for tier-based queries
CREATE INDEX IF NOT EXISTS idx_skills_mcp_tier ON skills_mcp(tool_tier);
CREATE INDEX IF NOT EXISTS idx_skills_mcp_domain ON skills_mcp(tool_domain);

-- Insert Tool Registry MCP skills
INSERT INTO skills_mcp (skill_id, server, description, params_schema, visibility, tool_tier) VALUES
  ('tool.filter', 'tool-registry-mcp', 'Filter tools by metadata and text matching (NOT semantic search)',
   '{"query": "string", "domain": "string?", "tier": "string?", "limit": "number?", "caller": "object"}', 'prod', 'essential'),
  ('tool.semantic_search', 'tool-registry-mcp', 'Semantic search using embeddings (falls back to filter if Qdrant unavailable)',
   '{"query": "string", "limit": "number?", "caller": "object"}', 'prod', 'essential'),
  ('tool.get_schema', 'tool-registry-mcp', 'Get specific tool definition with visibility gating and audit logging',
   '{"tool_id": "string", "caller": "object"}', 'prod', 'essential'),
  ('tool.suggest', 'tool-registry-mcp', 'Suggest tools based on task description and detected domains',
   '{"task_description": "string", "vtid": "string?", "include_essential": "boolean?", "caller": "object"}', 'prod', 'essential'),
  ('tool.list_tier', 'tool-registry-mcp', 'List tools by tier (essential/domain/specialty)',
   '{"tier": "string", "domain": "string?", "caller": "object"}', 'prod', 'essential'),
  ('tool.batch_load', 'tool-registry-mcp', 'Batch load multiple tool schemas with visibility gating',
   '{"tool_ids": "array", "caller": "object"}', 'prod', 'essential')
ON CONFLICT (skill_id) DO UPDATE SET
  description = EXCLUDED.description,
  params_schema = EXCLUDED.params_schema,
  visibility = EXCLUDED.visibility,
  tool_tier = EXCLUDED.tool_tier,
  updated_at = NOW();

-- Remove deprecated tool.search if it exists
DELETE FROM skills_mcp WHERE skill_id = 'tool.search';

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
