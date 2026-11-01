---
lane: whats-new-drafter-prompt
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - .github/workflows/WHATS-NEW-DRAFT.yml
updated: 2026-11-01T15:40Z
repos: [exafyltd/vitana-v1]
---
# whats-new-drafter-prompt — brand-neutral What's New drafter prompt (repo vitana-v1) — mt-packs-r2

Plan: `../plan.md`. Tasks, paths and acceptance: `../tasks.md` (`<!-- lane: whats-new-drafter-prompt -->`). The VTID
comes from PLAN-SPAR on convergence, never by hand.

Scope: drop the hardcoded brand from the drafter prompt in vitana-v1 `.github/workflows/WHATS-NEW-DRAFT.yml` (the
workflow exists only in vitana-v1), so a drafted entry is brand-neutral and the `{{brand}}` layer supplies the
tenant brand at render time. `.github/**` is a governance path but not a protected gate file, so the lane is
`executor: kiro` and merges on a reviewer-agent accept on the current head with every check green
(`collaboration.md` §3a). The workflow is never dispatched by this lane.

Rules (§7a): no VTID allocation, no merge outside §7b, no workflow dispatch, no live write. Branch
`kiro/mt-packs-r2/whats-new-drafter-prompt`; PR title `VTID-xxxxx (mt-packs-r2/whats-new-drafter-prompt): …`; trailers
`Collab-Session` + `Collab-Lane: mt-packs-r2/whats-new-drafter-prompt`.

## Log
### 2026-11-01T15:40Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-packs/whats-new-drafter-prompt`. The executor moves from claude to kiro under §3a, with the reviewer
agent.
