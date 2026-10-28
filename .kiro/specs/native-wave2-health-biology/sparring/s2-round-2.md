# Sparring round 2 — converged

Session: `fd2711ec-7768-4b2a-afe3-e4c80ba0d2d5` · plan hash `c9f76303a385e39ce4dece828cd073360dc415a9c62207756102ed1a0eeba853`

## Summary

The revised plan adequately addresses all four Round 1 findings. R1-F1 (Plans.tsx health data dependency) is resolved by adding health-plans-services depends_on health-hub. R1-F2 (PillarsOfHealth VitanaIndexValue) is resolved by acknowledging the data dependency in the ported branch. R1-F3 (vitanaIndex.ts exports) is corrected. R1-F4 (write mutations) is resolved with decision 3a (reads-only twin). The 24-row partition (4+4+16) is confirmed against the ledger. Routes at App.tsx:1126-1166 match. The assertNotProduction() guard exists at env.ts:68-75. One new minor finding: the N5a health-sync module claim is unverifiable at the pinned commit or via search.

## Findings

### R2-F1 [minor]

The plan asserts 'the n5a-health-sync module code is already merged to vitana-v1 main (#1398 → 8fea5e652, 2026-10-14)' and that the contract test will import 'the real export through its module path'. However, the native app's config/env.ts (the single production gate and module entry point) makes no reference to any health-sync module, and env.ts:20-21 shows the port structure routes through src/ports/core with no health-sync port. The apps/mobile/src/ directory (verified by listing) contains no health-sync subdirectory at the pinned commit, and GitHub search for 'health-sync' returns zero results on the default branch. If the module is not present on main when health-hub runs, the contract test strategy (type-level assignability + runtime shape check against the real N5a export) cannot work as described — it would only exercise the stub. The plan's fallback (stub behind ingest-off flag, next_actor: kiro) is sound, but the contract test description overpromises.

- `exafyltd/vitana-v1:apps/mobile/src/config/env.ts:20` — // VTID-05186: through the core port (tests/ports.test.ts — app code reaches lane packages only via src/ports).
import type { CoreEndpoints } from '../ports/core';
- `exafyltd/vitana-v1:apps/mobile/src/config/env.ts:14` — This file stays the single production gate; packages/core has no defaults.

Suggestion: Either (a) confirm the exact module path and commit where the N5a export landed (and cite it so the implementer can verify), or (b) downgrade the contract test description: state that if the N5a export is not present on main at implementation time, the contract test only validates the stub's shape against the vendored interface, and the real-export check is deferred to the re-vendor task (next_actor: kiro). This avoids the implementer writing a test that imports a non-existent path and failing CI.
