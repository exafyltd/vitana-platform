---
slug: native-wave2-ai-pages
author: kiro
executor: kiro
next_actor: kiro
state: approved
author_seat: exafyltd
updated: 2026-10-28T13:17Z
vtids: [VTID-05395, VTID-05396, VTID-05397]
sparring_record: .kiro/specs/native-wave2-ai-pages/sparring/verdict.md
spar_refs:
  - exafyltd/vitana-v1: main
---
# Handoff — Native Wave 2: AI assistant text pages
Wave 2 screen-port batch of the native Maxina app program (`docs/programs/native-app/NATIVE-APP-PLAN.md`,
program VTID-05021; Wave 2 lane list in §5). Ports the 12 web destinations the parity ledger assigns to
`"lane": "ai"` — the non-voice AI assistant **text pages** (chat-with-Vitana, the AI coach pages, and the AI
assistants management / preferences screen with the `useAIAssistants` hook) — to native at 1:1 mobile-web parity on
`@vitana/core` + `@vitana/ui` + the N3 shell; fixture / fake-gateway tests only, device-runtime parity deferred to
G1 (`next_actor: owner`). No web screen, `App.tsx` route or registry/manifest change — only native route files and
parity-row status flips. Plan block: `plan.md`. Lanes: `lanes/*.md` (3, all `ready`, executor kiro, seat exafyltd →
reviewer_seat hotmail, disjoint `paths`, no `vtid` yet).

**This is the AI *pages* (text / screens) cluster, not the live ORB voice session.** The live voice-to-voice ORB
conversation surface is a separate program track deferred to G1 / the audio spike (owner-gated) and is listed in
`requirements.md` "Out of scope" with that reason; `ASSISTANT.VOICE /assistant?tab=voice` in scope is the voice
*settings* preferences tab, not that live session.
## Log
### 2026-10-22T13:10Z · kiro-202610151913-51bd · created → drafted
Holder of the `native-wave2-ai-pages/_plan` claim (planner). Measured on the worktree (= origin/main):
`apps/mobile/parity/ledger.json` version 2 has **12 rows with `"lane": "ai"`, every one `not_started`** (12 screen,
0 overlay, 0 route; 435 rows total), counted with `node -e` over the committed ledger (the `--report` CLI needs
`typescript`, not installed here). Verified all 7 web source pages exist with the line counts and the lazy-import +
route lines cited in `plan.md`/`requirements.md` (`src/App.tsx` is UTF-16; lines read with a Node decode), and that
the `useAIAssistants` hook (`src/hooks/useAIAssistants.ts:11`) imports the Supabase client → class B. Confirmed the
`ASSISTANT.VOICE` tab is `VoiceSettingsPanel` (voice *settings*), not the live ORB session, so the live-voice
session is correctly excluded in `requirements.md` "Out of scope" (separate program track / G1 audio spike,
owner-gated). Wrote requirements, design, tasks, plan and 3 lane files; partitioned the 12 rows into `ai-coach` (5),
`ai-assistants` (6), `ai-chat` (1) with disjoint native route subtrees (`app/(app)/ai/**`, `app/(app)/assistant/**`,
`app/(app)/comm/talk-to-vitana.tsx`) and ledger-rows-by-row — **0 overlap, 0 orphan**. No lane depends on another
(no shared component twin), so all three run in parallel. No VTID allocated, no product code changed, no live system
touched.
Next: PLAN-SPAR spars the `plan(native-wave2-ai-pages)` PR (the `spar_refs` block forwards the vitana-v1 `main` ref
so the partner can verify the `apps/mobile/**` and web-screen premises); this session answers each round in
`sparring/responses-<n>.md`. On convergence CI writes the VTIDs into the lanes; then seat `exafyltd` claims lanes —
all three in parallel (no deps). Reviewer seat `hotmail` reviews each lane. Device-runtime parity (the final task in
each lane) waits on the owner's G1 isolated test environment.

### 2026-10-28T13:17Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 3 lane(s) got a VTID and are handed to Kiro.
