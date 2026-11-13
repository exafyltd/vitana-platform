Change types: Backend, Database, Tooling/docs.

# Acceptance — VTID-05785 (bridge-drift-fix / lane `fix`)

Outcome: `main`'s four suites broken by `#5021` (`a199f9ac9a`) and `#5027` (`c8ecb6eb3f`) pass again. Four
independent fixes, each proven red→green and mutation-checked.

AC-1 (C1, loop catalog): `AWS-KIRO-ACCESS` added to loop L5 Guard's `workflows` in `loop-catalog-v1.json`. Red/green
shown by the combined run below. Mutation: removing the line from the catalog re-fails both coverage assertions
with the same shape as base (`orphans: ["AWS-KIRO-ACCESS"]`, `workflows.owned` 29 not 30) — `outputs/mutations.txt`
C1. (An earlier mutation attempt via a Python one-liner mis-indexed the catalog, raised `KeyError: 'workflows'`
before editing anything, and the test that followed it passed 25/25 against the still-fixed file — a false
positive, not evidence of anything; superseded by the `sed`-based run cited here.)
TEST: `npx jest test/loop-catalog.test.ts` — fails on base, passes on branch, re-fails mutated
(`outputs/red.txt`, `outputs/green.txt`, `outputs/mutations.txt` C1)

AC-2 (C2, bootstrap-pack budget): `LIMITS.rulesChars` raised from `8_000` to `12_000`; the test's pinned bound
updated to match. Mutation: reverting to `8_000` re-fails the Part-1 extraction assertion.
TEST: `npx jest test/vtid-04018-operator-bootstrap-pack.test.ts` (`outputs/red.txt`, `outputs/green.txt`,
`outputs/mutations.txt` C2)

AC-3 (C3, session-layer regex): sparring round 1 (R1-F1) first widened the literal `owner approval` to an
unrestricted `\w+ approval`; the lane review found that too loose (it would also match a nonsensical "no
approval") and the final diff instead pins an explicit allowed set, `(?:owner|machine|policy) approval` — the
three wordings rule 51 has actually used. Declared in `scope.json` `weakens_tests` (it does accept more than the
original literal string, deliberately, for the three known wordings — never an arbitrary word). Mutations:
(1) reverting to the literal `owner approval` re-fails against the real CLAUDE.md text ("machine approval");
(2) corrupting CLAUDE.md's wording to "no approval" (sandbox-only, restored byte-identical, `CLAUDE.md` is not in
this lane's paths) re-fails the fixed regex, and — the credible negative control — would have wrongly *passed*
under the superseded `\w+ approval` wording, which is why that wording was not kept.
TEST: `npx jest test/vtid-04868-plan-sparring-session-layer.test.ts` (`outputs/red.txt`, `outputs/green.txt`,
`outputs/mutations.txt` C3 and "C3 counter-mutation")

AC-4 (C4, migration comment): `-- definer-public: <reason>` line added, naming the earlier migration that already
holds the function's `REVOKE`/`GRANT`. No SQL statement changed. Mutation: removing the comment re-fails (1
failed, 1 skipped, 6 passed, 8 total). An earlier attempt used a path one `..` short of `supabase/migrations` from
a `services/gateway` CWD, so `cp`/`sed` both failed silently and the test ran unmutated (false "PASS"); superseded
by the absolute-path run cited here, which commands.log and mutations.txt both now report consistently.
TEST: `npx jest test/vtid-05041-definer-lockdown.test.ts` (`outputs/red.txt`, `outputs/green.txt`,
`outputs/mutations.txt` C4)

AC-5: combined run of all four suites — 6 failed on base (`origin/main`, stashed fixes out), 0 failed with the
fixes, 1 skipped unchanged, 55 of 56 passing.
TEST: `npx jest test/loop-catalog.test.ts test/vtid-04018-operator-bootstrap-pack.test.ts test/vtid-05041-definer-lockdown.test.ts test/vtid-04868-plan-sparring-session-layer.test.ts`

AC-6: full `services/gateway` Jest run on this branch's final head has exactly two failures, both environmental and
pre-existing (same file and assertion as the stashed-fixes-out baseline taken from the sibling
`bridge-drift-fix/plan` worktree): `storage-provider.test.ts` (AWS region env default mismatch) and
`vtid-04226-eventbridge-test-contract-schedules.test.ts` (`openssl` not installed in this sandbox). Neither file is
in this lane's paths. A one-test swing in the passed count between runs (29910→29911 of ~29972) is this
environment's own non-determinism (suite and failure counts are identical); nothing in this lane's paths generates
a test dynamically or depends on filesystem/environment state that would explain it.
TEST: `npx jest --silent --maxWorkers=3` (`outputs/full-suite.txt`)

States / Surfaces / Locales / Accessibility: n/a, no UI. Contract: n/a — no API, route or schema change; the
migration's grants are unchanged (not applied). Staging proof: not verified on staging; the change deploys nothing
observable (a catalog data edit, two test assertions, one SQL comment).
