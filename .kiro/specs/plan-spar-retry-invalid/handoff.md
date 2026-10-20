---
slug: plan-spar-retry-invalid
author: kiro
author_seat: exafyltd
executor: kiro
next_actor: kiro
state: approved
updated: 2026-10-20T14:13Z
sparring_record: .kiro/specs/plan-spar-retry-invalid/sparring/verdict.md
vtids: [VTID-05262]
---
# Handoff — plan-spar-retry-invalid

Planner: Kiro seat `exafyltd` (session `kiro-exafyltd-202610201346-3bb3`). Plan: `plan.md` (between the plan markers),
sparred by PLAN-SPAR. One lane: `retry-invalid`.
- Executor kiro, seat exafyltd, reviewer jtadic, `governance: true`.
- It may start only after #4210 (VTID-05259) is on `main`.
- It replaces `collab-kiro-governance/retry-partner-invalid` (VTID-05261).

## Log
### 2026-10-20T13:50Z · kiro-exafyltd-202610201346-3bb3 · created → drafted
**Owner instructions in this Kiro session, 2026-10-20:**
- "let's go with Option A": keep `governance: true` from `retire-claude-code` (#4210). Closed: #4214 and vitana-v1#1467.
- "OK, you do all of that".
- "yes, switch it": this session runs on account exafyltd@gmail.com (seat `exafyltd`).

**The earlier id was wrong.** This session's earlier id `kiro-exafy-202610201154-1d48` named seat `exafy` by mistake:
the owner's first message said "your seat exafy", but the account is exafyltd@gmail.com. Every commit under the earlier
id was made from account exafyltd@gmail.com.

**Why a new plan.** Change B of `collab-kiro-governance` is re-planned here as a new lane, because no commit may give an
existing lane `governance: true` (#4210).
- Line references re-pinned to `main` at 3063c9543, which already includes VTID-05254 (#4208).
- One addition: a stuck plan goes to `next_actor: kiro` or `owner`, never `claude`.

No VTID, no code, no live system touched.

**Expected red:** the report-only Collab handoff step flags the lane's `scripts/collab/**` paths, which is the old
refusal until #4210 merges.

Next: PLAN-SPAR spars this PR. This session (seat `exafyltd`) answers each round in `sparring/responses-<n>.md`.

### 2026-10-20T14:13Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 1 lane(s) got a VTID and are handed to Kiro.
