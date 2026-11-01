---
lane: network-groups-gateway
state: ready
next_actor: kiro
depends_on: [network-groups-db, messaging-send-gateway]
executor: kiro
seat: jtadic
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - services/gateway/src/routes/chat-groups-repository.ts
  - services/gateway/src/routes/chat-groups.ts
  - services/gateway/test/mt-network-groups-gateway.test.ts
updated: 2026-11-01T15:54Z
repos: [exafyltd/vitana-platform]
---
# mt-network-r2/network-groups-gateway — group create/join via DEFINER (M3, flagged) (repo vitana-platform)

Plan: `.kiro/specs/mt-network-r2/plan.md`; tasks: the `network-groups-gateway` group in `tasks.md`; design: `design.md`. 
Code lane. Routes network-group create/join through `add_group_member()` and enforces D27 server-side. Shares `chat-groups-repository.ts` with `messaging-send-gateway` — sequence the merges (coordinator; both jtadic). Own `docs/validation/<vtid>/`.

§7a rules apply. Depends on `network-groups-db` (the DEFINER + scope columns). Work only inside the allowed paths.

Branch `kiro/mt-network-r2/network-groups-gateway`; PR title `VTID-xxxxx (mt-network-r2/network-groups-gateway): …`; trailers `Collab-Session`, `Collab-Lane: mt-network-r2/network-groups-gateway`. On PR open: `state: in-review`, `next_actor: kiro` (reviewer `exafyltd`), `pr: <url>`, log, release.

## Log
### 2026-11-01T15:54Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-network/network-groups-gateway`. Paths corrected to the real files on `main`. Sequenced after the lane that shares its files. Versions day-shifted to `20261102050*`. Reviewer agent.
