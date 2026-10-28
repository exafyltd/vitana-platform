# Sparring round 3 — converged

Session: `a8274a3c-ae8f-4d4b-bd18-5ed3596a0246` · plan hash `7c30e6d7f25472ff4ec3a73b59b5e7d7429627a55aad6427d3df72d7e5352c4a`

## Summary

R2-F1 (reviewer_seat / planning.md wording) is acknowledged as accepted and fully addressed in the revised plan. All three round-1 findings are addressed. One new minor finding: the staging-manifest-bom lane's test description for `loadManifest` is ambiguous and unimplementable as literally written given the ESM/CJS boundary and lib.cjs's explicit no-I/O contract.

## Findings

### R3-F1 [minor]

The `lib.test.cjs` test case 'a BOM manifest read from disk through `loadManifest`' cannot be implemented as described. `loadManifest` is a private, unexported function inside the ESM module `run.mjs`; `lib.test.cjs` only `require('./lib.cjs')` and has no import path to `run.mjs`. Moving `loadManifest` into `lib.cjs` to make it requireable would directly violate `lib.cjs`'s explicit 'pure logic, no I/O' design contract.

- `exafyltd/vitana-platform:scripts/ci/staging-verify/lib.test.cjs:1` — 'use strict';
// VTID-04613 — unit tests for STAGING-VERIFY's pure logic.
// Run: node --test scripts/ci/staging-verify/lib.test.cjs (STAGING-TESTS-REQUIRED.yml runs it on every PR)
const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('./lib.cjs');
- `exafyltd/vitana-platform:scripts/ci/staging-verify/lib.cjs:1` — 'use strict';
// VTID-04613 — STAGING-VERIFY: pure logic, no I/O.
//
// Everything that decides WHAT is tested, WHETHER a test is allowed, and
// WHAT the ready message says lives here, so it can be unit-tested
// (services/gateway/test/scripts/staging-verify-lib.test.ts). run.mjs does
// the I/O.
- `exafyltd/vitana-platform:scripts/ci/staging-verify/run.mjs:202` — function loadManifest(repoRoot, vtid) {
  const p = join(repoRoot, 'docs', 'validation', vtid, 'staging-tests.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    return { __parseError: e.message };
  }
}
- `exafyltd/vitana-platform:scripts/ci/staging-verify/run.mjs:24` — const require = createRequire(import.meta.url);
const lib = require('./lib.cjs');

Suggestion: Drop 'through `loadManifest`' from the test description. The testable unit is `parseJsonText` in `lib.cjs`. The four test cases should be reworded as: (1) `parseJsonText` called with a BOM-prefixed valid JSON string returns the same object as the BOM-free version; (2) `parseJsonText` called with a BOM-prefixed `commit-coverage.json` string returns the same object; (3) `parseJsonText` called with invalid JSON still throws; (4) a BOM that is not the leading byte is not stripped. This tests the actual fix (the helper in `lib.cjs`), stays within `lib.cjs`'s no-I/O contract, and keeps `lib.test.cjs` as a pure `require('./lib.cjs')` file. The disk-read path through `loadManifest` is already covered by the fact that `loadManifest` becomes a one-line call to `parseJsonText` — the composition is trivially correct once `parseJsonText` is tested.

## Acknowledgements of earlier responses

- R2-F1: acknowledged — Accepted and fully addressed. The revised plan §3 now explicitly states all three lane files declare `executor: kiro` and `reviewer_seat: agent:vitana-lane-reviewer`, cites queue.mjs:85 (GOVERNANCE_PATHS) and :701 (the kiro+reviewer-agent gate), and commits the pipeline-quality lane to correcting the misleading 'legacy' sentence in planning.md:35. The 'not adopted' part — not adding a structural test for lane-file fields — has sound rationale: queue.mjs validate in the Lane scope CI check already gates exactly this on every lane PR, so a second assertion would be pure duplication.
