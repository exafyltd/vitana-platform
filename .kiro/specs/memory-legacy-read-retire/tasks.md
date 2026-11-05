# Tasks — memory-legacy-read-retire
<!-- lane: bridge-recall-only -->
## bridge-recall-only
- [ ] D1. Premise 7, read-only, before merge (taken by the owner or a session with read-only AWS access): `scripts/memory/recall-shadow-report.sh /vitana/gateway-awsdr 336` and a count of `[VTID-04452] orb recall unavailable`, recorded in `docs/validation/<VTID>/outputs/recall-failures.md`. Above about 0.5% of sessions: park the lane and tell the owner.
- [ ] D2. Write the no-fallback test; record it red on `origin/main`.
- [ ] D3. Remove the legacy read, the shadow and the unused fetchers; update `recall-bridge-wiring.test.ts` and convert the two legacy-query tests in `orb-memory-bridge.test.ts` (tenant scoping asserted on the recall identity); delete `vtid-04784-recall-shadow.test.ts`.
- [ ] D4. Note the change under §8.4 phase 7 in `docs/MEMORY-SYSTEM-PLAN.md`.
- [ ] D5. `docs/validation/<VTID>/staging-tests.json`, `acceptance.md`, `commands.log`.
Acceptance: gateway `npm test` and `npx tsc --noEmit` green, only the lane paths change, no test skipped or loosened.
<!-- lane: bridge-recall-only -->
