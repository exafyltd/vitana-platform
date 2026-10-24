---
lane: discover-mode-ui
state: ready
next_actor: owner
depends_on: [discover-shared-predicate]
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: jtadic
paths:
  - src/pages/Discover.tsx
  - src/components/discover/**
  - src/components/commerce/**
  - src/lib/discover-scope.ts
  - src/i18n/de/discover.json
  - src/i18n/en/discover.json
  - src/i18n/de/commerce.json
  - src/i18n/en/commerce.json
  - src/components/discover/discover-scope.test.tsx
  - tests/e2e/staging/vtid-*-discover-scope.staging.spec.ts
  - docs/SCREEN_INVENTORY.md
  - i18n-source-stamps/**
updated: 2026-10-15T16:40Z
---
# discover-mode-ui — Discover Community/Network control + supplier UI (VTID allocated by PLAN-SPAR, repo vitana-v1)

Plan: `.kiro/specs/mt-discover/plan.md` (authoritative) and the `discover-mode-ui` group in `tasks.md` (tasks U1–U6,
allowed paths, acceptance). Design + successor rules: `design.md`.

**HELD:** `next_actor: owner` until PLAN-SPAR allocates this lane's VTID — PLAN-SPAR flips it to `kiro`. Depends on
`discover-shared-predicate` (the gateway serves scope-aware results): do not start before it is done.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes, and never call a write endpoint against a live
system. Work only inside the allowed paths (vitana-v1 only). The Discover scope control is SEPARATE from the Discover
tab pill and from `MobileModePill` (SPOTLIGHT_RULES.md §D): default Community, remembered per surface. Supplier
"which communities" + tenant accept/decline UI follow the Commerce UX contract (`vitana-v1/CLAUDE.md`) — AI-led, one
dominant action, no internal concepts; the PR carries a "UX acceptance" section. Spotlight contract, i18n DE-first
du-form, RTL. No new App.tsx route → no nav-registry / screen-manifest / parity-ledger change (if a route is added,
those three updates are in this lane). Dark behind `mt.network_enabled`. This lane adds its own
`docs/validation/<vtid>/`. Branch `kiro/mt-discover/discover-mode-ui`; PR title
`VTID-xxxxx (mt-discover/discover-mode-ui): …`; commit trailers `Collab-Session: <your kiro session id>` and
`Collab-Lane: mt-discover/discover-mode-ui`. When the PR is open: set `state: in-review`, `next_actor: kiro`
(reviewer seat `jtadic`), `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created, HELD at `next_actor: owner`. Frontend lane (seat `exafyltd`, area `frontend`). The separate Discover
Community/Network scope control + the supplier "which communities"/accept-decline UI. Depends on
`discover-shared-predicate`.
