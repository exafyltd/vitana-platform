---
slug: native-wave2-ai-pages-r2
author: kiro
executor: kiro
next_actor: kiro
state: drafted
author_seat: exafyltd
updated: 2026-11-02T11:03Z
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
Re-plan of `native-wave2-ai-pages` (PR #4430) under a new slug; the old branch has a commit without a Collab-Session trailer (Collab handoff on main cannot accept it without a history rewrite) and the spec is not listed in docs/programs/native-app/program.md; it is the converged, policy-approved plan of `native-wave2-ai-pages` (PR #4430), whose VTIDs are retired with that PR. Sparring history: https://github.com/exafyltd/vitana-platform/pull/4430.
## Log
### 2026-11-02T11:03Z · kiro-exafyltd-202611011658-9f52 · created → drafted
Holder of the `native-wave2-ai-pages-r2/_plan` claim. Re-plan of `native-wave2-ai-pages` (PR #4430), because the old branch has a commit without a Collab-Session trailer (Collab handoff on main cannot accept it without a history rewrite) and the spec is not listed in docs/programs/native-app/program.md; it is the converged, policy-approved plan of `native-wave2-ai-pages` (PR #4430), whose VTIDs are retired with that PR. Copied the plan, tasks, requirements, design and lane files from the old PR head; lane `vtid` keys removed (CI allocates on convergence), lane `paths` widened to the shared native-infra files a screen port produces, lane logs restarted, sparring rounds left on the old PR. One commit, one session. No VTID allocated, no product code changed, no live system touched. Next: PLAN-SPAR spars the `plan(native-wave2-ai-pages-r2)` PR; this session answers each round in `sparring/responses-<n>.md`.
### 2026-11-02T20:56Z · kiro-exafyltd-202611011658-9f52 · drafted (sparring round 1 answered)
R1-F1 accepted: the spec is registered in `docs/programs/native-app/program.md` by this PR; the plan block now says so. Answers: `sparring/responses-1.md`.
