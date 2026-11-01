---
lane: native-domains-aasa
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - public/.well-known/apple-app-site-association
  - public/.well-known/assetlinks.json
  - apps/mobile/parity/**
  - scripts/native/**
  - src/lib/universal-links/**
  - docs/validation/VTID-*/**
updated: 2026-11-01T15:43Z
repos: [exafyltd/vitana-v1]
---
# AASA/assetlinks custom-domain readiness — mt-m3 (repo vitana-v1)

Plan: `.kiro/specs/mt-m3-r2/plan.md`; tasks N1–N4 in `tasks.md`; design in `design.md`. Keeps one `vitanaland.com`
AASA/assetlinks set for path-slug tenants (§4.8), adds a generation/README note, and a guard test that the committed
files stay valid and that a `tenant_domains.host` needing native reach is flagged as requiring a per-domain app release
(associated-domain entitlements) — never silently assumed. No store submission (owner-gated native release). Parity-
ledger row if a mobile-visible surface changes (`node scripts/native/parity-ledger.mjs --sync`). The lane adds its own
`docs/validation/VTID-<vtid>/`.

Rules (collaboration §7a): no VTID allocation, no `_plan` claim, no `handoff.md` edit, no merge/approve/deploy/dispatch,
no Supabase/AWS writes, no store submission. Work only inside the allowed paths. Branch `kiro/mt-m3-r2/native-domains-aasa`;
PR title `VTID-xxxxx (mt-m3-r2/native-domains-aasa): …`; trailers `Collab-Session` / `Collab-Lane: mt-m3-r2/native-domains-aasa`.
When the PR is open: set `state: in-review`, `next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.


## Log
### 2026-11-01T15:43Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-m3/native-domains-aasa`. Versions day-shifted to `20261102140*`. Executor and reviewer follow today's §3a/§7 rules.
