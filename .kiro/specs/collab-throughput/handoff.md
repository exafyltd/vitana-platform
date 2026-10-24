---
slug: collab-throughput
author: kiro
author_seat: exafy
executor: claude
next_actor: claude
state: parked
updated: 2026-10-19T18:30Z
parked_from: drafted
---
# Handoff — collab-throughput

Speeds up the collaboration pipeline in three places:
- the queue runs in one pass instead of one git diff per branch;
- PLAN-SPAR checks sparring answers locally and comments on the PR instead of failing silently;
- a sparring code-access health route, checked before each round and by a scheduled alert.

Plan: `plan.md`. Requirements, design and tasks are alongside.

Lanes:
- `throughput-code`: executor **claude** (governance paths `scripts/collab/**`, `.github/**`), reviewer `exafy`.
  Build it after `sparring-floor-retry` (#4186), because both edit `plan-spar.mjs`.

Owner settings that are not part of this plan (see plan "Out of scope"): vitana-v1 auto-delete head branches, and
how often the authoring seats' automations run.

## Log

### 2026-10-18T20:40Z · kiro-exafy-202610181845-661d · drafted
Authored from the measured bottlenecks (queue ~0.9 s per branch diff × 496 branches; run 39157408933's silent
`unknown_finding`; 10 sessions with 0 successful reads on 2026-10-17). Pushed as a plan( PR for PLAN-SPAR. No VTID
allocated by this session.

### 2026-10-18T22:45Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T23:05Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T23:30Z · kiro-exafy-202610181845-661d · drafted (scope D added)
Round 1 escalated `model_unavailable`: both Opus 4.6 and the Sonnet 4.6 fallback returned "Too many tokens per
day" (that is the account's daily limit, not a plan problem). Added D (sparring token budget: concurrency cap,
clipping old tool results, token totals per round). I'll push after the daily limit resets, so the retry doesn't
burn more of it.

### 2026-10-19T18:10Z · kiro-exafy-202610181845-661d · drafted (re-plan, session 2)
Session 2eacb48d hit the round cap with R3-F1 open (main() had no path to comment on thrown gateway errors). The plan
now has one failure path in main() (try/catch around step() plus returned failure actions, always writing the
comment file), and the health pre-check only blocks on an explicit ok:false. Session 1's findings (R1-F1..F3,
R2-F1..F2, R3-F1) are all addressed in the plan text. This push starts session 2, the last.

### 2026-10-19T18:30Z · ci-plan-spar · drafted → parked
Not converged after 2 sparring sessions (round_cap_reached). Parked with the open findings in sparring/.

### 2026-10-19T18:45Z · kiro-exafy-202610181845-661d · parked (resolution notes for Claude Code)
Parked after the round cap in session 2 (1df87f89). Every earlier finding is acknowledged as resolved. The two
open round-3 findings are both small and accepted by the planner:
- R3-F1 (major): the health route should give `ok: false` only for 401/403 (the token itself cannot read).
  0/429/5xx from GitHub become `state: 'degraded'`, which does not block plan-spar and does not fail the alert
  (the alert can warn on degraded). Jest: 429 and 5xx give a non-blocking result.
- R3-F2 (minor): the local answer check wraps `parseResponses` / `JSON.parse` and maps their errors to
  `responses_invalid` ("malformed responses-<n>.md: <reason>"). The malformed-responses test asserts the action
  and message, not just exit 1.
Also add: PLAN-SPAR's VTID allocation should set a lane's `next_actor` from its `executor`, not always `kiro`
(seen on sparring-floor-retry, 2026-10-19).
Suggested path: apply both to `plan.md`, spar with Claude Code's local partner, and Gate 1 to the owner (§7), or
fold A–C into the same Claude Code session that builds VTID-05240, since all of it is `plan-spar.mjs`.
