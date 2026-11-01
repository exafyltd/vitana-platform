---
lane: maxina-golden-suite
state: ready
next_actor: kiro
executor: kiro
seat: jtadic
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
depends_on: []
paths:
  - services/gateway/test/mt-maxina-golden.test.ts
  - services/gateway/test/golden/**
  - scripts/mt/golden/**
updated: 2026-11-01T17:06Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05448
---
# Maxina golden suite + v1-golden-edge fixture — mt-guardrails-r2/maxina-golden-suite (repo vitana-platform)

Plan: `.kiro/specs/mt-guardrails-r2/plan.md` (authoritative) and the `maxina-golden-suite` section of
`tasks.md` (M1–M3, allowed paths, acceptance). Design and the rules you must follow: `design.md`.

VTIDs come from PLAN-SPAR on convergence; never by hand. No lane
dependency (it renders Maxina config, independent of the stack lanes).

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of
`handoff.md`, no merge/approve/deploy/workflow dispatch, no live-system writes. **Never capture or
compare spoken output (rule 41)** — compare facts/intents and non-speech UI/push/email strings only. This
lane OWNS `golden/v1-golden-edge.*`; mt-packs P4 regenerates it as a declared, reviewed golden update
(CROSS-SPEC O3) through the documented regenerate script, never a silent diff. Keep `test:support`/
`test:operator`/`test:roles` green. Work only inside the allowed paths; add this lane's own
`docs/validation/<vtid>/`.

Branch `kiro/mt-guardrails-r2/maxina-golden-suite`; PR title `VTID-xxxxx
(mt-guardrails-r2/maxina-golden-suite): …`; commit trailers `Collab-Session: <your kiro session id>` and
`Collab-Lane: mt-guardrails-r2/maxina-golden-suite`. When the PR is open: set `state: in-review`,
`next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-11-01T15:30Z · kiro-hotmail-202611011402-f523 · ready
Lane created with the re-plan `mt-guardrails-r2` (carried from `mt-guardrails`).

### 2026-11-01T17:06Z · ci-plan-spar · ready (VTID allocated)
VTID-05448 allocated after policy approval (converged-auto-v1).
