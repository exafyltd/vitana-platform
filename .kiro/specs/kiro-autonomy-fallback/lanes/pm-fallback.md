---
lane: pm-fallback
state: ready
next_actor: kiro
depends_on: [scope-check]
executor: kiro
seat: exafy
area: platform
reviewer_seat: exafyltd
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - services/gateway/src/services/project-manager/**
  - services/gateway/src/routes/project-manager.ts
  - services/gateway/src/index.ts
  - services/gateway/test/project-manager/**
  - docs/validation/VTID-*/**
updated: 2026-10-20T17:20Z
---
# pm-fallback — the PM acts live, falls back to the exceptions seat, merges on the reviewer agent's accept, sends Gate 2
Plan: `.kiro/specs/kiro-autonomy-fallback/plan.md` §3, §4 and §5 C, and the `pm-fallback` section of `tasks.md` are
authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here. Repo
vitana-platform. **Deploys** (gateway): ships `docs/validation/<VTID>/staging-tests.json`; done when STAGING-VERIFY
passed on its merge commit.
`depends_on: [scope-check]` is real: the parity test reads `scripts/collab/protected-gate-files.json`, the PM requires the
`Collab handoff` check run, and its W1/W2 commits need the `pm-agent` exemption — all added by `scope-check`.
`services/gateway/src/index.ts`: only the PM block (`:1877-1903`). New `governance.ts` is a protected gate file (owner
instruction, plan §6). Acceptance by `agent:vitana-lane-reviewer (claude-sonnet-5.5)`; review entry committed under the
legacy `reviewer_seat` exafyltd. Shared files: none. Pre-existing `main` red (vtid-05077) → plan §6 waiting rule.
## Log
### 2026-10-20T17:20Z · kiro-exafyltd-202610201618-c018 · created → ready
Owner instruction 2026-10-20: "no more approvals, you run it end to end" — §7b merge instruction for this plan's named
set, approvals from the reviewer agent on claude-sonnet-5.5; lands after `steering-rules` and `scope-check`. Lane
created with the plan. Next: PLAN-SPAR; once `vtid:` is set and `scope-check` is done, seat exafy claims it.
