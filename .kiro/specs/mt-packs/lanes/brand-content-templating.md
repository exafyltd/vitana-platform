---
lane: brand-content-templating
state: ready
next_actor: owner
depends_on: []
executor: kiro
seat: jtadic
reviewer_seat: exafy
paths:
  - services/gateway/src/data/feature-tips.ts
  - services/gateway/src/services/notification-controls/**
  - services/gateway/src/i18n/**
  - services/gateway/test/mt-packs-brand-templating-*.test.ts
updated: 2026-10-15T19:05Z
---
# brand-content-templating — {{brand}} for push/email/tips/tt() (repo vitana-platform)

Plan: `.kiro/specs/mt-packs/plan.md` (authoritative) and the `brand-content-templating` section of `tasks.md`
(B1–B3, allowed paths, acceptance). Design + successor rules: `design.md`.

Render `{{brand}}` from the resolved tenant brand pack (`tenants`/`tenant_settings.brand`) in push copy, feature
tips (`data/feature-tips.ts`), tool descriptions and `tt()` catalog entries ONLY; default to Maxina's brand when
unresolved (output byte-identical). **Rule 41 is absolute:** `{{brand}}` is never used in a spoken string — a
guard test fails the build if it is. This lane adds its own `docs/validation/<vtid>/`.

**HELD:** `next_actor: owner` until PLAN-SPAR allocates this lane's VTID; PLAN-SPAR flips it to `kiro`.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes. Work only inside the allowed paths. Branch
`kiro/mt-packs/brand-content-templating`; PR title `VTID-xxxxx (mt-packs/brand-content-templating): …`;
trailers `Collab-Session: <id>` / `Collab-Lane: mt-packs/brand-content-templating`. When the PR is open: set
`state: in-review`, `next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-10-15T16:18Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the mt-packs planner. Seat `jtadic` (platform gateway, server-side i18n), reviewer `exafy` (≠ seat).
Held at `owner` pending VTID.

### 2026-10-15T18:40Z · kiro-hotmail-202610151618-b437 · internal-review fix
HIGH-4: corrected the `tt()` catalog path from the non-existent `services/gateway/src/services/i18n/**` to
`services/gateway/src/i18n/**` (verified: `tt()` is exported from `services/gateway/src/i18n/catalog.ts`; there is
no `services/gateway/src/services/i18n/` directory). `data/feature-tips.ts` and `services/notification-controls/**`
unchanged (both exist).

### 2026-10-15T19:05Z · kiro-hotmail-202610151618-b437 · internal-review fix (round 2)
MEDIUM-1: removed the false `area: backoffice` label. Verified against `docs/programs/areas.yaml`: the
`backoffice` area covers only `routes/backoffice-*.ts` and `services/backoffice*/**`; this lane's paths
(`data/feature-tips.ts`, `services/notification-controls/**`, `i18n/**`) match no area, and there is no general
`gateway` area. `area` is dropped (optional, not validated by queue.mjs); `seat: jtadic` kept (uncovered platform
gateway → jtadic per the brief). No path or scope change.
