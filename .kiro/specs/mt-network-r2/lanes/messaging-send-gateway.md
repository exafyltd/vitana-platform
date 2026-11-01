---
lane: messaging-send-gateway
state: ready
next_actor: kiro
depends_on: [messaging-send-db, network-visibility-db]
executor: kiro
seat: jtadic
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - services/gateway/src/routes/chat.ts
  - services/gateway/src/routes/chat-repository.ts
  - services/gateway/src/services/orb-tools-shared.ts
  - services/gateway/src/routes/intents-share-repository.ts
  - services/gateway/src/routes/chat-groups-repository.ts
  - services/gateway/src/orb/live/session/upstream-message-handler-repository.ts
  - services/gateway/src/services/companion/companion-repository.ts
  - services/gateway/src/services/intent-notifier-repository.ts
  - services/gateway/src/services/orb-tools/messaging-depth-tools-repository.ts
  - services/gateway/src/services/chat-writer-inventory.ts
  - services/gateway/test/mt-network-messaging-send-gateway.test.ts
  - services/gateway/test/mt-network-chat-writer-lint.test.ts
updated: 2026-11-01T15:54Z
repos: [exafyltd/vitana-platform]
---
# mt-network-r2/messaging-send-gateway — route sends through the RPCs + writer lint (repo vitana-platform)

Plan: `.kiro/specs/mt-network-r2/plan.md`; tasks: the `messaging-send-gateway` group in `tasks.md`; design: `design.md`. 
Code lane, merged dark behind `mt.network_enabled`. Rewrites `/send` (`chat.ts:58`) to call `send_message()` with the user JWT (not the service-role client at `chat.ts:51-54`), routes the on-behalf sends through `send_message_as()`, and adds the writer inventory + lint. Adds its own `docs/validation/<vtid>/`.

§7a rules apply (no VTID alloc, no live writes, no merge/deploy). Depends on `messaging-send-db` (the RPCs exist) and `network-visibility-db` (the preference/`network_visible` checks). Work only inside the allowed paths — do NOT touch migrations here.

Branch `kiro/mt-network-r2/messaging-send-gateway`; PR title `VTID-xxxxx (mt-network-r2/messaging-send-gateway): …`; trailers `Collab-Session`, `Collab-Lane: mt-network-r2/messaging-send-gateway`. On PR open: `state: in-review`, `next_actor: kiro` (reviewer `exafyltd`), `pr: <url>`, log, release.

## Log
### 2026-11-01T15:54Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-network/messaging-send-gateway`. Paths corrected to the real files on `main`. Versions day-shifted to `20261102050*`. Reviewer agent.
