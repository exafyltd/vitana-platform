---
name: plan-sparring
description: Mandatory ping-pong review of every new plan by an independent sparring partner BEFORE a VTID is allocated (Plan Sparring Gate, VTID-04868, owner decision 2026-10-03). Use whenever you have drafted a plan for any work that will get a VTID — features, fixes, refactors, infra, docs — and before calling allocate_global_vtid or /vtid/allocate.
---

# Plan Sparring Gate

Owner directive (2026-10-03, standing): *every new plan gets a ping-pong sparring partner, as a
standard process, before a new VTID is generated.* No VTID is allocated for the sparring itself.

Order, always: **plan → sparring → owner approval → VTID → code.**

## 1. Write the plan
Save it as a markdown file in your scratchpad. Put the plan body between the markers
`<!-- plan:begin -->` and `<!-- plan:end -->` — the hash covers only that text. Declare:
- **change class**: `light` (≤3 files; no migrations, routes, auth, `.github`, deploy, governance
  or LLM-routing files), `standard`, or `expedited` (P1 incident only).
- **scope**: system areas and files you expect to touch.

## 2. Spar
Launch the partner with the Agent tool, `subagent_type: plan-sparring-partner` (falls back to a
read-only general-purpose agent with that file's instructions if the type is not loaded yet).
Give it only the plan file path — never your own reasoning.

When findings come back, answer **every** finding in a "Planner responses" section appended to
the file (outside the plan markers):
- `ACCEPTED` — and change the plan,
- `REJECTED` — with the reason,
- `DEFERRED` — with where it is tracked.

Send the revision back to the **same** partner (SendMessage, so it keeps its context) and ask it
to mark each finding closed / acknowledged / disputed and raise new blockers or majors only.

Round caps: light 2, standard 3, expedited 2 (10-minute total time box). Every class gets at
least two passes: findings, then the partner's response to your answers.

## 3. Verdict
- **converged**: no open or disputed blocker or major.
- **escalated**: round cap hit, a disputed item, partner model failure, or budget exhausted. List
  each open item side by side for the owner.

Owner decisions are not re-argued with the partner; only how the plan implements them.

## 4. Gate 1 — owner approval (one message)
Send the owner ONE message (Autonomy Contract, VTID-04947): the final plan, every round's findings
with your responses, the verdict, the files in scope and the test plan, ending with the single
question "Do you approve this plan?". Ask nothing else in it. A light-class plan still needs the
yes. A "yes" in chat is the standing instruction for everything up to Gate 2. Record it as the
approval line in `plan-sparring.md`. In the gateway tier the binding approval is the exafy_admin
click (`POST /api/v1/plans/spar/:id/approve`).

## 5. Then allocate
A PreToolUse hook denies any allocation call (allocate_global_vtid, /vtid/allocate, a direct
vtid_ledger insert) that references no sparring record; re-issue it with the reference.
Allocate the VTID (`allocate_global_vtid(..., p_sparring_id, p_plan_hash)` — or `sparring_id` +
`plan_hash` on `/vtid/allocate` — once the gateway tier is live; `p_plan_hash` must be the
record's approved `final_plan_hash` or the gate does not bind it;
until then record the sparring session in the ledger row's metadata). In the PR, commit the
record as `docs/validation/<VTID>/plan-sparring.md`: the final plan, the plan hash, every round,
and the verdict.

## 6. After the yes — run to Gate 2 without asking
Allocate immediately, never asking about the VTID. Implement, test, PR, merge, then run the
post-merge loop. In a cloud session, arm a `send_later` self check-in about 8 minutes after merge
and re-arm it every 5 minutes, up to 2 hours. Each check-in reads the STAGING-VERIFY result for the
merge commit. On pass, send Gate 2 ("Staging verified — ready for deployment to production?") with
the evidence. On fail, fix forward, at most 3 attempts per failure before escalating with evidence.
If the work outgrows the approved scope, add the change to the plan and send it back to the same
partner for one round. CONVERGED → continue. Not converged → that is the one mid-flight question.

## Emergency (break-glass)
P1 incident with the gateway or Bedrock down: the owner allocates through the exemption role
(logged as `vtid.plan_sparring.break_glass`). A full sparring follows within 24 hours.
