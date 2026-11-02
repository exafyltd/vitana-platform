# VTID-05368 — Messenger Vitana cards: verification of the companion DM send path and run mode

Plan: `messenger-vitana-cards-v2` — CI PLAN-SPAR session `89e98eb8-922e-4c04-8de2-6bf56dbcd74b`, CONVERGED and approved
by policy `converged-auto-v1` (2026-10-28T10:25Z), final plan hash `e932e462…e0bf`. Record:
`.kiro/specs/messenger-vitana-cards-v2/sparring/verdict.md` (plan PR #4425). Lane `messenger-companion-verification`,
depends on `companion-enrichment-moments` (VTID-05366).

**This lane adds a test and documents; it changes no runtime code.** Nothing is sent in any environment.

AC-1 Run mode documented: `docs/validation/VTID-05368/run-mode.md` — staging is always `disabled-on-staging`; production
sends only with `COMPANION_SEND_ENABLED=true` + `COMPANION_MODE=staff|live` + the feature flag; this plan sets none.

AC-2 Send path, live mode: a member who set nothing up gets exactly one Vitana DM whose card is
`{ kind: 'vitana_card', v: 1, card_type: 'E1', params: {} }`; a fully set-up member gets the morning greeting (F4),
never an enrichment card.
TEST: services/gateway/test/vtid-05368-messenger-companion-verification.test.ts

AC-3 Pacing: the tick's default pacer is `canSurfaceProactively(member, 'messenger_companion')`, called once per member;
a paused member gets no DM.
TEST: services/gateway/test/vtid-05368-messenger-companion-verification.test.ts

AC-4 One card per member per local day: a second tick the same day sends nothing (`already_today`).
TEST: services/gateway/test/vtid-05368-messenger-companion-verification.test.ts

AC-5 Staff mode sends the enrichment card to staff members only; everyone else keeps the shadow behaviour. E6/E7 are
never offered while the Meta OAuth client is unset.
TEST: services/gateway/test/vtid-05368-messenger-companion-verification.test.ts

AC-6 Staging, read-only: `/alive` 200 and `GET /api/v1/companion/status` → `mode: disabled-on-staging`.
TEST: services/gateway/test/vtid-05100-companion-delivery.test.ts

Decisions taken (inside the approved plan, most conservative option):
- The default pacer is exercised through a module mock of `canSurfaceProactively` (not an injected `pacer` dep), so the
  test proves the surface the real tick uses.
