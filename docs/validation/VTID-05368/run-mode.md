# Messenger Vitana cards — run mode (VTID-05368)

Plan `messenger-vitana-cards-v2` (VTID-05366, VTID-05367, VTID-05368). How the personalized enrichment cards reach a
member's Vitana chat, and what is switched on where.

## What the feature does
Once a day, inside the member's local delivery window (07:30–09:30 by default), the Vitana Companion Messages tick
(`services/gateway/src/services/companion/companion-service.ts`, every 15 minutes) picks ONE moment for the member and,
in a sending mode, delivers it as a Vitana DM in `/inbox/u/<Vitana bot id>` with a Unified Card System card under it
(`metadata.card = { kind: 'vitana_card', v: 1, card_type, params }`, rendered by vitana-v1 `MessageBubble` →
`VitanaChatCard`).

This plan adds the 11 profile-enrichment cards (E1–E11) as moments. A member gets one only when:
- they have not done it (completion from the source tables, the same rules as `GET /api/v1/enrichment-cards`),
- they did not dismiss it on any screen in the last 7 days (`user_enrichment_cards`),
- its action works on this stack (E6/E7 need `INSTAGRAM_CLIENT_ID/SECRET` / `FACEBOOK_CLIENT_ID/SECRET`), and
- no health or habit moment is due that day (the Vitana Index, a lapsed diary and the Guided Journey always win).

## Where it runs
| Environment | Mode | What happens |
|---|---|---|
| Staging (`preview-aws-gateway.vitanaland.com`) | `disabled-on-staging`, always | Nothing. Staging shares the production database, so the engine refuses to run (`config.ts`). `GET /api/v1/companion/status` answers `mode: disabled-on-staging`. |
| Production, default | `off` (no flag) or `shadow` | `shadow` decides and records a ledger row; nothing is sent. |
| Production, `COMPANION_MODE=staff` + `COMPANION_SEND_ENABLED=true` + feature flag | `staff` | Staff/admin members get the real DM with the card; everyone else stays shadow. |
| Production, `COMPANION_MODE=live` + `COMPANION_SEND_ENABLED=true` + feature flag | `live` | Every eligible member gets the DM with the card. |

**This plan changes none of these switches.** Merging it does not send any message in any environment.

## How a tester sees it
Because staging can never send, the only places to see the card in a real chat are production `staff` mode (staff
accounts only) and production `live` mode. Turning either on is a production change and an owner decision (PUBLISH +
the environment switches above), separate from this plan.

On staging you can verify:
- the gateway build is live and the engine reports `disabled-on-staging` (`docs/validation/VTID-0536{6,7,8}/staging-tests.json`);
- the card rendering itself (vitana-v1, already shipped): `VitanaChatCard` renders any card type from the shared
  registry, including E1–E11.

## Evidence
The selection, delivery payload, pacing and one-a-day rules are proven offline:
`services/gateway/test/vtid-05366-companion-enrichment-moments.test.ts`,
`services/gateway/test/vtid-05367-companion-enrichment-signals.test.ts`,
`services/gateway/test/vtid-05368-messenger-companion-verification.test.ts`.
