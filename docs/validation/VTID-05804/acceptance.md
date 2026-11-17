# VTID-05804 acceptance

AC-1 aurora on gateway-staging without --public-url is refused (exit non-zero, no task definition output). Evidence: test-output.txt, StagingPublicUrl.test_cli_staging_aurora_refused_without_public_url.
AC-2 aurora on gateway-staging with the production project URL is refused. Evidence: StagingPublicUrl.test_staging_aurora_refused_with_production_public_url.
AC-3 aurora on gateway-staging with a non-https URL is refused. Evidence: StagingPublicUrl.test_staging_aurora_refused_with_non_https_public_url.
AC-4 aurora on gateway-staging with a staging https URL sets SUPABASE_PUBLIC_URL to that URL. Evidence: StagingPublicUrl.test_staging_aurora_sets_the_given_public_url.
AC-5 production gateway keeps the production public URL. Evidence: StagingPublicUrl.test_production_gateway_keeps_its_public_url.
AC-6 All original data-backend behaviour (keep byte-for-byte, supabase round trip, refusals) still passes. Evidence: 31 original tests in test-output.txt; three of them updated to pass the staging URL.
AC-7 Patch applies to platform HEAD 67897e6c. Evidence: git apply --check, recorded in the PR body.
Verification not run on staging: the workflow path that passes --public-url (Session 3 gateway job; the repository variable for the staging URL does not exist yet). Covered by AC-1 to AC-4 at unit level.
