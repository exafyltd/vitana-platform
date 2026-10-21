# VTID-03788 — Fix broken AWS-STAGE-DEPLOY-GATEWAY.yml (apostrophe closed the jq single-quoted bash string)

## Report

After PR #3226 (VTID-03787) merged to `main`, staging build-info kept
reporting the PRE-merge commit (`005cd4be...`) no matter how long I
waited or how many times I sampled it. Investigated the actual deploy
workflow runs rather than continuing to poll build-info blind:

`AWS-STAGE-DEPLOY-GATEWAY.yml` had run 4 times on push, for every commit
on the VTID-03787 branch/PR (`7370c289`, `e174d85a`, `2ba5d7bf`, and the
squash-merge commit `4a88b1dc` on `main`) — **every single one completed
with `conclusion: "failure"` and `0 jobs`.** Not one job ran; the run
failed before any job step executed.

`bash -n` on the extracted "Register task-definition revision" step's
script confirmed a real syntax error:

```
line 87: syntax error near unexpected token `|'
line 87: `      | .containerDefinitions[0].secrets |='
```

Root cause: VTID-03787's own workflow edit added a comment block for the
new `ORB_LOG_NOVA_INSTRUCTION_DEBUG` flag INSIDE the jq single-quoted
program (the same array-literal region as the other flag comments), and
that comment contained the word `user's` — an apostrophe. The jq program
is itself the content of a single-quoted bash string (`'...'`); the
apostrophe closed that bash string early, and everything from there to
the next real `'` was parsed as literal bash instead of the intended jq
text — producing the exact syntax error above a few lines later.

**This is not a new class of bug in this file — it already has its own
scar tissue.** Lines 434-441 of the same file (predating this VTID)
document an IDENTICAL incident: "an earlier version put it inside the
single-quoted jq string with an apostrophe in the prose, which closed the
bash string early." That warning was written specifically to stop this
from happening again, and it still did, from a comment added the very
same day, because the new comment lived inside the jq program instead of
outside it like the existing warning says to.

## Fix

`.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml` — reworded the
`ORB_LOG_NOVA_INSTRUCTION_DEBUG` comment block to remove the apostrophe
("the user's memory and personalization context" → "real user memory and
personalization context"), and added an explicit note in the comment
itself calling out that no apostrophes belong there, referencing this
being the second incident.

New regression test,
`services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts`
— parses `AWS-STAGE-DEPLOY-GATEWAY.yml` and `AWS-PROD-DEPLOY-GATEWAY.yml`
with a real YAML parser (`js-yaml`), extracts every `run:` step's script
from every job, and shells each one out to `bash -n`. This is broader
than a fix scoped to the exact broken line — it will catch a bash syntax
error in ANY step of either file going forward, not just a recurrence of
this specific apostrophe. A narrower test also isolates the task-def
update step's jq program specifically and asserts it contains no
apostrophe at all, pinning the actual invariant that broke.

## Acceptance Criteria

AC-1 — Every `run:` step in `AWS-STAGE-DEPLOY-GATEWAY.yml` and
`AWS-PROD-DEPLOY-GATEWAY.yml` is valid bash (`bash -n` exits 0).

TEST: `staging-deploy-workflow-bash-syntax.test.ts` — "every run: step
passes bash -n" (both workflow files).

AC-2 — The task-definition-update step's jq program contains no
apostrophe, closing off the specific defect class that has now broken
this step twice.

TEST: same file — "the task-definition update step has no apostrophe
inside its jq program (VTID-03787/VTID-03788 regression)".

AC-3 — `tsc --noEmit` clean.

TEST: `outputs/tsc-noemit.txt`.

AC-4 — Full gateway suite green.

TEST: `outputs/jest-full-suite.txt` — 722/723 suites (1 pre-existing
skip), 13530/13565 tests passing, 0 failures (13525 before this VTID's
+5 new tests).

## Mutation verification

Reintroduced the exact apostrophe (`the user's` in place of `real user`)
into the live workflow file, re-ran the new test file: 2 of 5 tests
failed exactly as expected (`bash -n` failure + the apostrophe-presence
assertion), 3 passed unaffected (the PROD workflow file and the "has at
least one step" sanity checks, correctly unaffected by a STAGE-only
edit). Restored from backup, diffed clean, re-ran: 5/5 passing again.

## Governance

`command-hub-ownership-guard.js` not touched — same reasoning as every
prior VTID in this chain: changes are entirely under a test file and a
`.github/workflows/*.yml` deploy file, outside that guard's
`PROTECTED_PATH` scope.

OASIS_IMPACT: no — this is a CI/deploy-pipeline fix with no application
runtime code touched; no new event type, no schema change.
