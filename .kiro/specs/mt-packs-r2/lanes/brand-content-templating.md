---
lane: brand-content-templating
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: jtadic
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - services/gateway/src/data/feature-tips.ts
  - services/gateway/src/services/notification-controls/**
  - services/gateway/src/i18n/**
  - services/gateway/test/mt-packs-brand-templating-*.test.ts
updated: 2026-11-01T15:40Z
repos: [exafyltd/vitana-platform]
---
# brand-content-templating — {{brand}} for push/email/tips/tt() (repo vitana-platform)

Plan: `.kiro/specs/mt-packs-r2/plan.md` (authoritative) and the `brand-content-templating` section of `tasks.md`
(B1–B3, allowed paths, acceptance). Design + successor rules: `design.md`.

Render `{{brand}}` from the resolved tenant brand pack (`tenants`/`tenant_settings.brand`) in push copy, feature
tips (`data/feature-tips.ts`), tool descriptions and `tt()` catalog entries ONLY; default to Maxina's brand when
unresolved (output byte-identical). **Rule 41 is absolute:** `{{brand}}` is never used in a spoken string — a
guard test fails the build if it is. This lane adds its own `docs/validation/<vtid>/`.

The VTID comes from PLAN-SPAR on convergence, never by hand.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes. Work only inside the allowed paths. Branch
`kiro/mt-packs-r2/brand-content-templating`; PR title `VTID-xxxxx (mt-packs-r2/brand-content-templating): …`;
trailers `Collab-Session: <id>` / `Collab-Lane: mt-packs-r2/brand-content-templating`. When the PR is open: set
`state: in-review`, `next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-11-01T15:40Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-packs/brand-content-templating`. No scope change; lane follows today's §3a/§7 rules.
