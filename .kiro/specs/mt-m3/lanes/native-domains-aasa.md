---
lane: native-domains-aasa
state: ready
next_actor: owner
depends_on: []
executor: kiro
seat: exafy
reviewer_seat: exafyltd
paths:
  - public/.well-known/apple-app-site-association
  - public/.well-known/assetlinks.json
  - apps/mobile/parity/**
  - scripts/native/**
  - src/lib/universal-links/**
  - docs/validation/VTID-*/**
updated: 2026-10-15T16:40Z
---
# AASA/assetlinks custom-domain readiness — mt-m3 (repo vitana-v1)

Plan: `.kiro/specs/mt-m3/plan.md`; tasks N1–N4 in `tasks.md`; design in `design.md`. Keeps one `vitanaland.com`
AASA/assetlinks set for path-slug tenants (§4.8), adds a generation/README note, and a guard test that the committed
files stay valid and that a `tenant_domains.host` needing native reach is flagged as requiring a per-domain app release
(associated-domain entitlements) — never silently assumed. No store submission (owner-gated native release). Parity-
ledger row if a mobile-visible surface changes (`node scripts/native/parity-ledger.mjs --sync`). The lane adds its own
`docs/validation/VTID-<vtid>/`.

Rules (collaboration §7a): no VTID allocation, no `_plan` claim, no `handoff.md` edit, no merge/approve/deploy/dispatch,
no Supabase/AWS writes, no store submission. Work only inside the allowed paths. Branch `kiro/mt-m3/native-domains-aasa`;
PR title `VTID-xxxxx (mt-m3/native-domains-aasa): …`; trailers `Collab-Session` / `Collab-Lane: mt-m3/native-domains-aasa`.
When the PR is open: set `state: in-review`, `next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.

HELD: `next_actor: owner` until PLAN-SPAR allocates this lane's VTID.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the mt-m3 plan. Held for PLAN-SPAR. Native lane, seat `exafy`, reviewer `exafyltd`.
