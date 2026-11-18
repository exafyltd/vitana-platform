---
slug: companion-test-card
author: kiro
author_seat: exafy
executor: kiro
next_actor: kiro
state: approved
updated: 2026-11-06T17:09Z
sparring_record: .kiro/specs/companion-test-card/sparring/verdict.md
vtids: [VTID-05588, VTID-05589]
---
# Handoff — companion-test-card

Plan: `plan.md`. Tasks: `tasks.md`. Two lanes, serial (`depends_on`):
- `gateway-test-card` (repo `exafyltd/vitana-platform`, executor kiro, seat exafy): `POST /api/v1/companion/test-card`,
  exafy admin only, sends one companion card to the caller.
- `v1-test-card-button` (repo `exafyltd/vitana-v1`, executor kiro, seat exafyltd): admin-only button in Vitana messages
  settings.

No migration. Owner stop to expect: Gate 2 (two publishes: gateway, then frontend).

## Log
### 2026-11-06T17:10Z · kiro-exafy-202611061658-9ca9 · drafted
Written on the owner's request of 6 Nov 2026 (see a first card now, e.g. the Vitana Index card; owner chose the
admin-only test send). Investigation on origin/main: routes/companion.ts, scheduled-notifications.ts companion-tick,
companion-service.ts, moments.ts, delivery.ts, companion-repository.ts, auth-supabase-jwt.ts, and in vitana-v1
VitanaMessagesSettings.tsx, useCompanionPreferences.ts, useTenant.tsx, MessageBubble.tsx, VitanaChatCard.tsx.

### 2026-11-06T17:09Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 2 lane(s) got a VTID and are handed to Kiro.

### 2026-11-06T17:20Z · kiro-exafy-202611061658-9ca9 · approved (driver: merging the plan PR)
Sparring converged in round 2 (verdict.md); lanes have VTID-05588 (gateway-test-card) and VTID-05589
(v1-test-card-button). R2-F1 (minor, open at convergence): `getServiceClient()` is local to
scheduled-notifications.ts; `getSupabase()` (`lib/supabase.ts:5`) is already a service-role client, so the lane uses
it — the plan's intent (a service-role client for the bot-sender insert) holds; listed under Decisions taken at Gate 2.
Next: merge PR #4750 under §7b once checks are green, then build `gateway-test-card`.
