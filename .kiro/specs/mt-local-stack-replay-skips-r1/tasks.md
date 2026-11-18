# Tasks — mt-local-stack-replay-skips-r1
Authoritative plan: `plan.md`. VTID from CI PLAN-SPAR. Branch `kiro/mt-local-stack-replay-skips-r1/replay-skips`; title
`VTID-xxxxx (mt-local-stack-replay-skips-r1/replay-skips): …`; trailers; `kiro-agent[bot]`; evidence in `docs/validation/<VTID>/`.

<!-- lane: replay-skips -->
## Lane `replay-skips`
- [ ] T1 Record red on base: `node scripts/mt/stack/check-stack.mjs` fails naming `20261102054000_vtid_05579_chat_groups_scope.sql`.
- [ ] T2 Run `node scripts/mt/stack/discover-skips.mjs --write` on the latest `main`; the diff of `supabase/tests/local-stack/replay-skip.json` is only the new entries.
- [ ] T3 Run `node scripts/mt/stack/check-stack.mjs` (`PASS local-stack gate`) and `npm run test:mt-stack`; update `docs/multitenancy/LOCAL-STACK.md` only if a doc-agreement test requires it.

**Acceptance**
- Change types: Tooling/docs
- AC-1: `replay-skip.json` lists `20261102054000_vtid_05579_chat_groups_scope.sql` and `20261102054200_vtid_05579_chat_groups_rls.sql` with the generator's reason and error, and equals the output of `discover-skips.mjs`.
- AC-2: `node scripts/mt/stack/check-stack.mjs` prints `PASS local-stack gate` and `npm run test:mt-stack` passes.
- AC-3: No wildcard skip, no test removed or loosened, only files inside the lane paths, no protected gate file.
