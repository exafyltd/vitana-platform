---
lane: orb-recipient-scope-gateway
state: ready
next_actor: kiro
depends_on: [matching-intent-scope-db, messaging-send-gateway]
executor: kiro
seat: jtadic
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - services/gateway/src/services/orb-tools-shared.ts
  - services/gateway/test/mt-network-orb-scope.test.ts
updated: 2026-11-01T15:54Z
repos: [exafyltd/vitana-platform]
---
# mt-network-r2/orb-recipient-scope-gateway — ORB recipient/search scope (repo vitana-platform)

Plan: `.kiro/specs/mt-network-r2/plan.md`; tasks: the `orb-recipient-scope-gateway` group in `tasks.md`; design: `design.md`. 
Code lane, dark behind `mt.network_enabled`. Passes the new scope param to `resolve_recipient_candidates` (`orb-tools-shared.ts:2054-2061,2278-2282,2431-2435`) and the same rule to `find_community_member`/`global_search`/superlatives; default `community`, `network` only on explicit ask and only `network_visible` recipients whose preference allows — enforced in the handler/dispatcher, not the prompt. Dispatcher tests on Nova and the Vertex bridge. Own `docs/validation/<vtid>/`.

§7a rules apply. Depends on `matching-intent-scope-db` (the scope param on the RPC). Shares a file (`orb-tools-shared.ts`) with `messaging-send-gateway`; order them so one merges before the other rebases (coordinator sequences; both are jtadic). Work only inside the allowed paths.

Branch `kiro/mt-network-r2/orb-recipient-scope-gateway`; PR title `VTID-xxxxx (mt-network-r2/orb-recipient-scope-gateway): …`; trailers `Collab-Session`, `Collab-Lane: mt-network-r2/orb-recipient-scope-gateway`. On PR open: `state: in-review`, `next_actor: kiro` (reviewer `exafyltd`), `pr: <url>`, log, release.

## Log
### 2026-11-01T15:54Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-network/orb-recipient-scope-gateway`. Sequenced after the lane that shares its files. Versions day-shifted to `20261102050*`. Reviewer agent.
