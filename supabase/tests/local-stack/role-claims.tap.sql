-- VTID-05520: a test can switch to the authenticated role with claims; the shim stays callable and auth.uid() follows the claim.
SELECT plan(4);
SELECT set_config('request.jwt.claims', '{"sub":"0000000a-0000-4000-8000-000000000001","role":"authenticated"}', false);
SET ROLE authenticated;
SELECT is(auth.uid(), '0000000a-0000-4000-8000-000000000001'::uuid, 'auth.uid() follows the claim');
SELECT is(current_user::text, 'authenticated', 'running as authenticated');
SELECT is(auth.jwt() ->> 'role', 'authenticated', 'auth.jwt() follows the claim');
RESET ROLE;
SELECT is(current_user::text, 'postgres', 'back as the owner role');
SELECT * FROM finish();
