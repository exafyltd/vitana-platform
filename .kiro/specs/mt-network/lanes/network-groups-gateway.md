---
lane: network-groups-gateway
state: ready
next_actor: owner
depends_on: [network-groups-db]
executor: kiro
seat: jtadic
reviewer_seat: exafyltd
paths:
  - services/gateway/src/services/chat-groups-repository.ts
  - services/gateway/src/routes/chat-groups.ts
  - services/gateway/test/mt-network-groups-gateway.test.ts
updated: 2026-10-15T16:40Z
---
# mt-network/network-groups-gateway — group create/join via DEFINER (M3, flagged) (repo vitana-platform)

Plan: `.kiro/specs/mt-network/plan.md`; tasks: the `network-groups-gateway` group in `tasks.md`; design: `design.md`. **Held:** `next_actor: owner` until PLAN-SPAR allocates the VTID. No `area` (gateway `services/**`/`routes/**` not in `areas.yaml`); seat `jtadic`. **M3 lane; flagged `mt.network_groups`.**

Code lane. Routes network-group create/join through `add_group_member()` and enforces D27 server-side. Shares `chat-groups-repository.ts` with `messaging-send-gateway` — sequence the merges (coordinator; both jtadic). Own `docs/validation/<vtid>/`.

§7a rules apply. Depends on `network-groups-db` (the DEFINER + scope columns). Work only inside the allowed paths.

Branch `kiro/mt-network/network-groups-gateway`; PR title `VTID-xxxxx (mt-network/network-groups-gateway): …`; trailers `Collab-Session`, `Collab-Lane: mt-network/network-groups-gateway`. On PR open: `state: in-review`, `next_actor: kiro` (reviewer `exafyltd`), `pr: <url>`, log, release.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the planner. Held until the VTID is allocated.
