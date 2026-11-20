# Design — Native Wave 2: AI assistant text pages (native-wave2-ai-pages)

How the three lanes port the `ai` ledger cluster (the non-voice AI assistant text pages) to native. Follows
`docs/programs/native-app/NATIVE-APP-PLAN.md` §3 (architecture) and §4 (parity method), the N3 shell and N2 UI kit
already on main, and `apps/mobile/README.md`. Nothing here changes the program plan or the design contract.

## 1. Where native screens live and how they resolve

Wave 1 N3 (VTID-05186) built the shell and a resolver route: `apps/mobile/app/(app)/[...path].tsx` renders every
ledger destination that is not yet native as "Unported", admin as the web console, unknown as not-found
(`apps/mobile/parity/ledger.json` `native_only` entry for `/*`). Porting a screen means **adding its own Expo
Router file under `apps/mobile/app/`** whose route path equals the web path, so the resolver no longer catches it,
the push `data.url` / universal link / ORB directive resolve the same, and the parity row can go `native`
(`scripts/native/parity-ledger.mjs` `fileToRoute()` maps `app/(app)/foo/[id].tsx` → `/foo/:id`).

Route-file plan (Expo Router, paths = web paths):

| Lane | Native route file(s) under `apps/mobile/app/` | Web path(s) |
|---|---|---|
| `ai-coach` | `(app)/ai/index.tsx`, `(app)/ai/insights.tsx`, `(app)/ai/recommendations.tsx`, `(app)/ai/daily-summary.tsx`, `(app)/ai/companion.tsx` | `/ai`, `/ai/insights`, `/ai/recommendations`, `/ai/daily-summary`, `/ai/companion` |
| `ai-assistants` | `(app)/assistant/index.tsx` (tabs `voice`/`ai`/`autopilot`/`proactive`/`referrals` via the `tab` search param) | `/assistant`, `/assistant?tab=…` |
| `ai-chat` | `(app)/comm/talk-to-vitana.tsx` | `/comm/talk-to-vitana` |

Query-string variants (`?tab=…`) are the **same route file** reading the search param, exactly as the web screen
reads `useSearchParams()` — they are distinct ledger rows but not distinct files, so they do not overlap across
lanes. The ledger's shape-matching (`shapeOf`, query dropped — `scripts/native/parity-ledger.mjs:60`) is satisfied
by the single file, so `ai-assistants` flips all six `/assistant*` rows with the one `(app)/assistant/index.tsx`.

## 2. Screen source: the N2/N3 structure, not the web DOM

Each lane re-implements the **mobile web** branch of its source screen with React Native primitives:

- Imports go through ports only: `@vitana/core/*` (pure hooks, query keys, types, registry), `@vitana/ui` (UI kit:
  `VCard`, `Tabs`, `Select`, `Textarea`, bottom sheet, `Button`, `Badge`), `@vitana/tokens` (visual values),
  `src/ports/*` from the shell (`core`, `ui`, `links`, `badges`, `soundscape`, `orb-slot`). No `@/…` web import
  (ESLint-banned in app code).
- The web→native prop map (`apps/mobile/README.md`) is mechanical: `onClick`→`onPress`, `className`→`style`,
  shadcn `Card`→`VCard`/`Panel`, `Tabs`→the kit's tabs / a `SegmentedControl`, `Select`→the kit's select / native
  action sheet, `Textarea`→RN `TextInput` multiline, `toast`/`notify*`→`@vitana/ui`/`@vitana/ui/sonner`,
  list/scroll→`FlatList`/`ScrollView`.
- Mobile patterns already in the shell are reused: `MobileModePill`, header chips, bottom sheets.

### 2a. ai-coach lane specifics

The five `/ai` pages are read-mostly coach / insight screens. `AI.tsx` (overview), `Insights.tsx` and
`AIRecommendations.tsx` render crossover / recommendation cards largely from `@/mocks/ai` plus the autopilot
(`use-autopilot`) and Vitana-index widgets — the native twins render the same card stacks through `VCard`.
`DailySummary.tsx` reads `fetchDailyLearnings` (`@/lib/memory-api`) + `useVitanaIndexHistory` via TanStack Query —
a **class-B** data path the lane re-implements natively (native gateway fetch + native query hook), since
`memory-api` reaches the gateway. `Companion.tsx` is the **AI coach chat** page (renders `HealthCoachChat` plus
coach cards); its chat transport is class-B (gateway), re-implemented natively, while any pure
formatting/suggestion helper it needs can move to `@vitana/core`. Each screen is a scroll of `VCard`s on the N3
shell; no overlay rows in this cluster.

### 2b. ai-assistants lane specifics

`/assistant` (`AIAssistant.tsx`) is a **tabbed settings/preferences screen** bound to `useUserPreferences`: the six
ledger rows are the base route plus five tab panels — `VoiceSettingsPanel` (`?tab=voice`), `AIModelSettingsPanel`
(`?tab=ai`), `AutopilotSettingsPanel` (`?tab=autopilot`), `ProactiveTalkingPanel` (`?tab=proactive`),
`VaeaConfigPanel` (`?tab=referrals`). The native twin is one route file reading the `tab` search param, rendering
the matching panel twin — a form screen (toggles, selects, sliders) composed through `@vitana/ui`. The
**management data flow** is `useAIAssistants` (`src/hooks/useAIAssistants.ts`), which wraps
`/api/v1/integrations/ai-assistants` and reads the Supabase auth session for the bearer token — **class B**, so the
lane re-implements the paste-and-verify / provider-list fetch natively (native Supabase client + native auth
context + native gateway port), never extracted into core. The `VoiceSettingsPanel` tab is **voice preferences**,
not the live ORB session (R0.3 / out-of-scope). The corrected N2 `Slider`/`Progress` behaviour (web defects not
reproduced) is used wherever a range or progress control appears in these panels.

### 2c. ai-chat lane specifics

`/comm/talk-to-vitana` (`TalkToVitana.tsx`) is a text-first capture screen: a topic `Select`, a multiline
`Textarea`, a submit button that POSTs to `/api/v1/feedback/tickets` through `communityFetch`
(`@/lib/community-gateway`), a success notice with a `?ticket=` deep link, and the member's `MyTicketsList` below.
The native twin re-implements the submit and the ticket-list fetch through the **native community-gateway port**
(class B — `community-gateway` is a gateway client), renders the form and list through `@vitana/ui`, and keeps the
`?ticket=` deep-link behaviour. One route file, one screen folder; no shared component with another lane, so no
`depends_on`.

## 3. Disjointness (no overlap, no orphan)

- **Ledger rows:** the 12 `ai` rows partition cleanly — `ai-coach` 5 (`AI.OVERVIEW`, `AI.INSIGHTS`,
  `AI.RECOMMENDATIONS`, `AI.DAILY_SUMMARY`, `AI.COMPANION`), `ai-assistants` 6 (`ASSISTANT.OVERVIEW`,
  `ASSISTANT.AI`, `ASSISTANT.AUTOPILOT`, `ASSISTANT.PROACTIVE`, `ASSISTANT.REFERRALS`, `ASSISTANT.VOICE`),
  `ai-chat` 1 (`COMM.TALK_TO_VITANA`). 5 + 6 + 1 = 12. Each row named explicitly in the lane file.
- **Native files:** each lane owns a disjoint subtree of `apps/mobile/app/` and `apps/mobile/src/screens/`
  (`app/(app)/ai/**` + `src/screens/ai-coach/`, `app/(app)/assistant/**` + `src/screens/ai-assistants/`,
  `app/(app)/comm/talk-to-vitana.tsx` + `src/screens/ai-chat/`). No file is in two lanes. `ai-chat`'s single file
  `app/(app)/comm/talk-to-vitana.tsx` is named explicitly in its `paths` (not a `comm/**` glob) so it never
  collides with a future `comm` lane in another plan.
- **Tests:** each lane owns its `apps/mobile/tests/<cluster>/**` + `src/screens/<cluster>/__tests__/**` and its
  `docs/validation/<VTID>/` folder.
- **Shared, by-row-not-by-file:** `apps/mobile/parity/ledger.json` (each lane edits only its own rows),
  `packages/core/manifest.json` + `packages/core/src/**` + `packages/core/closure.generated.json` +
  `scripts/native/mobile-ci-paths.generated.json` (each lane adds only the pure class-A re-exports it needs, if
  any, and regenerates in its own PR), and the DE-first i18n shards (each lane adds only its screens' keys). These
  are listed in each lane's `paths`.

## 4. Decisions (made by Kiro as planner; sparring may revise)

1. **Three lanes by cluster and by route subtree.** The prompt asks for disjoint cluster lanes (chat-with-Vitana
   text; AI coach; AI assistants management / companion / preferences). The AI companion page lives under `/ai`
   (`/ai/companion`), so grouping it with the coach pages keeps the whole `/ai` route subtree in one lane and
   avoids an `app/(app)/ai/**` path overlap that a separate companion lane would create. Result: `ai-coach` (all
   five `/ai*` pages incl. companion), `ai-assistants` (the `/assistant` management/preferences screen + its tabs,
   the `useAIAssistants` flow), `ai-chat` (the one `/comm/talk-to-vitana` text screen). Reason recorded here per
   planning-mode rule.
2. **Class-A extracted, class-B re-implemented.** Only pure IO-free helpers move into `@vitana/core` (manifest line
   + re-export + `core-closure.mjs --write`, same PR). The AI data hooks are class B — `useAIAssistants.ts:11`
   imports `@/integrations/supabase/client`, and `TalkToVitana`/`DailySummary`/`Companion` reach the gateway
   (`community-gateway`, `memory-api`) — so they fail `core-closure --check` (a class-B module is reachable) and
   are **re-implemented natively** (native Supabase client + native auth context + native gateway port) instead.
   If a lane finds no pure helper to extract, it adds **no** core entry at all (and so no closure regeneration).
3. **No shared component twin across lanes**, so **no `depends_on`** — all three lanes run in parallel. (Unlike
   the home-feed plan, there is no cross-lane card twin here.)
4. **LLM-locale is backend, satisfied by rendering what the gateway returns** (R1.5). The native page injects no
   system prompt and builds no LLM request body beyond carrying the member's locale the way the web screen does;
   the preferred-language rule is enforced in the gateway / edge functions, not duplicated natively.
5. **No new routes / registry / manifest.** These are ports of screens already in `App.tsx` and `screens.json`;
   adding a native route file is not an `App.tsx` route, so the "new page needs screens.json/exclusions.json +
   screen-manifest + parity rows" rule does not fire — only parity-row **status** flips.
6. **Runtime verification is deferred to G1** (owner gate). Lanes land the ports with offline build +
   fake-gateway unit tests green; the simulator/Maestro/screenshot-parity pass is a `next_actor: owner` task
   recorded in the lane and `staging-tests.json`. This matches the program's "fixture / fake-gateway tests only
   until G1" model (`.kiro/specs/health-native` handoff, `native-g1-wiring`).

## 5. Test design (per lane)

- **Unit (jest-expo + RNTL, fake gateway):** each screen renders its loaded state from fixture data, its empty
  state and its error state. ai-coach: each `/ai` page renders its card stack; companion renders the chat thread
  from a fake transport. ai-assistants: the `tab` search param selects the right panel; a provider list / connect
  flow renders from a fake `useAIAssistants` gateway; a preferences toggle round-trips through a fake
  `useUserPreferences`. ai-chat: submit posts through a fake community-gateway, success shows the ticket notice,
  the ticket list renders from fixtures, the `?ticket=` deep link opens. No network — the gateway/Supabase ports
  are mocked with fixtures.
- **i18n/RTL:** a test asserts no hardcoded user-visible string in the lane's screens and no physical
  `left`/`right`; renders one screen under `ar` (RTL) and asserts start/end usage.
- **Typecheck/bundle/deps:** `npm run typecheck`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` from `apps/mobile/`.
- **Parity:** `node scripts/native/parity-ledger.mjs --check` from the repo root (rows `native`, routes present).
  **Core (only if the lane added a re-export):** `node scripts/native/core-closure.mjs --check` after
  `--write`+commit of `closure.generated.json` and `mobile-ci-paths.generated.json`.
- **Deferred (G1, `next_actor: owner`):** Maestro journeys `maestro/<lane>/*.yaml`, iOS simulator + Android
  emulator screenshots at the device sizes, screenshot parity vs the 390×844 read-only staging web screen, listed
  in `docs/validation/<VTID>/staging-tests.json`.

## 6. Open items for the owner / sparring

- G1 isolated test environment (program gate) is required before any device-runtime parity check; until then the
  deferred tasks stay `next_actor: owner`.
- The live voice-to-voice ORB session (out of scope here) remains a separate program track / audio spike; this
  plan's `ASSISTANT.VOICE` row is only the voice-settings tab.
- macOS minutes / G3 for iOS-on-device screenshots (program STATUS row 8b) — not needed for the JS build.
