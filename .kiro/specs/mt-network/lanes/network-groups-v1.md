---
lane: network-groups-v1
state: ready
next_actor: owner
depends_on: [network-groups-gateway]
executor: kiro
seat: exafyltd
reviewer_seat: jtadic
area: messenger
paths:
  - src/components/messages/**
  - src/pages/Messages.tsx
  - src/i18n/de/inbox.json
  - src/i18n/en/inbox.json
  - tests/e2e/staging/mt-network-groups.staging.spec.ts
updated: 2026-10-15T16:40Z
---
# mt-network/network-groups-v1 — network group UI + labels (M3, flagged) (repo vitana-v1)

Plan: `.kiro/specs/mt-network/plan.md`; tasks: the `network-groups-v1` group in `tasks.md`; design: `design.md`. **Held:** `next_actor: owner` until PLAN-SPAR allocates the VTID. `area: messenger` (seat `exafyltd`) — the `src/components/messages/**` paths beat the `frontend` catch-all; `src/pages/Messages.tsx` listed explicitly. **M3 lane; flagged `mt.network_groups`.** Shares `Messages.tsx` + `src/i18n/*/inbox.json` with `messenger-wiring` (same seat) — sequence the merges.

Code lane. Network-group create/invite UI (invite-only between connections, ≤20), scope label "Netzwerk"; Spotlight tokens; RTL; i18n DE-first. Read-only staging spec. Own `docs/validation/<vtid>/`.

§7a rules apply (no live writes; staging specs read-only). Depends on `network-groups-gateway`. Work only inside the allowed paths.

Branch `kiro/mt-network/network-groups-v1`; PR title `VTID-xxxxx (mt-network/network-groups-v1): …`; trailers `Collab-Session`, `Collab-Lane: mt-network/network-groups-v1`. On PR open: `state: in-review`, `next_actor: kiro` (reviewer `jtadic`), `pr: <url>`, log, release.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the planner. Held until the VTID is allocated.
