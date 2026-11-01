---
lane: messaging-send-gateway
state: ready
next_actor: owner
depends_on: [messaging-send-db, network-visibility-db]
executor: kiro
seat: jtadic
reviewer_seat: exafyltd
paths:
  - services/gateway/src/routes/chat.ts
  - services/gateway/src/routes/chat-repository.ts
  - services/gateway/src/services/orb-tools-shared.ts
  - services/gateway/src/services/intents-share-repository.ts
  - services/gateway/src/services/chat-groups-repository.ts
  - services/gateway/src/services/upstream-message-handler-repository.ts
  - services/gateway/src/services/chat-writer-inventory.ts
  - services/gateway/test/mt-network-messaging-send-gateway.test.ts
  - services/gateway/test/mt-network-chat-writer-lint.test.ts
updated: 2026-10-15T16:40Z
---
# mt-network/messaging-send-gateway — route sends through the RPCs + writer lint (repo vitana-platform)

Plan: `.kiro/specs/mt-network/plan.md`; tasks: the `messaging-send-gateway` group in `tasks.md`; design: `design.md`. **Held:** `next_actor: owner` until PLAN-SPAR allocates the VTID and flips it to `kiro`. No `area` entry: gateway `services/**` is not in `areas.yaml`; the planner assigned seat `jtadic` per the brief's uncovered-platform rule (gateway/services → jtadic).

Code lane, merged dark behind `mt.network_enabled`. Rewrites `/send` (`chat.ts:58`) to call `send_message()` with the user JWT (not the service-role client at `chat.ts:51-54`), routes the on-behalf sends through `send_message_as()`, and adds the writer inventory + lint. Adds its own `docs/validation/<vtid>/`.

§7a rules apply (no VTID alloc, no live writes, no merge/deploy). Depends on `messaging-send-db` (the RPCs exist) and `network-visibility-db` (the preference/`network_visible` checks). Work only inside the allowed paths — do NOT touch migrations here.

Branch `kiro/mt-network/messaging-send-gateway`; PR title `VTID-xxxxx (mt-network/messaging-send-gateway): …`; trailers `Collab-Session`, `Collab-Lane: mt-network/messaging-send-gateway`. On PR open: `state: in-review`, `next_actor: kiro` (reviewer `exafyltd`), `pr: <url>`, log, release.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the planner. Held until the VTID is allocated.
