# VTID-03937 — Local PR-body pre-flight tool for VALIDATOR-CHECK.yml

Requested directly: two consecutive PRs opened in this session (PR #3330
VTID-03933, PR #3332 VTID-03934) each needed a full CI round-trip — twice —
to discover a PR-body/evidence-pack formatting miss that had nothing to do
with the actual code change:

1. The Acceptance Mapping Gate rejected `docs/validation/VTID-03933/acceptance.md`
   with `AC at line 78 has no TEST:/CURL:/UI: mapping within 12 lines` (exit
   41) because AC-7's mutation-verification note led with "Verified
   manually:" instead of the required literal `TEST:` token.
2. The OASIS Traceability Gate rejected both PR bodies with `invalid
   OASIS_IMPACT value` (exit 80) because `OASIS_IMPACT: None — pure logic
   change...` is prose, and the gate's regex requires the literal token
   `OASIS_IMPACT: yes` or `OASIS_IMPACT: no`.

Neither miss touched the actual engineering verification (tests, mutation
checks, `tsc`, the full suite) — both were pure PR-metadata formatting that
CI could only report after ~19 other jobs had already run (~2-3 minutes per
round-trip).

## What was built

`scripts/ci/validate-pr-locally.cjs` — a CLI that mirrors
`VALIDATOR-CHECK.yml`'s `validate-pr` job step-by-step, same order, same
exit codes, so its output can be diffed 1:1 against a CI log:

- Title/body presence, VTID extraction (title first, then an explicit
  `VTID: VTID-XXXXX` body line — never a prose mention), `VALIDATION_PROFILE`
  extraction, the four required PR-body markers, changed-files diff,
  evidence-pack existence, the Acceptance Mapping Gate, the OASIS
  Traceability Gate, and the Merge Deploy Gate are all re-implemented
  directly (they are simple regex/file-existence checks with no test
  coverage of their own before this).
- Path ownership, CSP-added-lines scanning, and the Route Mount Evidence
  Gate's "was a route actually added" trigger are NOT re-implemented — the
  script `require()`s `scripts/ci/validator-path-guard.cjs` directly and
  calls its exported `evaluate()`/`cspViolationsInAddedLines()`/
  `routeEvidenceRequired()` functions. That module already has its own
  tests and its own hard-won lessons about parsing traps (VTID-03505,
  VTID-03549); duplicating its logic here would just create a second copy
  to keep in sync — the exact drift risk VTID-03696's `REMIT` guard already
  exists to prevent.
- The Build Gate (`npm ci && npm run build`, ~1-2 minutes) is deliberately
  **not** run by default — it is real engineering verification, not
  formatting, and the tool's whole purpose is to catch cheap mistakes
  cheaply without giving anyone a reason to skip the expensive, load-bearing
  check. `--build` runs the identical command for anyone who wants one tool
  to call both.

## Usage

```bash
node scripts/ci/validate-pr-locally.cjs \
  --title "VTID-03933: Fix guessAreaFromText() Auth ordering bug" \
  --body-file /tmp/pr-body.md \
  [--base main] [--build]
```

Exit code 0 = APPROVED, matching the workflow's own PASS summary. Any
non-zero exit code and REJECTED message is byte-for-byte the same message
CI would produce for the same input.

---

AC-1 — reproduces the exact real Acceptance Mapping Gate failure from PR
#3330 (VTID-03933) — "Verified manually:" instead of a leading `TEST:` token

TEST: `test/scripts/validate-pr-locally.test.ts` — "checkAcceptanceMapping()
directly reproduces the exact reported CI failure" and "rejects via the
full validate() pipeline when an AC has no TEST:/CURL:/UI: within 12 lines"
Output: outputs/targeted-tests.txt
Also verified live, unmocked, against this repo's own real git state and
the real (temporarily-reverted) `docs/validation/VTID-03933/acceptance.md`
file: the CLI printed the byte-identical message `REJECTED: AC at line 78
has no TEST:/CURL:/UI: mapping within 12 lines` and exited 41 — the exact
line number and exit code the real CI run reported. Reproduced in this
session's own terminal transcript; not re-captured as a separate output
file since the target file is real committed evidence, not a throwaway
fixture.

AC-2 — approves the corrected wording that actually shipped on that PR

TEST: `test/scripts/validate-pr-locally.test.ts` — "approves the corrected
wording that actually shipped (leads with TEST:)"
Output: outputs/targeted-tests.txt
Also verified live against this repo's actual current
`docs/validation/VTID-03933/acceptance.md` (the real, already-fixed file):
the CLI printed `Acceptance mapping OK` and the full run ended `APPROVED`,
exit 0.

AC-3 — reproduces the exact real OASIS Traceability Gate failure from PR
#3330/#3332 — prose instead of the literal `yes`/`no` token

TEST: `test/scripts/validate-pr-locally.test.ts` — "reproduces the exact
reported CI failure: prose instead of the literal yes/no token"
Output: outputs/targeted-tests.txt
Also verified live against the real original PR #3330 body text
(`OASIS_IMPACT: None — pure utility-function logic change with no OASIS
event emission, no DB write, no deploy-workflow change.`): the CLI printed
`REJECTED: invalid OASIS_IMPACT value` and exited 80 — the exact message
and exit code the real CI run reported.

AC-4 — approves the corrected literal token that actually shipped

TEST: `test/scripts/validate-pr-locally.test.ts` — "approves the corrected
literal token that actually shipped"
Output: outputs/targeted-tests.txt

AC-5 — `OASIS_IMPACT: yes` without `OASIS_PROOF:` in acceptance.md is
rejected; with it, approved

TEST: `test/scripts/validate-pr-locally.test.ts` — "requires OASIS_PROOF:
in acceptance.md when OASIS_IMPACT: yes" and "approves OASIS_IMPACT: yes
when OASIS_PROOF: is present"
Output: outputs/targeted-tests.txt

AC-6 — VTID extraction follows VTID-03696's own fix: a prose mention of a
VTID in the body must NOT be picked up, only the title or an explicit
`VTID: VTID-XXXXX` line

TEST: `test/scripts/validate-pr-locally.test.ts` — "falls back to an
explicit VTID: line in the body, not a prose mention"
Output: outputs/targeted-tests.txt

AC-7 — every required marker (SCOPE_ALLOWLIST/ACCEPTANCE/
MERGE_PAYLOAD_PREVIEW/OASIS_IMPACT), the evidence-pack existence checks,
the CSP governance gate, and the Merge Deploy Gate all reject with the same
exit codes as VALIDATOR-CHECK.yml

TEST: `test/scripts/validate-pr-locally.test.ts` — "required markers
(exit 12-15)", "evidence pack gate (exit 30-33)", "CSP governance gate
(exit 50)", "merge deploy gate (exit 90-91)"
Output: outputs/targeted-tests.txt

AC-8 — path ownership violations are delegated to, not duplicated from,
`validator-path-guard.cjs`

TEST: `test/scripts/validate-pr-locally.test.ts` — "propagates an
unknown-profile rejection (exit 21)"
Output: outputs/targeted-tests.txt

AC-9 — the full happy path approves end to end and prints the same PASS
summary shape as CI, and the Build Gate is skipped by default with an
explicit note

TEST: `test/scripts/validate-pr-locally.test.ts` — "approves a well-formed
PR end to end and prints the PASS summary" and "skips the Build Gate by
default and says so"
Output: outputs/targeted-tests.txt
Also verified live: running the tool against this branch's own real diff
against `origin/main` with a correctly-formatted body printed `Changed
files: 7`, `APPROVED: 7 in-remit file(s) match the gateway_backend
allowlist`, `Acceptance mapping OK`, and ended `APPROVED` / `VTID=VTID-03933`
/ `PROFILE=gateway_backend` — matching the real CI run's own output for
this exact commit range.

AC-10 — mutation-verified: breaking the Acceptance Mapping Gate's window
check (`const mapped = true; // MUTATED`, unconditionally treating every AC
as mapped) makes both the exact reproduction tests fail

TEST: manual mutation check — edited `checkAcceptanceMapping()` in
`scripts/ci/validate-pr-locally.cjs` to hardcode `mapped = true`, re-ran
`test/scripts/validate-pr-locally.test.ts` — confirmed exactly the two
tests that assert on this behavior failed (`Expected: 41, Received: 0`),
all 28 others unaffected. Restored the original file and re-ran — 30/30
green again.

AC-11 — no regression to the existing gateway test suite, `validator-path-
guard.cjs`'s own test suite, or type-checking

TEST: `npx jest` (full suite)
Output: outputs/full-suite.txt
TEST: `npx tsc --noEmit`
Output: outputs/tsc.txt
Note: both show the same 2 pre-existing, unrelated `tsc` errors and 12
pre-existing failing suites already documented in
VTID-03927/VTID-03933/VTID-03934's evidence packs (missing `@aws-sdk`
sub-packages in this session's local `node_modules`, not referenced by any
file this VTID touches). Zero failures in
`scripts/ci/validate-pr-locally.cjs` or its test file, and
`validator-path-guard.test.ts` (75/75 combined) is unaffected. CI's own
`npm ci` in the Build Gate step installs from the committed lockfile fresh,
which does not carry this local `node_modules` gap forward.
