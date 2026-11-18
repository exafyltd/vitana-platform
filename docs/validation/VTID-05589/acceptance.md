# VTID-05589 — Acceptance (companion-test-card / v1-test-card-button)

Scope of this PR: an admin-only row in `src/components/settings/VitanaMessagesSettings.tsx` (rendered by
`src/pages/settings/SettingsNotifications.tsx` on desktop and `src/pages/MobileSettings.tsx` on mobile), the client
`src/hooks/useCompanionTestCard.ts`, i18n keys `screens.settings.vitanaMessages.testCard.*` in all 11
`src/i18n/*/screens.json`, two Vitest suites and this validation folder. MERGE_PAYLOAD_PREVIEW: the community app's
Vitana messages settings gain one button that only exafy admins see.

AC-1 — A member (not an exafy admin) sees no test-card row and nothing is sent.
  TEST: src/components/settings/VitanaMessagesSettings.test-card.test.tsx "a member sees no test-card row and nothing is sent".

AC-2 — An exafy admin sees the row; one press sends exactly one request; the button is disabled while the request is pending and a second press then sends nothing.
  TEST: "an exafy admin sees the row; one press sends once and disables the button while pending".

AC-3 — The request is POST {GATEWAY_API_URL}/companion/test-card with the session bearer and only `{ moment_key: "vitana_index" }`.
  TEST: src/hooks/useCompanionTestCard.test.ts "posts once to the test-card route with the bearer and only moment_key".

AC-4 — Success shows the "sent" message and a link to the chat with Vitana (`/inbox/u/<Vitana bot id>`).
  TEST: "success shows the sent message and a link to the chat with Vitana".

AC-5 — 409 (staging or sending off) → "unavailable"; 422 → "noIndex"; 429 → "rateLimited"; 403/5xx/non-JSON/network → "failed"; no chat link on any error.
  TEST: useCompanionTestCard.test.ts "status %i with %j maps to the %s message", "a network failure is a failed result, never a throw"; VitanaMessagesSettings.test-card.test.tsx "status %i with %j shows the %s message and no chat link".

AC-6 — Every visible string comes from the i18n catalogs, German first in du-form, all 11 locales filled, no formal-register violation.
  UI: src/i18n/*/screens.json `screens.settings.vitanaMessages.testCard.*`; `npm run i18n:register` → no violations; `npm run i18n:gate` identical to base (commands.log).

AC-7 — The existing Vitana messages settings behave as before.
  TEST: src/components/settings/VitanaMessagesSettings.vtid-05100.test.tsx (unchanged, green).

AC-8 — The new suites fail on base.
  TEST: red-on-base.txt (6 failed, 1 passed, and the hook suite cannot load, on 4d9361db38).

Not claimed here: pressing the button on a deployed app. On staging the gateway answers 409 by design (shared production
database, rule 48); in production the owner presses it after Gate 2 and the owner's publish of both the gateway
(VTID-05588) and this frontend.
