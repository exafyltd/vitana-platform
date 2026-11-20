# HANDOVER v2 — multi-tenant programme (mt-*)

> **Status of this file:** copied from the handover text the outgoing session pasted into chat on 2026-11-06 (its facts were
> stated as checked as of 17:23Z). Nothing in it has been re-verified by the session that committed it. The incoming session
> must re-verify every time-sensitive fact before acting (PR states, staging runs, heartbeats, failing tests).

## Instructions for the incoming session

1. Work on branch `claude/friendly-lamport-cyco92` in `exafyltd/vitana-platform` (and `exafyltd/vitana-v1` where a lane needs it).
   Do not push to any other branch without the owner's permission.
2. Run `node scripts/collab/queue.mjs --repo <vitana-platform> --repo <vitana-v1>`, state your session id and lane in your first
   reply, and claim a lane before touching it (see `.claude/rules/collaboration.md`).
3. Read the lane handoffs: `.kiro/specs/mt-*/handoff.md`, starting with `mt-guardrails-r2`, `mt-identity-r2` and `mt-track-s-authz`.
   Read `docs/MULTI-TENANT-PLAN.md` for the programme plan.
4. Re-verify first (see "Re-verify first" below), then continue the "Next steps".
5. Do not run anything against production. Do not apply a migration without per-file and per-database owner approval.
   Do not hand-allocate VTIDs. Do not skip, loosen or disable tests. Do not bypass a gate.

## Original plan

- **Goal:** take the multi-tenant (`mt-*`) programme lane by lane to STAGING-VERIFY, then send Gate 2 to the owner.
  Repos: `vitana-platform` and `vitana-v1` only.
- **Constraints:** no production access; no migration applied without per-file and per-database approval; no hand-allocated
  VTIDs; no skipped or loosened tests; no bypassed gates; fixed session title.
- **Pipeline:** plan PR → CI sparring → lanes → reviewer accept → land-guard merge → staging → Gate 2.
- **Next steps at the start of this context:** land amendment 3 (#4739) and the role-source lane; build the PGlite lane; close
  #4628; settle the approvals and operator closings; finish the remaining closings; keep heartbeats going; send the owner a
  final report.

## Completed (as stated by the outgoing session)

- **Merged:** #4739 (plan amendment 3), #4723 (VTID-05467 role-source), and its closing record #4742.
  Git confirms these are on the branch: `ed1b4e73`, `0f3374e4`, `58d4e176`.
- **Lanes done earlier, with closing records:** VTID-05463, 05464, 05465, 05466, 05479, 05529. The code for VTID-05528 and
  VTID-05553 is merged, but their closing records are blocked.
- **Plans:** round 3 converged for #4617 and #4618. Round-2 answers are pushed for #4617, #4618 and #4582. Premise files are
  pushed for #4615, which started a new sparring session.
- **Staging:** gateway run on `05364284a1` passed at 13:52Z. Community-app run on `cc8fdc5fa0` passed after one re-run.

## Missing

**Owner stop messages (none sent yet):**
- **S1:** the PGlite lane (VTID-05520) is held and unpushed. Decisions D1, D2 and D4 are needed.
- **S2:** the approvals and operator-chat closing records are blocked by the red-green gate.
- **S3:** owner approval is needed to apply the VTID-05467 migrations. The PostgREST check and decision 11 are also needed.
- **S4:** the community-isolation plan (#4582) escalated at round 3.

**Failures to investigate:**
- Gateway run on `9069accecc94` failed with 13 unnamed tests. A later pass superseded it.
- Community-app run `42220839926` on `290c179cdc2` failed. Its owner is unknown.

**Work to do:**
- Answer round 1 on #4740, and the second-session round 1 on #4615.
- Merge `main` into #4617 and #4618, then merge them once checks pass.
- Build the lanes once their plans converge and CI allocates VTIDs (the lane files list them with their seats).
- Closing records for approvals and operator-chat; the `_plan` closures for `mt-track-s-authz` and `mt-identity-r2`; close #4628
  after S1.
- Heartbeats for `mt-identity-r2`, `mt-track-s-authz` and `mt-guardrails-r2` are about seven hours stale. The incoming session
  must take them over.
- Gate 2 evidence: the production commit has not been checked and the commit list is not compiled.

## Re-verify first

- PR states for #4739, #4723, #4742, #4740, #4615, #4617, #4618, #4582, #4628 (GitHub, not git).
- Staging run results named above, and the two failing runs.
- Heartbeat ages in each lane's `handoff.md`.
- Which production commit is live (`/api/v1/admin/build-info`) before any Gate 2 evidence is compiled.
