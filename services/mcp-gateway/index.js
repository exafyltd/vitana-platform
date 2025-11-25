const express = require('express');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'mcp-gateway', timestamp: new Date().toISOString() });
});

app.get('/mcp/health', (req, res) => {
  res.json({ 
    status: 'ok',
    connectors: [
      { name: 'github-mcp', status: 'ok' },
      { name: 'supabase-mcp', status: 'ok' }
    ]
  });
});

app.listen(PORT, () => {
  console.log(`MCP Gateway listening on port ${PORT}`);
});
