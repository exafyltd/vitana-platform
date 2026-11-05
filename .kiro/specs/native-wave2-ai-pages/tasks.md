# Tasks — Native Wave 2: AI assistant text pages

Three lanes, disjoint `paths`. Design: `design.md` and `requirements.md` in this folder are authoritative — follow
them exactly; anything outside them is a plan change (log it, set `next_actor: claude`). VTIDs are assigned by CI
after PLAN-SPAR converges; do not start a lane before its `vtid:` is set in `lanes/<id>.md`. All commands run from
`apps/mobile/` unless noted; `assertNotProduction()` and the no-production-profile rule make every command offline.

<!-- lane: ai-coach -->
## Lane `ai-coach` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports: `AI.OVERVIEW /ai`, `AI.INSIGHTS /ai/insights`, `AI.RECOMMENDATIONS /ai/recommendations`,
`AI.DAILY_SUMMARY /ai/daily-summary`, `AI.COMPANION /ai/companion` (5 ledger rows under `"lane": "ai"`).
depends_on: none. Web sources `src/pages/AI.tsx` (192), `src/pages/ai/Insights.tsx` (217),
`src/pages/ai/AIRecommendations.tsx` (218), `src/pages/ai/DailySummary.tsx` (128), `src/pages/ai/Companion.tsx`
(280); routes `src/App.tsx:1323-1347`.

- [ ] 1. (Only if a genuinely pure helper is found) re-export it through `@vitana/core`: add the
  `packages/core/manifest.json` line + a re-export in `packages/core/src/**`, then
  `node scripts/native/core-closure.mjs --write` and commit the regenerated `packages/core/closure.generated.json`
  and `scripts/native/mobile-ci-paths.generated.json`. The AI data paths here (`memory-api`, the companion chat
  transport) are class B (gateway) and are **re-implemented natively**, not extracted — if nothing pure remains,
  add no core entry.
  Files: `packages/core/manifest.json`, `packages/core/src/**`, `packages/core/closure.generated.json`,
  `scripts/native/mobile-ci-paths.generated.json`.
  Verify (repo root): `node scripts/native/core-closure.mjs --check` passes; `apps/mobile` → `npm run typecheck` green.
- [ ] 2. Native AI overview + insight screens on the N3 shell: `apps/mobile/src/screens/ai-coach/AIOverviewScreen.tsx`,
  `InsightsScreen.tsx`, `RecommendationsScreen.tsx` render the crossover / recommendation card stacks (twins of
  `AI.tsx`, `Insights.tsx`, `AIRecommendations.tsx`) as `VCard`s in a `ScrollView`/`FlatList`, mobile-web branch only.
  Files: `apps/mobile/app/(app)/ai/index.tsx`, `apps/mobile/app/(app)/ai/insights.tsx`,
  `apps/mobile/app/(app)/ai/recommendations.tsx`, `apps/mobile/src/screens/ai-coach/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 3. Daily summary + companion: `apps/mobile/app/(app)/ai/daily-summary.tsx` +
  `src/screens/ai-coach/DailySummaryScreen.tsx` (twin of `DailySummary.tsx`, the `fetchDailyLearnings` /
  `useVitanaIndexHistory` data path re-implemented through the native gateway port + a native query hook);
  `apps/mobile/app/(app)/ai/companion.tsx` + `src/screens/ai-coach/CompanionScreen.tsx` (twin of `Companion.tsx` —
  the AI coach chat, `HealthCoachChat` rendered natively with its chat transport re-implemented over the native
  gateway, plus the coach cards). Loading / empty / error states.
  Files: `apps/mobile/app/(app)/ai/daily-summary.tsx`, `apps/mobile/app/(app)/ai/companion.tsx`,
  `apps/mobile/src/screens/ai-coach/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 4. i18n + RTL: user-visible strings from the web shards; any genuinely new key added to `src/i18n/de/*.json`
  first, then the other ten (ar de en es fr pl pt ru sr tr zh); pt is Brazilian você-form; render under `ar` with
  start/end only; no hardcoded text, no physical `left`/`right`.
  Files: `src/i18n/*/aiCoachNative.json` (DE first), `apps/mobile/src/screens/ai-coach/**`.
  Verify: `npm run typecheck`; `npm test` — the no-raw-text and no-physical-direction tests pass.
- [ ] 5. Unit tests (fake gateway / fixtures, no network): each `/ai` page renders its card stack loaded/empty;
  daily-summary loaded/empty/error from a fake learnings fetch; companion renders a fake chat thread + handles a
  send error. React 19 — `ReactElement`, no global `JSX`.
  Files: `apps/mobile/tests/ai-coach/**`, `apps/mobile/src/screens/ai-coach/__tests__/**`.
  Verify: `npm test` green; `APP_PROFILE=development npm run bundle` and
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 6. Flip the lane's 5 parity rows to `native` and verify: `node scripts/native/parity-ledger.mjs --sync`
  (status edited by hand to `native`), then `--check`.
  Files: `apps/mobile/parity/ledger.json` (ai-coach rows only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 7. **(depends-on-owner / G1 — `next_actor: owner`)** Device-runtime parity: Maestro journey(s)
  `apps/mobile/maestro/ai-coach/*.yaml`, iOS simulator + Android emulator screenshots at the device sizes,
  screenshot parity vs the 390×844 read-only staging web `/ai*`. Blocked until G1 (and macOS minutes / G3 for iOS).
  Files: `apps/mobile/maestro/ai-coach/**`, `docs/validation/<VTID>/staging-tests.json`.
  Verify: on G1 only; recorded in the lane log, not run in CI.
- [ ] 8. PR: branch `kiro/native-wave2-ai-pages/ai-coach`, title
  `VTID-xxxxx (native-wave2-ai-pages/ai-coach): native AI coach pages port`, body names the Kiro session id,
  Summary / Decisions taken / Tests / Handoff. Commit trailers `Collab-Session: <kiro id>`,
  `Collab-Lane: native-wave2-ai-pages/ai-coach`. Lane → `in-review`, `next_actor: kiro` (reviewer seat `hotmail`).
  Never merge, deploy or write to a live system (protocol §7a).

<!-- lane: ai-assistants -->
## Lane `ai-assistants` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports: `ASSISTANT.OVERVIEW /assistant`, `ASSISTANT.AI /assistant?tab=ai`,
`ASSISTANT.AUTOPILOT /assistant?tab=autopilot`, `ASSISTANT.PROACTIVE /assistant?tab=proactive`,
`ASSISTANT.REFERRALS /assistant?tab=referrals`, `ASSISTANT.VOICE /assistant?tab=voice` (6 ledger rows, all the same
web file). depends_on: none. Web source `src/pages/assistant/AIAssistant.tsx` (144 lines, route
`src/App.tsx:1470-1474`); management hook `src/hooks/useAIAssistants.ts` (class B — `:11` imports the Supabase
client, wraps `/api/v1/integrations/ai-assistants`). The six rows share one native route file reading the `tab`
search param. **`ASSISTANT.VOICE` is the voice-settings tab (`VoiceSettingsPanel`), not the live ORB session.**

- [ ] 1. (Only if a genuinely pure helper is found) re-export it through `@vitana/core` (manifest + re-export +
  `core-closure.mjs --write`, commit the regenerated `closure.generated.json` + `mobile-ci-paths.generated.json`).
  The `useAIAssistants` flow and `useUserPreferences` are class B (Supabase/gateway) and are **re-implemented
  natively** — add no core entry if nothing pure remains.
  Files: `packages/core/manifest.json`, `packages/core/src/**`, `packages/core/closure.generated.json`,
  `scripts/native/mobile-ci-paths.generated.json`.
  Verify (repo root): `node scripts/native/core-closure.mjs --check`; `apps/mobile` → `npm run typecheck` green.
- [ ] 2. Native assistant settings screen: `apps/mobile/app/(app)/assistant/index.tsx` +
  `apps/mobile/src/screens/ai-assistants/AssistantScreen.tsx` — one route file reading the `tab` search param
  (default `voice`), a tab control (`@vitana/ui` tabs / segmented control) selecting the five panel twins
  (`VoiceSettingsPanel`, `AIModelSettingsPanel`, `AutopilotSettingsPanel`, `ProactiveTalkingPanel`,
  `VaeaConfigPanel`), each bound to a native `useUserPreferences` re-implementation. Mobile-web branch of
  `AIAssistant.tsx` only.
  Files: `apps/mobile/app/(app)/assistant/index.tsx`, `apps/mobile/src/screens/ai-assistants/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 3. The `useAIAssistants` management flow re-implemented natively: the provider list + paste-and-verify /
  connect / disconnect against `/api/v1/integrations/ai-assistants` through the native gateway port + native auth
  context (no raw API key ever stored or shown — reads back `key_prefix`/`key_last4` like the web hook). Rendered
  in the AI-model / connected-apps surface the screen opens.
  Files: `apps/mobile/src/screens/ai-assistants/**` (native hooks + panels).
  Verify: `npm test` — provider list / connect / disconnect states from a fake gateway; `npm run typecheck` green.
- [ ] 4. i18n + RTL (as ai-coach task 4) for the settings screen + its five panels.
  Files: `src/i18n/*/aiAssistantsNative.json` (DE first), `apps/mobile/src/screens/ai-assistants/**`.
  Verify: `npm run typecheck`; `npm test` no-raw-text / no-physical-direction tests pass.
- [ ] 5. Unit tests (fake gateway / fixtures): the `tab` param selects the right panel (all five, incl. `voice` →
  `VoiceSettingsPanel`); a preferences toggle round-trips through a fake `useUserPreferences`; the `useAIAssistants`
  provider list / connect flow renders loaded / empty / error from a fake gateway; the corrected N2 range
  `Slider`/`Progress` is used where a range/progress control appears. React 19 `ReactElement`.
  Files: `apps/mobile/tests/ai-assistants/**`, `apps/mobile/src/screens/ai-assistants/__tests__/**`.
  Verify: `npm test`; `APP_PROFILE=development npm run bundle`;
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 6. Flip the lane's 6 parity rows to `native`; `--sync` then `--check`. All six `/assistant*` rows match the
  single `(app)/assistant/index.tsx` by `shapeOf` (query dropped), so one route file covers them.
  Files: `apps/mobile/parity/ledger.json` (ai-assistants rows only),
  `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 7. **(depends-on-owner / G1 — `next_actor: owner`)** Maestro `apps/mobile/maestro/ai-assistants/*.yaml` +
  sim/emulator screenshots + parity vs 390×844 staging `/assistant` (each tab). Blocked until G1 (+ macOS/G3 for iOS).
  Files: `apps/mobile/maestro/ai-assistants/**`, `docs/validation/<VTID>/staging-tests.json`.
- [ ] 8. PR: branch `kiro/native-wave2-ai-pages/ai-assistants`, title
  `VTID-xxxxx (native-wave2-ai-pages/ai-assistants): native AI assistants management port`; trailers
  `Collab-Session`, `Collab-Lane: native-wave2-ai-pages/ai-assistants`; lane → `in-review`, `next_actor: kiro`.
  No merge/deploy/live write.

<!-- lane: ai-chat -->
## Lane `ai-chat` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports: `COMM.TALK_TO_VITANA /comm/talk-to-vitana` (1 ledger row). depends_on: none. Web source
`src/pages/community/TalkToVitana.tsx` (201 lines, route `src/App.tsx:1289-1293`) — the text-first chat / feedback
ticket capture screen; submit through `communityFetch` (`@/lib/community-gateway`, class B) to
`/api/v1/feedback/tickets`, member ticket list (`MyTicketsList`) below, `?ticket=` deep link.

- [ ] 1. Native Talk-to-Vitana screen: `apps/mobile/app/(app)/comm/talk-to-vitana.tsx` +
  `apps/mobile/src/screens/ai-chat/TalkToVitanaScreen.tsx` — a topic `Select` (the `TICKET_KINDS`), a multiline
  `TextInput` (web `Textarea`, `maxLength` 10 000), a submit button posting to `/api/v1/feedback/tickets` through
  the **native community-gateway port** + native auth context (class B, re-implemented), a success notice with the
  `?ticket=` deep link, and the `MyTicketsList` twin below. Mobile-web branch of `TalkToVitana.tsx` only; composed
  through `@vitana/ui`.
  Files: `apps/mobile/app/(app)/comm/talk-to-vitana.tsx`, `apps/mobile/src/screens/ai-chat/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 2. (Only if a genuinely pure helper is found — e.g. the `feedback-ticket` kinds/types if IO-free) re-export
  through `@vitana/core` (manifest + re-export + `core-closure.mjs --write`, commit the regenerated
  `closure.generated.json` + `mobile-ci-paths.generated.json`). The gateway fetch is class B and re-implemented
  natively — add no core entry if nothing pure remains.
  Files: `packages/core/manifest.json`, `packages/core/src/**`, `packages/core/closure.generated.json`,
  `scripts/native/mobile-ci-paths.generated.json`.
  Verify (repo root): `node scripts/native/core-closure.mjs --check`; `apps/mobile` → `npm run typecheck` green.
- [ ] 3. i18n + RTL (as ai-coach task 4) for the capture screen + ticket list.
  Files: `src/i18n/*/aiChatNative.json` (DE first), `apps/mobile/src/screens/ai-chat/**`.
  Verify: `npm run typecheck`; `npm test` no-raw-text / no-physical-direction tests pass.
- [ ] 4. Unit tests (fake gateway / fixtures): submit with empty text blocked; submit posts through a fake gateway
  and shows the success notice with the ticket number + `?ticket=` link; the ticket list renders loaded / empty /
  error; the `?ticket=` deep link opens the right ticket. React 19 `ReactElement`.
  Files: `apps/mobile/tests/ai-chat/**`, `apps/mobile/src/screens/ai-chat/__tests__/**`.
  Verify: `npm test`; `APP_PROFILE=development npm run bundle`;
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 5. Flip the lane's 1 parity row (`COMM.TALK_TO_VITANA`) to `native`; `--sync` then `--check`.
  Files: `apps/mobile/parity/ledger.json` (ai-chat row only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 6. **(depends-on-owner / G1 — `next_actor: owner`)** Maestro `apps/mobile/maestro/ai-chat/*.yaml` +
  sim/emulator screenshots + parity vs 390×844 staging `/comm/talk-to-vitana`. Blocked until G1 (+ macOS/G3 for iOS).
  Files: `apps/mobile/maestro/ai-chat/**`, `docs/validation/<VTID>/staging-tests.json`.
- [ ] 7. PR: branch `kiro/native-wave2-ai-pages/ai-chat`, title
  `VTID-xxxxx (native-wave2-ai-pages/ai-chat): native Talk-to-Vitana text screen port`; trailers `Collab-Session`,
  `Collab-Lane: native-wave2-ai-pages/ai-chat`; lane → `in-review`, `next_actor: kiro`. No merge/deploy/live write.

## Acceptance (every lane; the reviewer seat checks these)
- Requirements R1–R6 met for the lane's screens; mobile-web parity, N2/N3 composition, `@vitana/core`-only bridge
  (class-A extracted, class-B re-implemented natively).
- `npm run typecheck`, `npm test`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green; `node scripts/native/parity-ledger.mjs --check`
  green with the lane's rows `native`; `node scripts/native/core-closure.mjs --check` green **if** the lane added a
  core re-export (else not applicable).
- 11 locales, DE-first new keys (pt Brazilian você-form), RTL covered; no hardcoded user-visible text; no physical
  `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** and **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (read-only) and `plan-sparring.md`.
- Device-runtime parity (the final task) is deferred to G1 as `next_actor: owner`; it is not a merge blocker for
  the port, it is recorded in the lane log and `staging-tests.json`.
- Never: VTID allocation, merge/approve, workflow dispatch, deploy, Supabase/AWS writes, or any test against
  production (protocol §7a; program §6).
