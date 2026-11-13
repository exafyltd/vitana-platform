---
slug: native-catalog-bedrock-review
author: kiro
executor: kiro
next_actor: kiro
state: drafted
author_seat: exafyltd
updated: 2026-11-13T08:48Z
---
# Handoff — native-catalog-bedrock-review

Plan: `plan.md` (decisions and premises), `tasks.md` (lane sections and Acceptance), `lanes/reviewer-script.md`,
`lanes/reviewer-tests.md`.

## Goal
Owner instruction, verbatim: "Bedrock translation reviewer: proceed as a plan. Do not clear any _pending_review flag until
the reviewer exists and passes it."

## State at drafting
- Pinned: vitana-v1 origin/main `70546df8cd2c68fa135bd51301215ee37a6e76f8`, vitana-platform origin/main
  `4e215b0198b0aca3637b623d7e1abf50c411c2e1`.
- No Bedrock translation reviewer on main. PR #1680 (`b9b467ffc6b94445a5234d9008b2bad5eddea9e5`, open) owns the
  evidence format and the flag checker. This plan cites them and does not duplicate them.
- No VTID is allocated. Lanes have no `vtid:` key. CI PLAN-SPAR allocates on convergence.

## What Kiro does next (no owner question needed)
1. PLAN-SPAR runs on the `plan(native-catalog-bedrock-review)` PR. Kiro answers each round in `sparring/responses-<n>.md`.
2. On convergence, CI allocates the VTIDs and writes them into the lane files.
3. `reviewer-script` starts first (no `depends_on`). `reviewer-tests` starts after it.

## Not in this plan
- The live review run (a Bedrock model call on catalog values). It runs later under the owner stop rules.
- Clearing any `_pending_review` flag. No flag is cleared here.
