// Thin wrapper for the PostgREST-Aurora proxy route-isolation tests. The GitHub UNIT job runs only *.test.cjs and
// *.test.mjs files under scripts/, so this file loads the tests kept in services/postgrest-aurora-proxy/test-route-isolation/.
// config-contract.test.mjs is static. behavior.test.mjs needs a reachable Docker daemon and fails without one.
//   node --test scripts/ci/postgrest-aurora-proxy/route-isolation.test.mjs
import '../../../services/postgrest-aurora-proxy/test-route-isolation/config-contract.test.mjs';
import '../../../services/postgrest-aurora-proxy/test-route-isolation/behavior.test.mjs';
