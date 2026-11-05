---
lane: messenger-wiring
state: ready
next_actor: owner
depends_on: [network-visibility-db]
executor: kiro
seat: exafyltd
reviewer_seat: jtadic
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
updated: 2026-10-15T16:40Z
---
# mt-network/messenger-wiring — fix inverted labels, scope wiring, one-time prompt (repo vitana-v1)

Plan: `.kiro/specs/mt-network/plan.md`; tasks: the `messenger-wiring` group in `tasks.md`; design: `design.md`. **Held:** `next_actor: owner` until PLAN-SPAR allocates the VTID. `area: messenger` (seat `exafyltd`) per `areas.yaml` — the messenger paths beat the `frontend` catch-all. Note: `src/pages/Messages.tsx` is the live file (the `src/pages/messages/**` glob in `areas.yaml` is the area key, not this file's path); it is listed explicitly here.

Code lane, merged dark behind `mt.network_enabled` except the one-time network-visibility prompt (D23, recorded Maxina golden exception). Fixes the inverted `inboxModes` at `Messages.tsx:153-154`, removes the legacy `tenant`/professional routing, wires thread identity. i18n DE-first du-form; RTL logical properties; Spotlight contract. No new route → no nav-registry/screen-manifest/parity-ledger change. Adds its own `docs/validation/<vtid>/`.

§7a rules apply (no live writes; staging specs read-only). Depends on `network-visibility-db` (the prompt reads/writes `network_visible` only through the gateway RPCs). Work only inside the allowed paths.

Branch `kiro/mt-network/messenger-wiring`; PR title `VTID-xxxxx (mt-network/messenger-wiring): …`; trailers `Collab-Session`, `Collab-Lane: mt-network/messenger-wiring`. On PR open: `state: in-review`, `next_actor: kiro` (reviewer `jtadic`), `pr: <url>`, log, release.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the planner. Held until the VTID is allocated.
