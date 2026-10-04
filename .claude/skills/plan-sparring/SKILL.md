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

## 4. Owner approval
Show the owner the final plan, every round's findings and your responses, and the verdict. A
light-class plan still needs the owner's yes. A "yes" in chat is recorded as context; in the
gateway tier the binding approval is the exafy_admin click (`POST /api/v1/plans/spar/:id/approve`).

## 5. Then allocate
Allocate the VTID (`allocate_global_vtid(..., p_sparring_id)` once the gateway tier is live;
until then record the sparring session in the ledger row's metadata). In the PR, commit the
record as `docs/validation/<VTID>/plan-sparring.md`: the final plan, the plan hash, every round,
and the verdict.

## Emergency (break-glass)
P1 incident with the gateway or Bedrock down: the owner allocates through the exemption role
(logged as `vtid.plan_sparring.break_glass`). A full sparring follows within 24 hours.
