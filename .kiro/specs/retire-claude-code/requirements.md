# Requirements — retire-claude-code

Owner decision 2026-10-20: retire Claude Code; every step of the process is done by Kiro seats.

## R1 — Roles
1. Kiro seats plan, spar (via PLAN-SPAR), build, review, merge (§7b) and carry each change to Gate 2. No rule text
   names Claude Code as the actor for any step.
2. The Claude Routine's duties (stale claims, `review: changes` hand-backs, parked items, VTID allocation fallback)
   are done by seat `exafyltd`'s automation, except anything a §7a/§7b rule reserves to an owner-instructed session.

## R2 — Production after Gate 2 (owner decision 1)
1. (a) The owner presses PUBLISH; or (b) on an explicit "yes, deploy" to a specific Gate 2 message, the session that
   sent it dispatches the canonical production workflow pinned to the verified commit and reports the post-deploy
   check in one line.
2. (b) never follows a standing, bare or earlier "yes"; never in an automation run; recorded in the lane log with the
   owner's words and the run link.

## R3 — Governance paths (owner decision 2)
1. A lane may change governance paths only if it says `governance: true`; `validate` and `scope-check` enforce it.
2. A governance lane's `reviewer_seat` is a Kiro seat different from `seat`; the merge needs that seat's approving
   review on the current head and the owner's explicit per-PR merge instruction.
3. Automations never build, approve or merge a governance lane.
4. Lane permission fields change only in a `_plan` commit by the plan's author seat (sparred with the plan).

## R4 — Unblock STAGING-VERIFY
1. Every job that installs Playwright runs on a runner image Playwright 1.51.0 supports (`ubuntu-24.04`).

## Out of scope
Turning the Project Manager agent `live`; changing PLAN-SPAR, the sparring model or Gate 2's content; any app code.
