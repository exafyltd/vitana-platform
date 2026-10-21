# VTID-05030 — acceptance criteria (Health Hub WP2 / D1)

AC-1 Tokens are sealed with AES-256-GCM as `enc:v1:<base64(iv‖tag‖ct)>`; tampered, truncated, wrong-prefix, plaintext or other-key values open to null; nothing is sealed without a key.
TEST: npx jest test/vtid-05030-connection-tokens.test.ts -t "connection-token-crypto"

AC-2 The OAuth callback stores only sealed tokens, stores nothing (and redirects `storage_unavailable`) without the key, and never puts exception text in the redirect.
TEST: npx jest test/vtid-05030-connection-tokens.test.ts -t "callback"

AC-3 Disconnect wipes all three token columns before the vendor revoke, revokes with the opened tokens within a 5 s bound, and a vendor failure or hang never blocks the disconnect.
TEST: npx jest test/vtid-05030-connection-tokens.test.ts -t "disconnect"

AC-4 A vendor `auth.revoked` webhook wipes the stored tokens.
TEST: npx jest test/vtid-05030-connection-tokens.test.ts -t "auth.revoked"

AC-5 Vendor revoke requests match the documented shapes (Terra, Vital/Junction, Strava, Fitbit); Oura reports unsupported; a missing identifier makes no network call; errors are reported, never thrown.
TEST: npx jest test/vtid-05030-connection-tokens.test.ts -t "request shapes"

AC-6 The grants migration revokes all anon/authenticated access to `user_connections`, grants nothing back, drops the client write policies and changes no table or data; no source writes a raw token into the table.
TEST: npx jest test/vtid-05030-connection-tokens.test.ts -t "grants migration|raw token"

AC-7 After the post-Gate-2 apply, a read-only `information_schema.role_table_grants` query shows no privilege for `anon` or `authenticated` on `public.user_connections`.
TEST: SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='user_connections' AND grantee IN ('anon','authenticated');  -- expect 0 rows (run after RUN-MIGRATION, read-only)

AC-8 The touched router still serves on staging for a signed-in member, with no token fields in the response (read-only regression check, not a grant test).
TEST: e2e/staging/vtid-05030-connection-tokens.staging.spec.ts (run by STAGING-VERIFY)

AC-9 No regression in the suites that exercise the touched modules, and the gateway type-checks.
TEST: npx jest test/vtid-05030-connection-tokens.test.ts and the 7 suites that import the wearables/connector modules; npx tsc --noEmit -p .

OASIS_PROOF: two new OASIS event types (`connector.wearable.vendor_revoke` — info, or warning on vendor failure — on every disconnect; `connector.wearable.token_storage_unavailable` — error — when a connect is refused for a missing key), both added to `CicdEventType` in `services/gateway/src/types/cicd.ts`. Emission with type, VTID, status and payload is asserted in the callback and disconnect tests.
TEST: npx jest test/vtid-05030-connection-tokens.test.ts -t "storage_unavailable|wipes the tokens before revoking|vendor failure still disconnects"
