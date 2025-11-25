# MCP Gateway - Complete Integration (Wave A + B)

**VTIDs:** DEV-AGENT-0200, DEV-AGENT-0201, DEV-AGENT-0202

Complete MCP integration for Vitana platform with all 6 connectors:
- ✅ GitHub MCP (Wave A)
- ✅ Supabase MCP (Wave A)
- ✅ Perplexity MCP (Wave B)
- ✅ Linear MCP (Wave B)
- ✅ Context7 MCP (Wave B)
- ✅ Testsprite MCP (Wave B)

## API Endpoints

### Health Check
```bash
GET /health
Response: { status: "ok", service: "mcp-gateway", timestamp: "..." }
```

### MCP Health
```bash
GET /mcp/health
Response: {
  status: "ok",
  connectors: [
    { name: "github-mcp", status: "ok" },
    { name: "supabase-mcp", status: "ok" },
    { name: "perplexity-mcp", status: "ok" },
    { name: "linear-mcp", status: "ok" },
    { name: "context7-mcp", status: "ok" },
    { name: "testsprite-mcp", status: "ok" }
  ]
}
```

### MCP Call
```bash
POST /mcp/call
Body: {
  "server": "testsprite-mcp",
  "method": "run_tests",
  "params": {
    "vtid": "DEV-CICDL-0031",
    "testType": "unit"
  }
}

Response: {
  "ok": true,
  "result": { ... },
  "latency_ms": 123
}
```

## Skills Inventory

### GitHub (4 skills)
1. `github.repo.get_file` - Get file content
2. `github.repo.search_code` - Search code
3. `github.pr.list` - List pull requests
4. `github.pr.get` - Get PR details

### Supabase (3 skills)
1. `supabase.schema.list_tables` - List database tables
2. `supabase.schema.get_table` - Get table schema
3. `supabase.read_query` - Execute SELECT queries

### Perplexity (2 skills)
1. `perplexity.ask` - Ask AI questions
2. `perplexity.research` - Conduct research

### Linear (4 skills)
1. `linear.issue.list` - List issues
2. `linear.issue.get` - Get issue details
3. `linear.issue.update_status` - Update status
4. `linear.issue.create` - Create issue

### Context7 (4 skills)
1. `context7.space.list` - List spaces
2. `context7.search` - Search knowledge base
3. `context7.doc.get` - Get document
4. `context7.doc.search` - Search documents

### Testsprite (4 skills)
1. `testsprite.run_tests` - Run tests
2. `testsprite.debug_code` - Debug code
3. `testsprite.test.status` - Get status
4. `testsprite.test.results` - Get results

**Total: 21 skills across 6 connectors**

## Environment Variables

Required (store in GCP Secret Manager):
- `GITHUB_MCP_TOKEN` - GitHub Personal Access Token
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key
- `PERPLEXITY_API_KEY` - Perplexity API key
- `LINEAR_API_KEY` - Linear API key
- `CONTEXT7_API_KEY` - Context7 API key
- `TESTSPRITE_API_KEY` - Testsprite API key
- `GATEWAY_URL` - Gateway service URL

## Deployment

See GitHub Actions workflow in `.github/workflows/deploy-mcp-gateway.yml`

Auto-deploys on push to main/develop when `services/mcp-gateway/**` changes.

## Status

✅ Wave A Complete (GitHub + Supabase)
✅ Wave B Complete (Perplexity + Linear + Context7 + Testsprite)
✅ Test Agent Integration (DEV-AGENT-0201)
✅ QR Agent Integration (DEV-AGENT-0202)
