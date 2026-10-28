# VTID-05025 — acceptance criteria (Health Hub WP1 / D12)

AC-1 `getUserHealthContext()` loads the wearable rollup only when `include_wearable === true`; omitted or `false` never queries it.
TEST: npx jest test/vtid-05025-commerce-health-boundary.test.ts -t "wearable data is opt-in"

AC-2 The health-context cache never serves a context loaded with different include flags, and `invalidateUserHealthContext()` drops every variant.
TEST: npx jest test/vtid-05025-commerce-health-boundary.test.ts -t "cache is keyed by include flags"

AC-3 `inferPrimaryCondition()` never derives a condition from device data; member-stated precedence and travel mapping are unchanged.
TEST: npx jest test/vtid-05025-commerce-health-boundary.test.ts -t "no device-derived condition"

AC-4 No commerce module opts into wearable data, reads the wearable field (except the guest `: null` initialiser) or touches a health-data table; the ORB marketplace context carries no wearable data; wearable-analyzer recommendations stay health-domain.
TEST: npx jest test/vtid-05025-commerce-health-boundary.test.ts -t "purpose boundary"

AC-5 `applyUserLimitations()` is hide-only: for 500 generated inputs its output is an in-order subsequence of the input.
TEST: npx jest test/vtid-05025-commerce-health-boundary.test.ts -t "hide-only"

AC-6 No regression in the suites that exercise the touched modules, and the gateway type-checks.
TEST: npx jest test/limitations-filter.test.ts test/shopping-agent.test.ts test/services/context-pack-builder.test.ts test/orb-tools/marketplace-guide-tools.test.ts test/orb-tools/marketplace-journey-tools.test.ts; npx tsc --noEmit -p .

AC-7 On staging, the signed-in Discover feed and search answer 200 and search never reports a device-derived condition (read-only).
TEST: e2e/staging/vtid-05025-commerce-health-boundary.staging.spec.ts (run by STAGING-VERIFY)
