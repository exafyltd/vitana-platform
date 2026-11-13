Change types: Backend, Database, Tooling/docs.

# Acceptance — VTID-05785 (bridge-drift-fix / lane `fix`)

Outcome: `main`'s four suites broken by `#5021` (`a199f9ac9a`) and `#5027` (`c8ecb6eb3f`) pass again. Four
independent fixes, each proven red→green and mutation-checked.

AC-1 (C1, loop catalog): `AWS-KIRO-ACCESS` added to loop L5 Guard's `workflows` in `loop-catalog-v1.json`. Red/green
shown by the combined run below; the fix is additive and single-line, so its own red/green pair is the mutation
demonstration (`outputs/mutations.txt`, C1 coverage note).
TEST: `npx jest test/loop-catalog.test.ts` — fails on base, passes on branch (`outputs/red.txt`, `outputs/green.txt`)

AC-2 (C2, bootstrap-pack budget): `LIMITS.rulesChars` raised from `8_000` to `12_000`; the test's pinned bound
updated to match. Mutation: reverting to `8_000` re-fails the Part-1 extraction assertion.
TEST: `npx jest test/vtid-04018-operator-bootstrap-pack.test.ts` (`outputs/red.txt`, `outputs/green.txt`,
`outputs/mutations.txt` C2)

AC-3 (C3, session-layer regex): widened to `\w+ approval` per sparring round 1 (R1-F1), accepted. Mutation:
reverting to the literal `owner approval` re-fails.
TEST: `npx jest test/vtid-04868-plan-sparring-session-layer.test.ts` (`outputs/red.txt`, `outputs/green.txt`,
`outputs/mutations.txt` C3)

AC-4 (C4, migration comment): `-- definer-public: <reason>` line added, naming the earlier migration that already
holds the function's `REVOKE`/`GRANT`. No SQL statement changed. Mutation: removing the comment re-fails.
TEST: `npx jest test/vtid-05041-definer-lockdown.test.ts` (`outputs/red.txt`, `outputs/green.txt`,
`outputs/mutations.txt` C4)

AC-5: combined run of all four suites — 6 failed on base (`origin/main`, stashed fixes out), 0 failed with the
fixes, 1 skipped unchanged, 55 of 56 passing.
TEST: `npx jest test/loop-catalog.test.ts test/vtid-04018-operator-bootstrap-pack.test.ts test/vtid-05041-definer-lockdown.test.ts test/vtid-04868-plan-sparring-session-layer.test.ts`

AC-6: full `services/gateway` Jest run has exactly two failures, both environmental and pre-existing (confirmed
identical with the fixes stashed out, from the sibling `bridge-drift-fix/plan` worktree): `storage-provider.test.ts`
(AWS region env default mismatch) and `vtid-04226-eventbridge-test-contract-schedules.test.ts` (`openssl` not
installed in this sandbox). Neither file is in this lane's paths.
TEST: `npx jest --silent --maxWorkers=3` (`outputs/full-suite.txt`)

States / Surfaces / Locales / Accessibility: n/a, no UI. Contract: n/a — no API, route or schema change; the
migration's grants are unchanged (not applied). Staging proof: not verified on staging; the change deploys nothing
observable (a catalog data edit, two test assertions, one SQL comment).
