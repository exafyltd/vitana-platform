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

### 2026-10-20T14:10Z · kiro-exafyltd-202610201346-3bb3 · approved (R3-F1, R3-F2 recorded)
- PLAN-SPAR converged in round 3 and the plan is policy-approved (`converged-auto-v1`). VTID-05262 went to lane
  `retry-invalid`.
- Rounds 1 and 2 raised 4 findings, all accepted and fixed in the plan block:
  - R1-F1 (blocker): the cap check runs before every insert, whatever the plan hash;
  - R1-F2: the flags are kept on every `create` path;
  - R2-F1: the new return shape is wired through `step()` and `fakeClient`;
  - R2-F2: the test at `plan-spar.test.mjs:140` moves to `next_actor: kiro`.
- The converging round's two minor findings (R3-F1, the `retryInfra` formula; R3-F2, a stale comment) are recorded as
  acceptance notes in `tasks.md`.
- The approved plan block and the lane's permission fields are unchanged.
- Next: the owner's merge instruction for this plan PR (#4215). After that, and after #4210 (VTID-05259) is on `main`,
  seat `exafyltd` builds `retry-invalid`.
