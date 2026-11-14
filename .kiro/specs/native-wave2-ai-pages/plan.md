# Plan — native-wave2-ai-pages
Author: Kiro, seat `exafyltd`. Repo: `exafyltd/vitana-v1` (native app only — `apps/mobile/**`, `packages/core/**`
via the manifest/closure process, `apps/mobile/parity/ledger.json`, DE-first i18n shards, `docs/validation/**`; no
backend, no gateway change, no migration). Spec: `requirements.md`, `design.md`, `tasks.md`, `lanes/*.md` in this
folder. Program: `docs/programs/native-app/NATIVE-APP-PLAN.md` (VTID-05021), §5 Wave 2.

<!-- plan:begin -->
## Goal
Wave 2 screen-port batch of the native Maxina app: port the **non-voice AI assistant text pages** — the 12 web
destinations the parity ledger assigns to `"lane": "ai"` — to the native app (`apps/mobile/`) at 1:1 parity with
today's **mobile web** screens, built on `@vitana/core` + `@vitana/tokens` + the N2 UI kit (`@vitana/ui`) on the
Wave 1 N3 shell, with fixture / fake-gateway unit tests. The cluster is the chat-with-Vitana text screen, the AI
coach pages (overview, insights, recommendations, daily summary, companion) and the AI assistants management /
preferences screen (the `useAIAssistants` hook and the `/assistant` screen). Does **not** need G1 planned or built
to land the ports; every device-runtime verification step is marked depends-on-owner (G1). No redesign (program
§4), no new web screen, no `App.tsx` route, no registry/manifest change — only native route files and parity-row
status flips.

**This is the AI *pages* (text / screens) cluster, not the live ORB voice session.** The live voice-to-voice ORB
conversation surface is a separate program track deferred to G1 / the audio spike (owner-gated) and is listed in
`requirements.md` "Out of scope" with that reason. The `ASSISTANT.VOICE /assistant?tab=voice` row in scope is the
voice *settings* preferences tab (`VoiceSettingsPanel`), not that live session.

## Measured state (worktree = origin/main, parity ledger `apps/mobile/parity/ledger.json` version 2)
- **12 rows** carry `"lane": "ai"`, **all `status: "not_started"`** (12 `screen`, 0 `overlay`, 0 `route`; every row
  `source: registry`, `scope: in`); **435 rows total**. Counted with `node -e` over the committed ledger (the
  `--report` CLI needs `typescript`, not installed in this worktree). The 12 rows and their web paths are listed in
  `requirements.md` R0.2–R0.4.
- Web sources verified present at origin/main with line counts and lazy-import + route lines in `src/App.tsx`
  (the file is UTF-16; lines read with a Node decode): `src/pages/AI.tsx` (192; import `:183`, route `:1323-1327`),
  `src/pages/ai/Insights.tsx` (217; `:264`, `:1328-1332`), `src/pages/ai/AIRecommendations.tsx` (218; `:265`,
  `:1333-1337`), `src/pages/ai/DailySummary.tsx` (128; `:266`, `:1338-1342`), `src/pages/ai/Companion.tsx` (280;
  `:267`, `:1343-1347`), `src/pages/assistant/AIAssistant.tsx` (144; `:224`, `:1470-1474`),
  `src/pages/community/TalkToVitana.tsx` (201; `:260`, `:1289-1293`). Management hook
  `src/hooks/useAIAssistants.ts` verified present and confirmed class B (`:11` imports
  `@/integrations/supabase/client`; wraps `/api/v1/integrations/ai-assistants`). (Line counts are an approximate
  scoping snapshot; the load-bearing check is the class-A/class-B split — every AI data path here reaches the
  gateway or Supabase, so there is no class-A hook to extract and the lanes re-implement the fetch natively.)
- Wave 1 is on main: N3 shell + resolver route (`apps/mobile/app/(app)/[...path].tsx`, VTID-05186), N2 UI kit
  (`@vitana/ui`, VTID-05176), N1 `@vitana/core`/`@vitana/tokens` (VTID-05183). Prop map, ports and conventions in
  `apps/mobile/README.md`. The native app has no production profile; `assertNotProduction()` refuses prod/staging
  hosts.

## Decisions (made by Kiro as planner under the owner's "finish the native apps" instruction; sparring may revise)
1. **Three disjoint lanes by cluster and by route subtree.** `ai-coach` owns the whole `/ai` subtree (overview,
   insights, recommendations, daily-summary, companion) — the AI companion page lives at `/ai/companion`, so
   keeping it with the coach pages avoids an `app/(app)/ai/**` path overlap that a separate companion lane would
   create. `ai-assistants` owns the `/assistant` management/preferences screen and its five tab rows (the
   `useAIAssistants` flow). `ai-chat` owns the single `/comm/talk-to-vitana` text screen. The three touch disjoint
   route files and component folders, build/review independently, each leaves the app buildable. **Partition:
   ai-coach 5, ai-assistants 6, ai-chat 1 = 12** (named per-row in the lane files; 0 overlap, 0 orphan).
2. **Only pure class-A modules move into `@vitana/core`; the AI data hooks do NOT.** Every AI data path in this
   cluster is class B — `useAIAssistants.ts:11` imports `@/integrations/supabase/client` (reads
   `import.meta.env` / `localStorage` / the prod Supabase URL), and `TalkToVitana`/`DailySummary`/`Companion`
   reach the gateway (`@/lib/community-gateway`, `@/lib/memory-api`). Re-exporting any of them would pull a class-B
   module into the `core-closure.mjs` BFS and fail `--check` (`core-closure.mjs`, `m.own !== 'A'`). So each lane
   **re-implements the fetch natively** (native Supabase client + native auth context + native community-gateway
   port) and consumes only pure helpers from core. A lane that finds a genuinely pure helper worth sharing adds the
   re-export entry to `packages/core/src/**` + the `packages/core/manifest.json` line **and in the same PR** runs
   `node scripts/native/core-closure.mjs --write` and commits the regenerated `packages/core/closure.generated.json`
   and `scripts/native/mobile-ci-paths.generated.json`, so `--check` passes; a lane that finds none adds no core
   entry and runs no closure regeneration.
3. **No shared component twin across lanes, so no `depends_on`** — all three lanes run in parallel. (There is no
   cross-lane card/component twin in this cluster, unlike the home-feed plan.)
4. **LLM-locale is a backend concern (R1.5).** The user-preferred-language-into-the-system-prompt rule lives in
   the gateway / edge functions that answer these screens; the native page renders what the gateway returns and
   carries the member's locale on the request exactly as the web screen does — it builds no LLM prompt and adds no
   prompt logic.
5. **No new routes / registry / manifest.** Ports of screens already in `App.tsx` + `screens.json`; a native Expo
   Router file is not an `App.tsx` route, so the "new page needs screens.json/exclusions.json + screen-manifest +
   parity rows" rule does not fire — only parity-row **status** flips (`not_started`→`in_progress`→`native`). The
   six `/assistant*` rows match the single `(app)/assistant/index.tsx` by `shapeOf` (query dropped,
   `parity-ledger.mjs:60`), so `ai-assistants` flips all six with one route file.
6. **Device-runtime verification deferred to G1** (owner gate). Lanes land with offline build + fake-gateway unit
   tests green; the Maestro / simulator / screenshot-parity pass is a `next_actor: owner` task recorded in the lane
   and `staging-tests.json`. Matches the program's "fixture / fake-gateway tests only until G1" model.
7. **Mobile-web parity, not desktop.** Each native screen mirrors the `useIsMobile()` ≤ 1024 px branch of its
   source (program §1 shell), composed through N3/N2, every visual value from `@vitana/tokens`; the four
   N2-documented web defects are not reproduced and no web file is touched beyond a DE-first i18n key and a
   `@vitana/core` re-export line.

## Lanes (all `ready`, executor kiro; seat → reviewer_seat; `vtid:` filled by CI on convergence)
| Lane | Seat → reviewer | Scope (web destinations) | depends_on |
|---|---|---|---|
| `ai-coach` | exafyltd → hotmail | `/ai`, `/ai/insights`, `/ai/recommendations`, `/ai/daily-summary`, `/ai/companion` (**5 rows**) | — |
| `ai-assistants` | exafyltd → hotmail | `/assistant` + `?tab=ai|autopilot|proactive|referrals|voice`; the `useAIAssistants` management flow (**6 rows**) | — |
| `ai-chat` | exafyltd → hotmail | `/comm/talk-to-vitana` — the chat-with-Vitana text / ticket-capture screen (**1 row**) | — |
Exact `paths` globs are in each `lanes/<id>.md`; the 12 parity rows partition **5 (ai-coach) + 6 (ai-assistants) +
1 (ai-chat)** with 0 overlap and 0 orphan; the five `/assistant?tab=…` rows are flipped by the single
`(app)/assistant/index.tsx` file (exact `shapeOf` match, query dropped — `parity-ledger.mjs:60`). No lane has a
dependency, so all three run in parallel.

## Test plan
- **Per lane, offline (fixture / fake gateway, no network):** from `apps/mobile/` — `npm run typecheck`, `npm test`
  (jest-expo + RNTL: loaded/empty/error per screen; ai-coach each `/ai` page renders its card stack and companion
  renders a fake chat thread; ai-assistants the `tab` param selects the right panel, a fake `useAIAssistants`
  provider list / connect flow, a preferences toggle round-trip; ai-chat submit → ticket notice, ticket list,
  `?ticket=` deep link; i18n no-raw-text + RTL start/end; React 19 `ReactElement`),
  `APP_PROFILE=development npm run bundle`, `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check`. From the
  repo root — `node scripts/native/parity-ledger.mjs --check` (rows `native`, routes present).
- **Core extraction (only if a lane adds a re-export): run `--write` AND commit the generated files, not just
  `--check`.** A PR that adds a pure class-A re-export entry to `packages/core/src/` MUST also run
  `node scripts/native/core-closure.mjs --write` and commit the regenerated `packages/core/closure.generated.json`
  and `scripts/native/mobile-ci-paths.generated.json` in the SAME PR, then `--check` passes. Without the
  `--write`+commit, `--check` fails in NATIVE-CI with "stale generated file". (This cluster's data hooks are all
  class B and are re-implemented natively, so a lane may add no core entry at all — in which case it runs no
  closure regeneration.)
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- **i18n:** 11 locales (ar de en es fr pl pt ru sr tr zh), any new key DE-first (du-form) then mirrored; pt is
  Brazilian você-form; RTL (`ar`) rendered per screen.
- **Deferred to G1 (owner gate, `next_actor: owner`):** Maestro `maestro/<lane>/*.yaml`, iOS simulator + Android
  emulator screenshots at the device sizes, screenshot parity vs the 390×844 **read-only** staging web screen;
  listed in `docs/validation/<VTID>/staging-tests.json` (sign in, navigate, read; network guard aborts every
  non-GET except sign-in; never `vitanaland.com`). STAGING-VERIFY is read-only by construction (program §6).
- **No What's New entry** (ports of existing screens). No new routes → no nav-registry change and no new native
  parity row — only status flips.

## Open owner / sparring items (not decided here)
- G1 isolated test environment (program gate) — required before any device-runtime parity check; the deferred
  tasks stay `next_actor: owner` until it exists.
- The live voice-to-voice ORB session (explicitly out of scope) stays a separate program track / audio spike;
  this plan ports only the voice-*settings* tab under `ASSISTANT.VOICE`.
- macOS minutes / G3 for iOS-on-device screenshots (program STATUS row 8b) — not needed for the JS build.
<!-- plan:end -->
