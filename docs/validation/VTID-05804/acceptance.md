# VTID-05804 acceptance

AC-1 aurora on gateway-staging without --public-url is refused (exit non-zero, no task definition output).
TEST: python3 scripts/aws/test/test_taskdef_data_backend.py StagingPublicUrl.test_cli_staging_aurora_refused_without_public_url (outputs/test-output.txt)

AC-2 aurora on gateway-staging with the production project URL is refused.
TEST: python3 scripts/aws/test/test_taskdef_data_backend.py StagingPublicUrl.test_staging_aurora_refused_with_production_public_url (outputs/test-output.txt)

AC-3 aurora on gateway-staging with a non-https URL is refused.
TEST: python3 scripts/aws/test/test_taskdef_data_backend.py StagingPublicUrl.test_staging_aurora_refused_with_non_https_public_url (outputs/test-output.txt)

AC-4 aurora on gateway-staging with a staging https URL sets SUPABASE_PUBLIC_URL to that URL.
TEST: python3 scripts/aws/test/test_taskdef_data_backend.py StagingPublicUrl.test_staging_aurora_sets_the_given_public_url (outputs/test-output.txt)

AC-5 production gateway keeps the production public URL.
TEST: python3 scripts/aws/test/test_taskdef_data_backend.py StagingPublicUrl.test_production_gateway_keeps_its_public_url (outputs/test-output.txt)

AC-6 All original data-backend behaviour (keep byte-for-byte, supabase round trip, refusals) still passes; three original tests were updated to pass the staging URL.
TEST: python3 scripts/aws/test/test_taskdef_data_backend.py (all 37 tests, outputs/test-output.txt)

AC-7 The patch applies to platform HEAD 67897e6c.
TEST: git apply --check on an export of 67897e6c (recorded in commands.log)

Not verified on staging: the workflow path that passes --public-url (gateway workstream job; the staging URL repository variable does not exist yet). AC-1 to AC-5 cover it at unit level.
