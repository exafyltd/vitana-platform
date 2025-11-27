#!/bin/bash
set -e
MCP_URL="${MCP_URL:-https://mcp-gateway-q74ibpv6ia-uc.a.run.app}"

echo "🧪 Testing Supabase MCP Connector against $MCP_URL"
echo ""

# Test 1: list_tables
echo "Test 1: supabase.schema.list_tables"
curl -s -X POST "$MCP_URL/mcp/call" \
  -H "Content-Type: application/json" \
  -d '{
    "server": "supabase-mcp",
    "method": "schema.list_tables",
    "params": {}
  }' | jq .
echo ""

# Test 2: get_table
echo "Test 2: supabase.schema.get_table (oasis_events)"
curl -s -X POST "$MCP_URL/mcp/call" \
  -H "Content-Type: application/json" \
  -d '{
    "server": "supabase-mcp",
    "method": "schema.get_table",
    "params": {"table": "oasis_events"}
  }' | jq .
echo ""

# Test 3: read_query
echo "Test 3: supabase.read_query (oasis_events, limit 1)"
curl -s -X POST "$MCP_URL/mcp/call" \
  -H "Content-Type: application/json" \
  -d '{
    "server": "supabase-mcp",
    "method": "read_query",
    "params": {
      "table": "oasis_events",
      "limit": 1,
      "order": [{"column": "created_at", "direction": "desc"}]
    }
  }' | jq .
echo ""

# Test 4: read_query (oasis_specs)
echo "Test 4: supabase.read_query (oasis_specs, limit 1)"
curl -s -X POST "$MCP_URL/mcp/call" \
  -H "Content-Type: application/json" \
  -d '{
    "server": "supabase-mcp",
    "method": "read_query",
    "params": {
      "table": "oasis_specs",
      "limit": 1
    }
  }' | jq .
echo ""

# Test 5: invalid table
echo "Test 5: Security - reject non-whitelisted table"
curl -s -X POST "$MCP_URL/mcp/call" \
  -H "Content-Type: application/json" \
  -d '{
    "server": "supabase-mcp",
    "method": "read_query",
    "params": {
      "table": "pg_user",
      "limit": 1
    }
  }' | jq .
echo ""

echo "✅ All tests complete"
