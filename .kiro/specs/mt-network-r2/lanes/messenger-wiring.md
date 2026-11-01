---
lane: messenger-wiring
state: ready
next_actor: kiro
depends_on: [network-visibility-db]
executor: kiro
seat: exafyltd
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
area: messenger
paths:
  - src/pages/Messages.tsx
  - src/hooks/useGlobalMessages.ts
  - src/hooks/useHybridMessages.ts
  - src/hooks/useTenantMessages.ts
  - src/components/messages/**
  - src/components/NewConversationPopup.tsx
  - src/i18n/de/inbox.json
  - src/i18n/en/inbox.json
  - src/hooks/useGlobalMessages.scope.test.ts
  - tests/e2e/staging/mt-network-messenger.staging.spec.ts
  - docs/SCREEN_INVENTORY.md
updated: 2026-11-01T15:54Z
repos: [exafyltd/vitana-v1]
---
# mt-network-r2/messenger-wiring — fix inverted labels, scope wiring, one-time prompt (repo vitana-v1)

Plan: `.kiro/specs/mt-network-r2/plan.md`; tasks: the `messenger-wiring` group in `tasks.md`; design: `design.md`. 
Code lane, merged dark behind `mt.network_enabled` except the one-time network-visibility prompt (D23, recorded Maxina golden exception). Fixes the inverted `inboxModes` at `Messages.tsx:153-154`, removes the legacy `tenant`/professional routing, wires thread identity. i18n DE-first du-form; RTL logical properties; Spotlight contract. No new route → no nav-registry/screen-manifest/parity-ledger change. Adds its own `docs/validation/<vtid>/`.

§7a rules apply (no live writes; staging specs read-only). Depends on `network-visibility-db` (the prompt reads/writes `network_visible` only through the gateway RPCs). Work only inside the allowed paths.

Branch `kiro/mt-network-r2/messenger-wiring`; PR title `VTID-xxxxx (mt-network-r2/messenger-wiring): …`; trailers `Collab-Session`, `Collab-Lane: mt-network-r2/messenger-wiring`. On PR open: `state: in-review`, `next_actor: kiro` (reviewer `jtadic`), `pr: <url>`, log, release.

## Log
### 2026-11-01T15:54Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-network/messenger-wiring`. Versions day-shifted to `20261102050*`. Reviewer agent.
