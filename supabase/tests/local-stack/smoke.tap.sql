-- VTID-05520: smoke test of the pgTAP-compatible shim on the PGlite stack (real pgTAP is not used).
SELECT plan(13);
SELECT ok(true, 'ok passes on true');
SELECT is(1 + 1, 2, 'is compares equal values');
SELECT isnt(1, 2, 'isnt compares different values');
SELECT matches('CANARY_A_x', '^CANARY_A_', 'matches a regex');
SELECT lives_ok($$SELECT 1$$, 'lives_ok on valid sql');
SELECT throws_ok($$SELECT 1/0$$, '22012', 'throws_ok on division by zero');
SELECT is_empty($$SELECT 1 WHERE false$$, 'is_empty on no rows');
SELECT results_eq($$VALUES (1),(2)$$, $$VALUES (1),(2)$$, 'results_eq on equal sets');
SELECT set_eq($$VALUES (2),(1)$$, $$VALUES (1),(2)$$, 'set_eq ignores order');
SELECT require_table('tenants', 'table tenants is replayed');
SELECT require_table('user_tenants', 'table user_tenants is replayed');
SELECT is((SELECT count(*)::int FROM auth.users), 5, 'fixtures: five users');
SELECT is((SELECT count(*)::int FROM public.tenants WHERE slug LIKE 'mt-fixture-%'), 2, 'fixtures: tenants T_A and T_B');
SELECT diag('done');
SELECT * FROM finish();
