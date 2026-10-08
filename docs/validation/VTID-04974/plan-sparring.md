# Plan sparring record - VTID-04974

Plan hash (sha256 of the text between the plan markers): `85190aeeead33e0f8dd48cf71e77d520acf607c0ff8e1629207f5933f662fdb0`. Partner: plan-sparring-partner (read-only, independent), 2 rounds, CONVERGED (light class). Owner instruction in session 2026-10-08: "Option 1 - fix forward. Make one small, isolated PR that updates only the three stale verification manifests ... Do not change production code or weaken any still-valid assertion ... Treat this as test-maintenance only, outside the ChatGPT plugin feature scope."

# Plan: remove three stale staging verification entries (test maintenance only)

<!-- plan:begin -->
## Context (owner instruction 2026-10-08)
The full STAGING-VERIFY run on the gateway (run 37758096460, 794/797) fails three entries that also fail on the previous main commits and are unrelated to the ChatGPT plugin work. The owner chose to fix forward: ONE small isolated PR that changes only these three manifests, no production code, no weakened still-valid assertion.

## Changes (repo /home/user/vitana-platform, branch from origin/main = 814df036)
1. docs/validation/VTID-04836/staging-tests.json: delete the "existing" entry `npx jest test/navigation-catalog.test.ts` (that test file does not exist anywhere in the repo, jest matches 0 files). Keep the HTTP probe "Command Hub loads the app.js that drops the retired earthlinks tenant".
2. docs/validation/VTID-04665/staging-tests.json: delete only the http entry "a route whose table is missing now reads down (risk_mitigations does not exist)". Keep the other 21 entries including "/api/v1/mitigation/health lists the dependencies it checked", "a route whose table exists stays healthy", liveness, and `npx jest test/vtid-04665-dependency-probe.test.ts`.
3. docs/validation/VTID-04698/staging-tests.json: delete only the http entry "a health route whose table is missing reads down (risk_mitigations does not exist)". Keep "a health route whose table exists still reads healthy" and the existing jest entry.
Why: the table `risk_mitigations` now exists in the shared Supabase project, so the premise of the two removed probes ended; the "missing table reads down" behavior stays proven by test/vtid-04665-dependency-probe.test.ts (a unit test that mocks the probe, unaffected by live database state).
Plus an evidence pack docs/validation/<VTID>/ for this change (acceptance, scope.json, commands.log, outputs, plan-sparring.md, staging-tests.json).

## Out of scope
Production code, the other tests' acceptance files (docs/validation/VTID-04665|04698 acceptance.md stay as history), the ChatGPT plugin features, any database change.

## Test plan
CI (validator, change-suite) on the PR; after merge a full STAGING-VERIFY on the exact gateway commit (must be 797/797 minus the three removed entries, all green).

## Change class
light (3 manifests plus an evidence pack, no code, no migrations, no workflows).
<!-- plan:end -->

## Round 1 - findings (verdict CONVERGED, minor only)
- F1 minor: state the direct evidence that risk_mitigations now exists. ANSWER: accepted - cited below.
- F2 minor: VTID-04698 acceptance.md AC-4 references the removed entry. ANSWER: accepted - it stays as history; its 'reads down' half is superseded because the premise ended.
- F3 minor: the removed VTID-04836 jest entry never covered anything (matches zero files); nothing covers 'AUTH.EARTHLINKS_PORTAL is gone'. ANSWER: accepted - recorded; adding such a test is out of scope (possible follow-up for the owner).
- F4 minor: no runner/lint/count check breaks from removing entries (scripts/ci/staging-verify/run.mjs loads manifests dynamically). ANSWER: acknowledged.

## Round 2
All four findings closed/acknowledged. Verdict: CONVERGED.

## Evidence for the premises
- Full STAGING-VERIFY run 37758096460 (gateway @ 814df036): 794/797; the failures are exactly the three entries below. The same three failed the full runs on 43bbd367 and 463e22a (before the ChatGPT plugin work), so they predate it.
- risk_mitigations: created by supabase/migrations/20260928200400_vtid_04717_risk_mitigations.sql; /api/v1/mitigation/health now answers healthy, so the two probes that expect 'down' fail.
- test/navigation-catalog.test.ts exists nowhere in the repository; `npx jest` matches 0 files.

## Owner approval
Approved by the owner in session 2026-10-08 ("Option 1 - fix forward"), plan hash above.
