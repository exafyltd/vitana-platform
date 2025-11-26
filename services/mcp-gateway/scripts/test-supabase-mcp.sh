#!/bin/bash
# =============================================================================
# VTID-0514: Supabase MCP Connector Test Script
# Tests the hardened connector against live Cloud Run service
# =============================================================================

set -e

# Service URL
SERVICE_URL="${MCP_GATEWAY_URL:-https://mcp-gateway-q74ibpv6ia-uc.a.run.app}"

echo "=============================================="
echo "Supabase MCP Connector Tests"
echo "Service: $SERVICE_URL"
echo "=============================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASS_COUNT=0
FAIL_COUNT=0

# Test function
run_test() {
    local test_name="$1"
    local method="$2"
    local params="$3"
    local expect_ok="$4"
    local expect_contains="$5"

    echo -e "${YELLOW}Test: $test_name${NC}"
    echo "Method: $method"
    echo "Params: $params"

    response=$(curl -s -X POST "$SERVICE_URL/mcp/call" \
        -H "Content-Type: application/json" \
        -d "{\"server\": \"supabase-mcp\", \"method\": \"$method\", \"params\": $params}")

    echo "Response: $response"

    # Check if ok matches expected
    ok_value=$(echo "$response" | jq -r '.ok')

    if [ "$expect_ok" = "true" ] && [ "$ok_value" = "true" ]; then
        if [ -n "$expect_contains" ]; then
            if echo "$response" | grep -q "$expect_contains"; then
                echo -e "${GREEN}PASS${NC}"
                ((PASS_COUNT++))
            else
                echo -e "${RED}FAIL - Expected response to contain: $expect_contains${NC}"
                ((FAIL_COUNT++))
            fi
        else
            echo -e "${GREEN}PASS${NC}"
            ((PASS_COUNT++))
        fi
    elif [ "$expect_ok" = "false" ] && [ "$ok_value" = "false" ]; then
        if [ -n "$expect_contains" ]; then
            if echo "$response" | grep -q "$expect_contains"; then
                echo -e "${GREEN}PASS${NC}"
                ((PASS_COUNT++))
            else
                echo -e "${RED}FAIL - Expected error to contain: $expect_contains${NC}"
                ((FAIL_COUNT++))
            fi
        else
            echo -e "${GREEN}PASS${NC}"
            ((PASS_COUNT++))
        fi
    else
        echo -e "${RED}FAIL - Expected ok=$expect_ok, got ok=$ok_value${NC}"
        ((FAIL_COUNT++))
    fi
    echo ""
}

# =============================================================================
# Test 1: schema.list_tables
# =============================================================================
run_test "schema.list_tables - List allowed tables" \
    "schema.list_tables" \
    "{}" \
    "true" \
    "oasis_events"

# =============================================================================
# Test 2: schema.get_table - Valid table
# =============================================================================
run_test "schema.get_table - Get oasis_events schema" \
    "schema.get_table" \
    '{"table": "oasis_events"}' \
    "true" \
    "columns"

# =============================================================================
# Test 3: read_query - Basic query
# =============================================================================
run_test "read_query - Basic query on oasis_events" \
    "read_query" \
    '{"table": "oasis_events", "limit": 5}' \
    "true" \
    ""

# =============================================================================
# Test 4: read_query - With filters
# =============================================================================
run_test "read_query - Query with filters" \
    "read_query" \
    '{"table": "oasis_events", "filters": [{"column": "id", "op": "gt", "value": 0}], "limit": 3}' \
    "true" \
    ""

# =============================================================================
# Test 5: read_query - With select columns
# =============================================================================
run_test "read_query - Query with select" \
    "read_query" \
    '{"table": "oasis_events", "select": ["id"], "limit": 2}' \
    "true" \
    ""

# =============================================================================
# Test 6: SECURITY - Non-whitelisted table
# =============================================================================
run_test "SECURITY - Reject non-whitelisted table 'users'" \
    "read_query" \
    '{"table": "users", "limit": 1}' \
    "false" \
    "not in whitelist"

# =============================================================================
# Test 7: SECURITY - Invalid column name (SQL injection attempt)
# =============================================================================
run_test "SECURITY - Reject invalid column name" \
    "read_query" \
    '{"table": "oasis_events", "select": ["id; DROP TABLE users;--"], "limit": 1}' \
    "false" \
    "Invalid column name"

# =============================================================================
# Test 8: SECURITY - Invalid filter operator
# =============================================================================
run_test "SECURITY - Reject invalid filter operator" \
    "read_query" \
    '{"table": "oasis_events", "filters": [{"column": "id", "op": "DROP", "value": 1}], "limit": 1}' \
    "false" \
    "Invalid filter operator"

# =============================================================================
# Summary
# =============================================================================
echo "=============================================="
echo "TEST SUMMARY"
echo "=============================================="
echo -e "Passed: ${GREEN}$PASS_COUNT${NC}"
echo -e "Failed: ${RED}$FAIL_COUNT${NC}"
echo ""

if [ $FAIL_COUNT -eq 0 ]; then
    echo -e "${GREEN}ALL TESTS PASSED!${NC}"
    exit 0
else
    echo -e "${RED}SOME TESTS FAILED!${NC}"
    exit 1
fi
