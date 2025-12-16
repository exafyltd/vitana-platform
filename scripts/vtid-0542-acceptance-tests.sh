#!/bin/bash
# VTID-0542 Acceptance Tests
# Run these tests after deploying the allocator to verify correct operation

set -e

GATEWAY_URL="${GATEWAY_URL:-https://vitana-gateway-86804897789.us-central1.run.app}"
FAILED=0

echo "========================================="
echo "VTID-0542: Global VTID Allocator Tests"
echo "========================================="
echo "Gateway: $GATEWAY_URL"
echo ""

# Test 1: Check allocator status
echo "Test 1: Check allocator status endpoint"
echo "----------------------------------------"
STATUS=$(curl -s "$GATEWAY_URL/api/v1/vtid/allocator/status")
echo "Response: $STATUS"
ENABLED=$(echo "$STATUS" | jq -r '.enabled')
echo "Allocator enabled: $ENABLED"
echo ""

# Test 2: Verify VTID-0542 exists in OASIS
echo "Test 2: Verify VTID-0542 registered in OASIS"
echo "--------------------------------------------"
VTID_RESPONSE=$(curl -s "$GATEWAY_URL/api/v1/vtid/VTID-0542")
echo "Response: $VTID_RESPONSE"
OK=$(echo "$VTID_RESPONSE" | jq -r '.ok')
if [ "$OK" = "true" ]; then
    echo "✓ VTID-0542 exists in OASIS"
else
    echo "✗ VTID-0542 not found - run scripts/vtid-0542-register.sql first"
    FAILED=$((FAILED+1))
fi
echo ""

# Test 3: Test allocator disabled (409) or enabled (201)
echo "Test 3: Test allocator endpoint"
echo "-------------------------------"
ALLOC_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$GATEWAY_URL/api/v1/vtid/allocate" \
    -H "Content-Type: application/json" \
    -d '{"source":"acceptance-test","layer":"DEV","module":"TEST"}')
HTTP_CODE=$(echo "$ALLOC_RESPONSE" | tail -1)
BODY=$(echo "$ALLOC_RESPONSE" | head -n -1)
echo "HTTP Code: $HTTP_CODE"
echo "Response: $BODY"

if [ "$HTTP_CODE" = "409" ]; then
    ERROR=$(echo "$BODY" | jq -r '.error')
    if [ "$ERROR" = "allocator_disabled" ]; then
        echo "✓ Allocator correctly returns 409 when disabled"
    else
        echo "✗ Unexpected 409 error: $ERROR"
        FAILED=$((FAILED+1))
    fi
elif [ "$HTTP_CODE" = "201" ]; then
    VTID=$(echo "$BODY" | jq -r '.vtid')
    NUM=$(echo "$BODY" | jq -r '.num')
    echo "✓ Allocator returned VTID: $VTID (num: $NUM)"

    # Verify the VTID was created in ledger
    VERIFY=$(curl -s "$GATEWAY_URL/api/v1/vtid/$VTID")
    VERIFY_OK=$(echo "$VERIFY" | jq -r '.ok')
    if [ "$VERIFY_OK" = "true" ]; then
        echo "✓ Allocated VTID exists in ledger"
    else
        echo "✗ Allocated VTID not found in ledger"
        FAILED=$((FAILED+1))
    fi
else
    echo "✗ Unexpected HTTP code: $HTTP_CODE"
    FAILED=$((FAILED+1))
fi
echo ""

# Test 4: Test parallel allocations (if allocator enabled)
if [ "$HTTP_CODE" = "201" ]; then
    echo "Test 4: Test parallel allocation uniqueness"
    echo "-------------------------------------------"

    # Run two allocations in parallel
    ALLOC1=$(curl -s -X POST "$GATEWAY_URL/api/v1/vtid/allocate" \
        -H "Content-Type: application/json" \
        -d '{"source":"parallel-test-1"}' &)
    ALLOC2=$(curl -s -X POST "$GATEWAY_URL/api/v1/vtid/allocate" \
        -H "Content-Type: application/json" \
        -d '{"source":"parallel-test-2"}' &)
    wait

    VTID1=$(echo "$ALLOC1" | jq -r '.vtid // empty')
    VTID2=$(echo "$ALLOC2" | jq -r '.vtid // empty')
    NUM1=$(echo "$ALLOC1" | jq -r '.num // empty')
    NUM2=$(echo "$ALLOC2" | jq -r '.num // empty')

    echo "Allocation 1: $VTID1 (num: $NUM1)"
    echo "Allocation 2: $VTID2 (num: $NUM2)"

    if [ -n "$VTID1" ] && [ -n "$VTID2" ] && [ "$VTID1" != "$VTID2" ]; then
        echo "✓ Parallel allocations are unique"

        # Check sequential
        if [ -n "$NUM1" ] && [ -n "$NUM2" ]; then
            DIFF=$((NUM2 - NUM1))
            if [ "$DIFF" = "1" ] || [ "$DIFF" = "-1" ]; then
                echo "✓ Allocations are sequential (diff: $DIFF)"
            else
                echo "⚠ Allocations may not be sequential (diff: $DIFF)"
            fi
        fi
    else
        echo "✗ Parallel allocation test failed"
        FAILED=$((FAILED+1))
    fi
    echo ""
fi

# Test 5: Test manual VTID creation blocked (D5)
echo "Test 5: Test manual VTID creation guard (D5)"
echo "--------------------------------------------"
MANUAL_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$GATEWAY_URL/api/v1/oasis/tasks" \
    -H "Content-Type: application/json" \
    -d '{"title":"Test Manual Task","vtid":"TEST-MANUAL-001"}')
MANUAL_CODE=$(echo "$MANUAL_RESPONSE" | tail -1)
MANUAL_BODY=$(echo "$MANUAL_RESPONSE" | head -n -1)
echo "HTTP Code: $MANUAL_CODE"

if [ "$ENABLED" = "true" ]; then
    if [ "$MANUAL_CODE" = "403" ]; then
        MANUAL_ERROR=$(echo "$MANUAL_BODY" | jq -r '.error')
        if [ "$MANUAL_ERROR" = "manual_vtid_blocked" ]; then
            echo "✓ Manual VTID creation correctly blocked when allocator enabled"
        else
            echo "✗ Unexpected 403 error: $MANUAL_ERROR"
        fi
    else
        echo "✗ Manual VTID creation should be blocked (403) when allocator enabled, got: $MANUAL_CODE"
        FAILED=$((FAILED+1))
    fi
else
    if [ "$MANUAL_CODE" = "201" ]; then
        echo "✓ Manual VTID creation allowed when allocator disabled (legacy mode)"
    else
        echo "Response: $MANUAL_BODY"
    fi
fi
echo ""

# Test 6: Orphan deploy gate test (fake VTID)
echo "Test 6: Verify orphan-deploy gate rejects fake VTID"
echo "---------------------------------------------------"
FAKE_VTID="VTID-99999-FAKE"
FAKE_RESPONSE=$(curl -s "$GATEWAY_URL/api/v1/vtid/$FAKE_VTID")
FAKE_ERROR=$(echo "$FAKE_RESPONSE" | jq -r '.error')
if [ "$FAKE_ERROR" = "not_found" ]; then
    echo "✓ Fake VTID correctly returns not_found (deploy gate would block)"
else
    echo "Response: $FAKE_RESPONSE"
fi
echo ""

# Summary
echo "========================================="
echo "Test Summary"
echo "========================================="
if [ $FAILED -eq 0 ]; then
    echo "✓ All tests passed!"
    exit 0
else
    echo "✗ $FAILED test(s) failed"
    exit 1
fi
