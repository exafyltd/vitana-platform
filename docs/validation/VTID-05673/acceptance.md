# VTID-05673 acceptance (mt-local-stack-replay-skips-r1/replay-skips)
Change types: Tooling/docs.

Outcome: the MT-LOCAL-STACK check on main is green again. `replay-skip.json` lists the two VTID-05579 migrations that cannot replay on PGlite,
exactly as `scripts/mt/stack/discover-skips.mjs --write` generates them.
States: gate red on base (`relation public.chat_groups does not exist`), green after. Surfaces: n/a: no screen. Locales: n/a. Accessibility: n/a.
Contract: unchanged (docs/multitenancy/LOCAL-STACK.md). Staging proof: not verified on staging: the lane deploys nothing; the covering tests are
`npm run test:mt-stack` and the MT-LOCAL-STACK run on the PR head.

AC-1 — replay-skip.json lists 20261102054000_vtid_05579_chat_groups_scope.sql and 20261102054200_vtid_05579_chat_groups_rls.sql with the generator's reason and error, and equals the output of discover-skips.mjs
  TEST: supabase/tests/local-stack/repo-gate.test.mjs ("replay of supabase/migrations on PGlite")

AC-2 — node scripts/mt/stack/check-stack.mjs prints PASS local-stack gate and npm run test:mt-stack passes
  TEST: supabase/tests/local-stack/repo-gate.test.mjs ("replay of supabase/migrations on PGlite"); supabase/tests/local-stack/skipped-isolation.test.mjs

AC-3 — no wildcard skip, no test removed or loosened, only files inside the lane paths, no protected gate file
  TEST: supabase/tests/local-stack/repo-gate.test.mjs ("replay of supabase/migrations on PGlite")
