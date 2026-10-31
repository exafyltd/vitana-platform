---
inclusion: always
---
# Vitana: carry every owner task through to its authorized outcome (standing owner instruction)

Owner, 2026-10-27 (Kiro Web): *"When I ask you to do something, carry it through to the authorized outcome without
repeatedly coming back to me for approval of routine steps. This applies to investigation, planning, implementation,
testing, fixes, reviews, PRs, permitted merges, reruns, documentation, closing records, and cleanup. For development
tasks, the default outcome is STAGING VERIFY, unless I specify a different endpoint."* This file is identical in
`exafyltd/vitana-platform` and `exafyltd/vitana-v1`. It applies to every agent session on either repo: Kiro Web,
Kiro IDE, seat automations, sub-agents, and Claude Code. It applies to every kind of work, not only the
development pipeline. It removes questions, not safeguards: every rule named under "Stops" below is unchanged.

## The outcome you run to
- **A task that results in a commit:** the Vitana pipeline (`vitana-pipeline.md`): `plan(` PR → CI PLAN-SPAR →
  CI VTIDs → lanes → reviewer agent → merge under `collaboration.md` §7b → staging deploy → **STAGING-VERIFY passed
  on the merge commit**. That is the default end point. A change that deploys nothing ends when it is merged with green
  checks and its closing records are merged. Gate 2 (*"Staging verified — ready for deployment to production?"*) is
  the report you give when you get there. It is the one question about production, not a question about whether to
  continue.
- **Any other task** (an investigation, a question, a read-only review, an ops or health check, an audit, a
  document that is only shown in the chat): run it to the finished answer, with its evidence (file:line, run links,
  command output). Read-only by default. Never write to a live system to answer a question.
- **An end point the owner names** ("plan only", "open the PR", "stop at review") replaces the default.

## Never ask about routine steps
Do each of these without asking: investigating, reading code, logs and CI; planning and answering sparring rounds;
writing code, tests and docs; running local checks and preflight; committing, pushing, opening and updating PRs;
running the reviewer agent; merging under §7b; dispatching or re-running staging, verification and CI workflows
(§7d); fixing forward (up to 3 attempts); writing closing records; releasing claims and heartbeats; and removing your
own worktrees and branches. When a fact is unclear, verify it read-only. When intent is unclear inside the task, take
the most conservative option and list it under "Decisions taken" (CLAUDE.md Autonomy Contract, IF–THEN 10).
**Never end a reply with an offer or a question about a routine next step** ("shall I proceed?", "I can continue if
you like", "want me to open the PR?"). Do that step. A reply ends because the outcome is reached, or because a stop
below applies.

## Stops (the only reasons to stop and ask; each rule is unchanged)
| # | Stop | Rule | Can it stop work before STAGING-VERIFY? |
|---|---|---|---|
| 1 | Applying a database migration. The owner must approve the migration file(s) and the target database before `RUN-MIGRATION.yml` or a vitana-v1 `apply-*.yml` runs, because staging shares the production database. Writing the migration file in a PR needs no approval. | `collaboration.md` §7d | Yes, when staging needs the migration applied first |
| 2 | Production: PUBLISH, any `AWS-PROD-*` or production deploy workflow | `collaboration.md` §7c, §7d "Never"; CLAUDE.md IF–THEN 22–26 | No. Production comes after STAGING-VERIFY (Gate 2). A write to the production database before then is a live write (row 7) |
| 3 | Merging a change to a protected gate file (`scripts/collab/protected-gate-files.json`, e.g. `CLAUDE.md`). It needs the owner's instruction naming the plan plus a reviewer-agent accept on the current head (Claude Code is retired). | `collaboration.md` §3a, §7b | Yes, for changes to those files only |
| 4 | Security or data-loss risk | CLAUDE.md Autonomy Contract (c); `collaboration.md` §7 | Yes |
| 5 | The same failure surviving 3 fix-forward attempts (park the lane or plan) | CLAUDE.md Autonomy Contract (d); `collaboration.md` §7, §7a | Yes |
| 6 | An escalated sparring verdict, or work outside the converged plan that one more round does not settle | `collaboration.md` §7; CLAUDE.md Autonomy Contract (a) | Yes |
| 7 | Verification would need a write to a live or shared system (production Supabase, gateway, community content) | vitana-v1 CLAUDE.md absolute rule; platform CLAUDE.md IF–THEN 31–32, `collaboration.md` §7a | Yes. Raise it as a blocker, never route around it |
| 8 | Work in a repository other than `exafyltd/vitana-platform` and `exafyltd/vitana-v1` | `AGENTS.md` | Yes |
| 9 | A Commerce onboarding change that increases supplier friction, before merge | vitana-v1 CLAUDE.md "Commerce UX contract" | Yes, Commerce supplier screens only |
| 10 | A change to the Spotlight design contract itself (an archetype, card size, token or rule) | vitana-v1 `.claude/rules/design.md` | Yes, design-contract changes only |
| 11 | The VTID allocator is disabled or failing | CLAUDE.md §4.1 step 5, IF–THEN 1 | Yes, rare |
| 12 | Gate 1, for a plan Claude Code sparred with its own local partner. A CI-sparred plan that converged is approved by policy and never goes to the owner. | CLAUDE.md Autonomy Contract; `collaboration.md` §7 | Claude Code local sparring only |
| 13 | Turning on product autonomy: autonomous execution (`EXECUTION_DISARMED`, `AUTOPILOT_LOOP_ENABLED`, `metadata.autonomous_execution`) or a loop's autonomy level | platform CLAUDE.md NEVER 34; §5 Governance | Yes, changes to those settings only |

How to read the broad sentences, without weakening them:
- vitana-v1 CLAUDE.md, *"When in any doubt, stop and ask first. Writing to a shared/live system … requires explicit
  approval"*: this applies to writes to shared or live systems (stop 7), which is the topic of the paragraph it is in.
  It is not a general rule to ask about other steps.
- platform CLAUDE.md NEVER 34, *"Never enable autonomy without explicit approval"*: this covers the product's
  autonomy settings (stop 13). It does not cover an agent finishing the task it was given. The owner's instruction
  above is that approval for agent work, and it is not approval for stop 13.
- `docs/DEPLOYMENT-PIPELINE.md`, *"PR reviewed + approved"*: the reviewer agent's accept under §7 / §7b. Not a
  human PR approval.
- CLAUDE.md IF–THEN 9, *"prefer stricter rule"*: keep every stop above. It does not turn a routine step into a
  question, because every rule set says not to ask about routine steps.

The table lists the reasons to **ask**. Every prohibition in the rule files still applies as written, and none of
them is a question: for example CLAUDE.md AI-27 (no Google routing), IF–THEN 11 (wrong AWS account or region), IF–THEN 6
(governance failed), the absolute rule against testing on production, and never skipping or loosening a test.

## When a stop applies
Send one message: what you want to do; why it is needed; the evidence; the exact rule (file and section) that requires
the stop; the recommended answer; and the exact decision or action you need from the owner (the five-part stop message
of `collaboration.md` §7). Finish all other work the stop does not block before you send it. After the owner answers,
continue without asking again.
