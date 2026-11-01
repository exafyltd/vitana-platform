# Requirements — Native Wave 2: AI assistant text pages (native-wave2-ai-pages)

Wave 2 screen-port batch of the Maxina native app program
(`docs/programs/native-app/NATIVE-APP-PLAN.md`, program VTID-05021). Port the **non-voice AI assistant text
pages** — the chat-with-Vitana text screen, the AI coach pages (overview, insights, recommendations, daily
summary, companion) and the AI assistants management / preferences screen (the `useAIAssistants` hook and the
`/assistant` screen) — that the parity ledger assigns to the `ai` lane, to the native app (`apps/mobile/`) at 1:1
parity with today's **mobile web** screens, built on `@vitana/core` + `@vitana/tokens` + the N2 UI kit
(`@vitana/ui`) on the N3 shell. Fixture / fake-gateway tests only; runtime verification on a device needs the
isolated test environment G1 and is called out per task as `depends-on-owner`.

Measured on the worktree (= `origin/main`), parity ledger `apps/mobile/parity/ledger.json` version 2:
**12 rows carry `"lane": "ai"`, every one `status: "not_started"`** (12 `screen`, 0 `overlay`, 0 `route`;
435 rows total). Counted with `node -e` over the committed ledger JSON (the `--report` command needs `typescript`,
which is not installed in this worktree). The three lanes below partition those 12 rows with **disjoint `paths`**.

Contract that does not change: `docs/programs/native-app/NATIVE-APP-PLAN.md` §4 (parity method), §6 (verification &
safety), the N2 README web→native prop map (`apps/mobile/README.md` "Web → native prop map"), and the Spotlight /
design rules via tokens. No new web screen, no `App.tsx` route, no `screens.json` / `exclusions.json` entry is added
by this plan (ports only), so no `screen-manifest` or voice-registry change and no new native parity row — only
status flips on existing rows.

## R0 — Scope and the three lanes

0.1 The plan ports exactly the 12 web destinations the parity ledger lists under `"lane": "ai"` (every one
`source: registry`, `kind: screen`, `scope: in`), split into three disjoint lanes by cluster and by native route
subtree. No row is in two lanes; no row in scope is left without a lane.

0.2 Lane **`ai-coach`** — the AI coach / insight pages under `/ai`:
`AI.OVERVIEW /ai` (web `src/pages/AI.tsx`, 192 lines; lazy-import `src/App.tsx:183`; route `src/App.tsx:1323-1327`),
`AI.INSIGHTS /ai/insights` (web `src/pages/ai/Insights.tsx`, 217 lines; lazy-import `src/App.tsx:264`; route
`src/App.tsx:1328-1332`), `AI.RECOMMENDATIONS /ai/recommendations` (web `src/pages/ai/AIRecommendations.tsx`,
218 lines; lazy-import `src/App.tsx:265`; route `src/App.tsx:1333-1337`), `AI.DAILY_SUMMARY /ai/daily-summary` (web
`src/pages/ai/DailySummary.tsx`, 128 lines; lazy-import `src/App.tsx:266`; route `src/App.tsx:1338-1342`) and
`AI.COMPANION /ai/companion` (web `src/pages/ai/Companion.tsx`, 280 lines, the AI coach chat page — renders the
`HealthCoachChat` component; lazy-import `src/App.tsx:267`; route `src/App.tsx:1343-1347`). **5 rows.** All five sit
under the `/ai` route subtree, so this lane owns `apps/mobile/app/(app)/ai/**` end to end.

0.3 Lane **`ai-assistants`** — the AI assistants management / preferences screen and its tabs:
`ASSISTANT.OVERVIEW /assistant`, `ASSISTANT.AI /assistant?tab=ai`, `ASSISTANT.AUTOPILOT /assistant?tab=autopilot`,
`ASSISTANT.PROACTIVE /assistant?tab=proactive`, `ASSISTANT.REFERRALS /assistant?tab=referrals` and
`ASSISTANT.VOICE /assistant?tab=voice`. **6 rows**, all the same web file `src/pages/assistant/AIAssistant.tsx`
(144 lines; lazy-import `src/App.tsx:224`; route `src/App.tsx:1470-1474`), a tabbed settings/preferences screen
(voice-settings, AI-model-settings, autopilot, proactive-talking, referrals panels bound to `useUserPreferences`).
The management data flow is the `useAIAssistants` hook (`src/hooks/useAIAssistants.ts`, wraps
`/api/v1/integrations/ai-assistants` via TanStack Query + the Supabase auth session), used by the connected-apps /
connect-modal surfaces this screen opens. **`ASSISTANT.VOICE` is the voice *settings* tab** (`VoiceSettingsPanel`,
`src/components/assistant/VoiceSettingsPanel.tsx`) — a preferences form, NOT the live voice-to-voice ORB session
(see "Out of scope"). The `?tab=…` rows are distinct ledger rows but the **same route file** reading the `tab`
search param, so they do not add route files and do not overlap another lane (the ledger's `shapeOf` drops the
query string — `scripts/native/parity-ledger.mjs:60`).

0.4 Lane **`ai-chat`** — the chat-with-Vitana text screen:
`COMM.TALK_TO_VITANA /comm/talk-to-vitana` (web `src/pages/community/TalkToVitana.tsx`, 201 lines; lazy-import
`src/App.tsx:260`; route `src/App.tsx:1289-1293`). **1 row.** The text-first feedback / ticket-capture screen
(textarea + topic `Select` + submit through `communityFetch` → gateway, with the member's ticket list below); its
own header comment records that voice intake is a later, separate concern. It owns a single native route file
`apps/mobile/app/(app)/comm/talk-to-vitana.tsx` under a disjoint screen folder.

0.5 Row partition: **`ai-coach` 5 + `ai-assistants` 6 + `ai-chat` 1 = 12.** Disjoint native route subtrees
(`app/(app)/ai/**`, `app/(app)/assistant/**`, `app/(app)/comm/talk-to-vitana.tsx`) and disjoint screen folders
(`src/screens/ai-coach/**`, `src/screens/ai-assistants/**`, `src/screens/ai-chat/**`), so no native file is in two
lanes. No lane depends on another (no shared component twin), so all three run in parallel.

## R1 — 1:1 parity with the mobile web screen

1.1 Each native screen mirrors the **mobile web** branch (the `useIsMobile()` ≤ 1024 px branch,
`src/hooks/use-mobile.tsx`) of its web source — same layout, same sections, same navigation, same wording. No
redesign, no added or removed section, no reordering (program §4 "Allowed native improvements only": platform
transitions, gestures, keyboard avoidance, safe areas, haptics, system sheets — nothing else).

1.2 Screens compose through the N3 shell and the N2 UI kit only: `MobileAppShell`, `TopAppBar`, `BottomNav`,
`MobileModePill`, bottom sheets, `VCard`, `Tabs`, `Select`, `Textarea`, etc. come from `src/ports/*`
(`apps/mobile/README.md` "Ports") and `@vitana/ui`; no web component, no raw colour, every visual value from
`@vitana/tokens`.

1.3 Web→native translation follows the README map exactly (`onClick`→`onPress`, `className`→`style`,
`toast`/`notify*`→`@vitana/ui`/`@vitana/ui/sonner`, documented `Select`/`Tooltip`/close-button/`Slider`/`Progress`
differences). The four web defects the N2 README lists (slider range thumb, progress RTL fill, inert
`shouldScaleBackground`, close-button RTL side) are **not** reproduced — the native kit's corrected behaviour is
used, and no web file is touched.

1.4 **Business logic split — class-A extracted, class-B re-implemented.** Only pure, IO-free modules (class A) are
re-exported through `@vitana/core` (manifest line + a re-export in `packages/core/src/**` + `node
scripts/native/core-closure.mjs --write`, in the same lane PR). The AI-chat / AI-coach / assistants data hooks are
**class B** — they runtime-import the Supabase client (`src/integrations/supabase/client.ts`, which reads
`import.meta.env` / `localStorage` / the prod Supabase URL) or `@/lib/community-gateway` and so would fail
`core-closure --check`; a lane that needs one **re-implements the fetch natively** (native Supabase client + native
auth context + the native community-gateway port) rather than extracting it (program §3; `apps/mobile/README.md`
"Web code: `@vitana/core`"). `useAIAssistants.ts:11` (`import { supabase } …`) and `TalkToVitana.tsx` /
`DailySummary.tsx` (gateway/`memory-api` fetches) are the class-B cases. `@vitana/core` is the only web→native
bridge; ESLint bans `@/` and relative paths into the web `src/` from app code.

1.5 **LLM-locale is a backend concern, satisfied by reuse.** The repo rule that a user's preferred language is
injected into the LLM system prompt (`CLAUDE.md` "AI-generated content") lives in the gateway / edge functions
that answer these screens, not in the native page. The native page renders exactly what the gateway returns (text
already in the member's language) and adds no prompt-building logic — it carries the member's locale on the request
the same way the web screen does, nothing more.

## R2 — i18n (11 locales) + RTL

2.1 Every user-visible string (including `accessibilityLabel` / `accessibilityHint`) comes from the web catalog
shards `src/i18n/<locale>/*.json`, read through the generated catalog map — no hardcoded text (repo i18n hard rule;
`apps/mobile/README.md` "i18n").

2.2 All 11 active locales resolve: **ar de en es fr pl pt ru sr tr zh** (program §1 design-system note; the live
`supported_locales` table has all 11 `status='ga'`). A new key is added to the **German shard first**
(`src/i18n/de/<screen>.json`) then mirrored to the other ten; DE is du-form; **pt is Brazilian você-form**.

2.3 Each screen works in RTL (`ar`): `start`/`end`, never `left`/`right`; the shell root `direction` follows the
language (`apps/mobile/README.md` N3 "Theme" row). A test scans the lane's files for physical `left`/`right`.

2.4 Adding a web i18n key is a web-deploy path. A lane that needs a genuinely new string adds the DE key first and
mirrors it; a lane that can reuse an existing key does so and adds none.

## R3 — React 19 / native typing

3.1 React 19 types: no global `JSX` namespace — use `ReactElement` (program hard rule; `.kiro/specs/health-native`
handoff "Hard rules"). `npm run typecheck` (which regenerates the i18n map first) is green.

## R4 — Parity ledger

4.1 Each lane flips its rows from `not_started` to `in_progress` while building and to `native` on completion by
running `node scripts/native/parity-ledger.mjs --sync` (status is edited by hand; `--sync` refreshes derived
fields), and NATIVE-CI `--check` is green: a `native` / `in_progress` row must have a matching route in
`apps/mobile/app/`, and no route in `app/` may lack a row (`scripts/native/parity-ledger.mjs` `check()`). The
`?tab=…` rows match the single `/assistant` route file by `shapeOf` (query dropped), so `ai-assistants` flips all 6
rows with one native route file.

4.2 No lane changes `scope`/`lane` of a row (those come from `scripts/native/parity-scope.json`); no lane edits
another lane's rows. The three lanes touch disjoint sets of ledger rows, so the single `ledger.json` file is the
one shared path and conflicts resolve by row.

## R5 — Verification and safety (never production)

5.1 Never test against production; staging specs are read-only (program §6; root `CLAUDE.md`). The native app has
**no production profile** and `assertNotProduction()` refuses the production gateway, `vitanaland.com`, the
production Supabase project and the staging hosts (`apps/mobile/README.md` "No production host, ever").

5.2 Build-time verification per lane is offline: `npm run typecheck`, `npm test` (jest-expo + RNTL unit tests with
a **fake gateway / fixtures**, no network), `APP_PROFILE=development npm run bundle` (Metro + Hermes JS for iOS and
Android), and `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` — all from `apps/mobile/`; plus
`node scripts/native/parity-ledger.mjs --check` from the repo root. No live call is made.

5.3 Runtime parity verification (simulator / emulator screenshots, Maestro device journeys, screenshot parity vs
the 390×844 web screen) is a **depends-on-owner (G1)** step: it needs the isolated test environment (and macOS
minutes / G3 for iOS on a device). Each such task is marked `next_actor: owner` in `tasks.md` and the lane records
G1 as a blocker in its log; it does not block the build-time port landing.

5.4 Each lane adds a read-only `docs/validation/<VTID>/staging-tests.json` for its screens (the VTID is written by
CI after PLAN-SPAR converges). Staging specs sign in, navigate and read; a network guard aborts every non-GET
except sign-in; never `vitanaland.com`.

5.5 No What's New entry (these are ports of existing screens, not new finished features — `CLAUDE.md` What's New
rule).

## R6 — Done

6.1 Every in-scope ledger row for the lane is `native` with its native route in `apps/mobile/app/` and its
functional-parity checklist (program §4 per-screen checklist) recorded; RTL (`ar`) covered.

6.2 `npm run typecheck`, `npm test`, `npm run bundle`, `npm run deps:check` and `parity-ledger --check` green;
NATIVE-CI (incl. the shell source-pin and ports checks) and the Collab handoff + Lane scope PR-GATE checks green.

6.3 `docs/validation/<VTID>/` has `scope.json` (every touched path), `staging-tests.json` (the lane's read-only
spec) and `plan-sparring.md` (copy of this plan's sparring record).

## Out of scope (named so a lane does not drift into them)

- **The live voice-to-voice ORB session screens** (the real-time Nova Sonic / voice-cascade conversation surface) —
  a **separate program track, deferred to G1 / the audio spike and owner-gated** (program STATUS row 8b; the ORB
  voice module is its own plan). This plan is the AI *pages* (text / screens) cluster only. The `ASSISTANT.VOICE`
  row in scope is the voice *settings* preferences tab (`VoiceSettingsPanel`), not that live session; no live-voice
  session row exists in the `ai` ledger lane, and none is added here.
- Any screen in another Wave 2 ledger lane (`home-feed`, `events-calendar`, `media`, `discover-commerce`,
  `inbox-chat-calls`, etc.) — each is its own plan.
- Admin/dev AI tooling (`/dev/*`, `pages/admin/assistant/*` — Personality, Speeches, Voice, Tools, Routing,
  Playground, Sessions): admin-facing, not member-facing text pages, and not in the `ai` ledger lane.
- G1 / G2 / G3 provisioning, EAS / store build pipelines, the ORB voice module — their own plans / owner gates.
- Any web-side change beyond adding an i18n key (DE first) and a `@vitana/core` re-export line.
