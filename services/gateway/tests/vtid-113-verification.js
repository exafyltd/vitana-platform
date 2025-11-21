/**
 * VTID-113 Verification Test
 * Tests that governanceController gracefully handles missing Supabase env vars
 */

// Unset Supabase env vars
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log('[VTID-113 Test] Environment:', {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY
});

// Import the controller (should not crash)
console.log('[VTID-113 Test] Importing governanceController...');
try {
    const { GovernanceController } = require('../dist/controllers/governanceController');
    console.log('[VTID-113 Test] ✓ Import successful - no crash!');

    // Create a mock request/response
    const mockReq = {
        headers: {},
        query: {},
        params: {},
        body: {},
        getTenantId: () => 'TESTHANDLER'
    };

    const mockRes = {
        status: function (code) {
            this.statusCode = code;
            return this;
        },
        json: function (data) {
            this.responseData = data;
            return this;
        },
        statusCode: 0,
        responseData: null
    };

    // Test one method
    const controller = new GovernanceController();
    console.log('[VTID-113 Test] Testing getCategories with missing Supabase...');

    controller.getCategories(mockReq, mockRes).then(() => {
        console.log('[VTID-113 Test] Response status:', mockRes.statusCode);
        console.log('[VTID-113 Test] Response data:', JSON.stringify(mockRes.responseData, null, 2));

        if (mockRes.statusCode === 503 && mockRes.responseData.error === 'SUPABASE_CONFIG_ERROR') {
            console.log('[VTID-113 Test] ✓ Correct 503 error returned!');
            console.log('[VTID-113 Test] ✅ ALL TESTS PASSED');
            process.exit(0);
        } else {
            console.error('[VTID-113 Test] ❌ TEST FAILED: Expected 503 with SUPABASE_CONFIG_ERROR');
            process.exit(1);
        }
    }).catch((err) => {
        console.error('[VTID-113 Test] ❌ TEST FAILED: Unexpected error:', err);
        process.exit(1);
    });

} catch (error) {
    console.error('[VTID-113 Test] ❌ TEST FAILED: Import crashed!', error);
    process.exit(1);
}
