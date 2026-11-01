---
lane: network-groups-v1
state: ready
next_actor: kiro
depends_on: [network-groups-gateway, messenger-wiring]
executor: kiro
seat: exafyltd
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
area: messenger
paths:
  - src/components/messages/**
  - src/pages/Messages.tsx
  - src/i18n/de/inbox.json
  - src/i18n/en/inbox.json
  - tests/e2e/staging/mt-network-groups.staging.spec.ts
updated: 2026-11-01T15:54Z
repos: [exafyltd/vitana-v1]
---
# mt-network-r2/network-groups-v1 — network group UI + labels (M3, flagged) (repo vitana-v1)

Plan: `.kiro/specs/mt-network-r2/plan.md`; tasks: the `network-groups-v1` group in `tasks.md`; design: `design.md`. 
Code lane. Network-group create/invite UI (invite-only between connections, ≤20), scope label "Netzwerk"; Spotlight tokens; RTL; i18n DE-first. Read-only staging spec. Own `docs/validation/<vtid>/`.

§7a rules apply (no live writes; staging specs read-only). Depends on `network-groups-gateway`. Work only inside the allowed paths.

Branch `kiro/mt-network-r2/network-groups-v1`; PR title `VTID-xxxxx (mt-network-r2/network-groups-v1): …`; trailers `Collab-Session`, `Collab-Lane: mt-network-r2/network-groups-v1`. On PR open: `state: in-review`, `next_actor: kiro` (reviewer `jtadic`), `pr: <url>`, log, release.

## Log
### 2026-11-01T15:54Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-network/network-groups-v1`. Sequenced after the lane that shares its files. Versions day-shifted to `20261102050*`. Reviewer agent.
