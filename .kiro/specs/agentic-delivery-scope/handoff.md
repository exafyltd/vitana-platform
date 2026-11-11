---
slug: agentic-delivery-scope
author: kiro
author_seat: exafyltd
executor: kiro
next_actor: kiro
state: approved
updated: 2026-11-11T16:49Z
sparring_record: .kiro/specs/agentic-delivery-scope/sparring/verdict.md
vtids: [VTID-05734, VTID-05735, VTID-05736, VTID-05737, VTID-05738, VTID-05739, VTID-05740, VTID-05741, VTID-05742, VTID-05743, VTID-05744, VTID-05745, VTID-05746, VTID-05747, VTID-05748, VTID-05749]
---
# Handoff — agentic-delivery-scope

Plan: `plan.md`. Tasks: `tasks.md`. 16 lanes (`lanes/*.md`); the 11 address-cleanup lanes of plan §8a are added after convergence. It reuses
the Wave 1 lanes of `agentic-delivery-v2` (#4959) instead of duplicating them.

## Log

### 2026-11-11T16:23Z · kiro-exafyltd-202611111044-8f1d · drafted
Owner spec `agentic-delivery-scope` v5 (2026-11-11), quoted in `plan.md`. Pushed as a `plan(` PR for PLAN-SPAR. No
VTID before convergence; CI allocates them.

W0, read-only reconciliation of the 14 `agentic-delivery` lanes on `main` (evidence from GitHub and the lane files):

| Lane | State on main | VTID | Evidence |
|---|---|---|---|
| build-class-retag | ready | 05643 | no PR; superseded by `-2` |
| build-class-retag-2 | executing (stale) | 05671 | #4889 merged `593502c2e8`; accept on `057417fe24` |
| cut-settings | ready | 05562 | no PR; depends on `cutover` |
| cutover | ready | 05545 | #4725 open |
| deploy-path | executing (stale) | 05546 | #4714 merged `6dc6e1ba0c`; accept on `e8a7eb0e4f` |
| gateway-delivery | done | 05547 | #4764 |
| github-bridge | done | 05548 | #4635, #4642, #4689 |
| merge-queue | done | 05549 | closing record #4864 |
| nav-paths | done | 05563 | #4722 |
| pipelines | done | 05550 | #4775, record #4778 |
| prerequisites | done | 05551 | #4635, #4642 |
| reseat | done | 05554 | #4703 |
| sv-cwd | done | 05564 | #4720 |
| verify-on-gitlab | done | 05552 | #4705 |

The two stale lane files and `tasks.md` (0 of 60 boxes ticked) belong to seat `exafy`: a session of another seat may not
edit them (Lane scope seat rule, `scripts/collab/queue.mjs` `scopeCheck`). Recorded, not changed.

W4: shard 4/4 at `611e93c3ca` fails one test (`services/gateway/test/vtid-04715-staging-verify-deployed-commit.test.ts:76`),
at `6dc6e1ba0c` none (v2 C2). Job 1084's log stays unread (P5).

Model probe from the session role (2026-11-11 15:34 UTC, `bedrock-runtime` from `eu-central-1`): Sonnet 4.6 answered
(1,266 ms); Opus 5.5, Sonnet 5.5, Opus 4.6 (text and vision), Opus 5.5 vision and DeepSeek V3.2 (`eu-north-1`) were
AccessDenied (no identity-based policy for the session role). That is the session role's view only (P7).

W7: `AWS-REHEARSAL-AURORA-CLONE` `action: status` (run 43053659836) stopped at its pre-check: "source cluster
vitana-aurora-prod not found" (the script hides whether it is absent or unreadable, premise 18). `create` was not run.

### 2026-11-11T16:49Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 16 lane(s) got a VTID and are handed to Kiro.
