import express from 'express';
import cors from 'cors';
import { githubMcpConnector } from './connectors/github-mcp';
import { supabaseMcpConnector } from './connectors/supabase-mcp';
import { perplexityMcpConnector } from './connectors/perplexity-mcp';
import { linearMcpConnector } from './connectors/linear-mcp';
import { context7McpConnector } from './connectors/context7-mcp';
import { testspriteMcpConnector } from './connectors/testsprite-mcp';

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

const connectors: Record<string, any> = {
  'github-mcp': githubMcpConnector,
  'supabase-mcp': supabaseMcpConnector,
  'perplexity-mcp': perplexityMcpConnector,
  'linear-mcp': linearMcpConnector,
  'context7-mcp': context7McpConnector,
  'testsprite-mcp': testspriteMcpConnector,
};

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'mcp-gateway',
    timestamp: new Date().toISOString(),
  });
});

app.get('/mcp/health', async (req, res) => {
  const connectorStatus = await Promise.all(
    Object.entries(connectors).map(async ([name, connector]) => {
      try {
        const health = await connector.health?.() || { status: 'unknown' };
        return { name, ...health };
      } catch (error) {
        return { name, status: 'error', error: String(error) };
      }
    })
  );
  res.json({
    status: 'ok',
    connectors: connectorStatus,
    timestamp: new Date().toISOString(),
  });
});

app.get('/skills/mcp', async (req, res) => {
  // Return hardcoded skills list for now (until table is created)
  const skills = [
    { skill_id: 'github.repo.get_file', server: 'github-mcp', description: 'Get file from repo' },
    { skill_id: 'github.repo.search_code', server: 'github-mcp', description: 'Search code' },
    { skill_id: 'github.pr.list', server: 'github-mcp', description: 'List PRs' },
    { skill_id: 'github.pr.get', server: 'github-mcp', description: 'Get PR details' },
    { skill_id: 'supabase.schema.list_tables', server: 'supabase-mcp', description: 'List tables' },
    { skill_id: 'supabase.schema.get_table', server: 'supabase-mcp', description: 'Get table schema' },
  ];
  res.json({
    ok: true,
    skills,
    count: skills.length,
    timestamp: new Date().toISOString(),
  });
});

app.post('/mcp/call', async (req, res) => {
  const { server, method, params } = req.body;
  if (!server || !method) {
    return res.status(400).json({
      ok: false,
      error: 'Missing required fields: server, method',
    });
  }
  const connector = connectors[server];
  if (!connector) {
    return res.status(404).json({
      ok: false,
      error: `Unknown server: ${server}`,
    });
  }
  const startTime = Date.now();
  try {
    const result = await connector.call(method, params || {});
    const latency_ms = Date.now() - startTime;
    res.json({
      ok: true,
      result,
      latency_ms,
    });
  } catch (error: any) {
    const latency_ms = Date.now() - startTime;
    res.status(500).json({
      ok: false,
      error: error.message,
      latency_ms,
    });
  }
});

app.listen(PORT, () => {
  console.log(`MCP Gateway listening on port ${PORT}`);
  console.log(`Endpoints: /health, /mcp/health, /skills/mcp, /mcp/call`);
});
