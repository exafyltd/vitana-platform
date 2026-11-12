# Tasks — companion-test-card

Code starts only after each lane has its CI-allocated VTID. Every lane writes its tests first and records them red on
`origin/main` in `docs/validation/<VTID>/red-on-base.txt`.

<!-- lane: gateway-test-card -->
Repo `exafyltd/vitana-platform`.
- [ ] T1 Write `services/gateway/test/companion-test-card.test.ts` (cases in plan "Tests and commands"); record it red
      on base (module and route missing).
- [ ] T2 `services/gateway/src/services/companion/test-card.ts`: `sendCompanionTestCard` with injectable deps, reusing
      `vitanaIndex`, `composeCompanionMessage`, `buildCompanionMetadata`, `repo.insertCompanionChatMessage`, `localTime`.
- [ ] T3 `routes/companion.ts`: `POST /test-card` (`requireAuth` → `requireExafyAdmin` → strict body → config → 60 s
      rate limit → send); header comment; `types/cicd.ts` gains `companion.test_card.sent`.
- [ ] T4 `docs/validation/<VTID>/staging-tests.json`: unauthenticated POST probe (401 JSON, `rejected_probe`), status
      probe (`disabled-on-staging`), and the Jest suite as `existing`; `commands.log` with the local run.
- [ ] T5 PR titled `VTID-xxxxx (companion-test-card/gateway-test-card): …`.

Acceptance:
- Change types: Backend (new route).
- **Outcome** — an exafy admin's call writes exactly one Vitana-bot DM to the caller with the F2 card metadata of a
  tick message plus `test: true`; nobody else receives anything.
- **States** — non-admin 403, no token 401, staging 409, sending off 409, no Index 422 (no write), compose failure 502
  (no write), second call within 60 s 429.
- **Surfaces** — caller: lane `v1-test-card-button`.
- **Contract** — the route contract in plan "Interfaces"; no ledger, pacer, push or `companion.message.sent` side
  effect (asserted).
- **Staging proof** — read-only probes; the send itself is not verified on staging (shared database, rule 48).

<!-- lane: v1-test-card-button -->
Repo `exafyltd/vitana-v1`.
- [ ] T1 Write `VitanaMessagesSettings.test-card.test.tsx` and `useCompanionTestCard.test.ts`; record them red on base.
- [ ] T2 `src/hooks/useCompanionTestCard.ts` (mutation, session bearer, error-code mapping).
- [ ] T3 `VitanaMessagesSettings.tsx`: admin-only row and button, toasts, DM link.
- [ ] T4 i18n keys `screens.settings.vitanaMessages.testCard.*` in all 11 `src/i18n/*/screens.json` (de first); run
      `npm run i18n:inventory`.
- [ ] T5 `docs/validation/<VTID>/staging-tests.json` (read-only: the settings page renders for a signed-out probe
      as today, the Jest/Vitest suite as `existing`); PR titled `VTID-xxxxx (companion-test-card/v1-test-card-button): …`.

Acceptance:
- Change types: Frontend.
- **Outcome** — an exafy admin sees the button and gets a success toast with a link to the Vitana DM; a member sees no
  change.
- **States** — pending (disabled), 409, 422, 429, other errors each show their own message.
- **Surfaces** — desktop Settings › Notifications and the mobile Settings screen (both render the component).
- **Contract** — calls only `POST /api/v1/companion/test-card` with no body fields beyond `moment_key`.
- **Staging proof** — read-only; pressing the button is not done on staging (the route answers 409 there).
