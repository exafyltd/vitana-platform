# VTID-03789 — Fix AWS-STAGE-DEPLOY-GATEWAY.yml exceeding GitHub Actions' run: step size limit

## Report

VTID-03788 shipped and correctly fixed a real bash-syntax bug (an apostrophe
closing a jq single-quoted string early), mutation-verified. **It did not
resolve the actual outage.** After merging PR #3227 (VTID-03788, commit
`44511707`), the AWS-STAGE-DEPLOY-GATEWAY.yml workflow run for that exact
merge commit STILL failed with 0 jobs — the identical signature as before.

Root-caused via the real GitHub Actions API rather than continued guessing:
calling `workflow_dispatch` on this exact commit returned the raw parse
error directly:

```
Invalid Argument - failed to parse workflow: (Line: 184, Col: 14):
Exceeded max expression length 21000
```

Line 184 is the `run: |` line of the "Register task-definition revision +
roll the service" step. That step's `run:` value — as GitHub's own YAML
parser measures it (indentation-stripped, block-scalar-folded) — had grown
to 21,485 characters, just over GitHub Actions' real (and, prior to this
VTID, undocumented anywhere in this repo) 21,000-character limit on a single
step's `run:` value.

**Empirically confirmed, not just theorized:** pushed a throwaway branch
pointing at the last-known-good commit (005cd4be, before any VTID-03787/
03788 changes) and dispatched it — it parsed and queued successfully. That
commit's SAME step measured 23,981 raw characters (its js-yaml-parsed value
would be under 21,000, consistent with passing). The failing commit measured
25,111 raw / 21,485 parsed. Both VTID-03787's diagnostic-flag comment and
VTID-03788's own "no apostrophes" follow-up comment ADDED to this
already-large, heavily-commented step, tipping it over the real limit —
the apostrophe bug and the size-limit bug are two separate, independently
real defects that happened to stack on the same step in the same short
window.

Investigating this also surfaced that the step's `run:` block was almost
entirely accumulated documentation, not code: of ~365 total lines, only 102
lines (~7,400 characters) are actual bash — the remaining ~260 lines
(~17,700 characters) are comments spanning many prior VTIDs (VTID-03513,
VTID-03646, VTID-03773, BOOTSTRAP-NOVA-SONIC-VOICE, VTID-03706,
VTID-03787/03788), left in place inline as the step grew over months.

## Fix

Relocated every comment line inside this step's `run:` block to plain YAML
comments placed immediately above `run: |` (still inside the same step,
still adjacent to the code they document) — this is a **pure relocation**:
- Comments are bash no-ops regardless of position, so this changes nothing
  about what the step actually runs.
- Verified: all 102 executable lines are byte-for-byte identical, in the
  same relative order, before and after.
- Verified: all 259 original comment lines are preserved verbatim (none
  dropped), just moved above the block scalar instead of inside it.
- The step's `run:` value shrank from 25,111 raw / 21,485 parsed characters
  down to 7,413 characters — comfortably under the confirmed-safe 23,981
  baseline, with real margin for future growth.

## Acceptance Criteria

AC-1 — No `run:` step in either gateway deploy workflow exceeds a
conservative 20,000-character cap (deliberately set under the
empirically-confirmed-WORKING 23,981 measurement, not just under the
confirmed-broken 25,111/21,485 one, so the cap itself can never be what
breaks a legitimately-sized step).

TEST: `staging-deploy-workflow-bash-syntax.test.ts` — "no single run: step
exceeds 20,000 characters (GitHub Actions workflow-file size limit)" (both
workflow files), mutation-verified.

AC-2 — Every `run:` step in both workflows is still valid bash after the
relocation (unchanged from VTID-03788, re-verified here since the file
changed again).

TEST: same file — "every run: step passes bash -n" (both workflow files).

AC-3 — The relocation changed nothing executable: identical code lines,
identical comment text, just moved.

TEST: verified via a one-off script in commands.log (not a permanent test —
this is a one-time relocation, not an ongoing invariant); the size-cap test
(AC-1) is the permanent regression guard for this defect class.

AC-4 — `tsc --noEmit` clean.

TEST: `outputs/tsc-noemit.txt`.

AC-5 — Full gateway suite green.

TEST: `outputs/jest-full-suite.txt` — 722/723 suites (1 pre-existing skip),
13532/13567 tests passing (13530 before this VTID's +2 new tests), 0
failures.

AC-6 — The fixed file actually parses via the real GitHub Actions API (not
just local static checks) — the strongest verification available short of
completing a real staging deploy.

TEST: manual `workflow_dispatch` calls recorded in commands.log; the final
commit's actual push-triggered deploy run is the live confirmation once
this merges.

## Deliberately NOT attempted

- Did not relocate comments for the OTHER `run:` steps in this workflow
  (build/push, smoke test, etc.) — none of them are anywhere close to the
  size limit; only the task-definition-update step was affected.
- Did not attempt to reduce the historical commentary's CONTENT — every
  word survives, just relocated. This is a size-limit fix, not a
  documentation cleanup.
- Did not apply the same relocation preemptively to AWS-PROD-DEPLOY-
  GATEWAY.yml — its equivalent step is smaller (verified under the new
  20,000-char test, which now covers both files going forward) and was
  never reported broken.

## Governance

`command-hub-ownership-guard.js` not touched — changes are a `.github/
workflows/*.yml` file and its test, outside `PROTECTED_PATH` scope.

OASIS_IMPACT: no — CI/deploy-pipeline fix only, no application runtime code
touched, no new event type, no schema change.
