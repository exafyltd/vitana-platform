---
lane: reviewer-script
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
area: tooling
repos: [exafyltd/vitana-v1]
paths:
  - scripts/i18n/bedrock-review.mjs
  - docs/validation/VTID-*/scope.json
  - docs/validation/VTID-*/staging-tests.json
  - docs/validation/VTID-*/plan-sparring.md
updated: 2026-11-13T09:01Z
vtid: VTID-05788
---
# Bedrock translation reviewer (CLI and library)
Plan: `.kiro/specs/native-catalog-bedrock-review/` — `plan.md` (decisions 2, 3, 4, 5, 6, 7) and the `tasks.md` section
marked `<!-- lane: reviewer-script -->` (tasks R1–R6) are authoritative. VTID: assigned by CI after PLAN-SPAR converges.

**Goal.** `scripts/i18n/bedrock-review.mjs` judges catalog values with Claude on AWS Bedrock, through the AWS CLI as
`scripts/whats-new/draft-entry.mjs:136` does. It writes one evidence record per value in the eight-field format of PR
#1680 (`docs/validation/VTID-05761/review/README.md`). It does not clear any flag and does not run a live review.

**Acceptance (reviewer: hotmail):** the identity guard refuses any account other than `472838866351` or any region other
than `eu-central-1` before a model call; a reply that is not one JSON verdict writes no record; the record has exactly
the eight fields; no file under `src/i18n/` changes; no `ANTHROPIC_API_KEY` or Google variable is read.

**Never:** no live model call in this lane's work, no Supabase or gateway write, no new npm dependency, no VTID by hand.

## Log
### 2026-11-13T08:48Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan.

### 2026-11-13T09:01Z · ci-plan-spar · ready (VTID allocated)
VTID-05788 allocated after policy approval (converged-auto-v1).
