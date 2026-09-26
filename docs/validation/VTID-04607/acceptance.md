# VTID-04607 / VTID-04611 — Voice redirect suite, and the fixes it found

A permanent regression gate for voice navigation:
`services/gateway/test/nav-redirect/`, with 50 spoken requests to open a screen
and the screen that must open. It covers English, German, es, fr, sr, pt and ar,
pages and tabs, three popups, and one mobile session. It runs in three layers:
CI (the real `navigate` tool on the bundled snapshot and stored vectors), a live
resolver run (a deployment's registry with real Titan), and a live voice run
(Polly speech to real Nova Sonic, or the cascade's own model turn).

## Results

| Layer | Before the fixes | After |
|---|---|---|
| CI — `npm run test:nav-redirect` | 48 of 50 right: 2 had the wrong screen first (de notification settings, pt rewards) | 50 of 50 right: 35 open, 15 handed off with the right screen first, 0 wrong |
| Live resolver on the staging registry, real Titan | 48 of 50 (the same two) | 50 of 50 on the fixed registry (vitana-v1 #1173) |
| Live voice, Nova Sonic + cascade (48 covered cases) | 36 opened the right screen, 2 opened a wrong one, 10 opened nothing, 1 Nova stream error | 39 opened the right screen, 0 opened a wrong one, 9 opened nothing, 1 Nova stream error |

Serbian runs on the Vertex bridge. The runner never calls Google, so that case
is reported as not covered.

## Fixes

- **Registry phrasings** (vitana-v1 #1173): German Notification settings,
  Portuguese Rewards.
- **Member words first** (`nav-dispatch.ts`, `orb-tools-shared.ts`): Nova shortened
  "Pop up my wallet quickly, I just want a quick look" to `question: "wallet"`
  and opened the Wallet page instead of the popup. It shortened "Show me my
  rewards" to "rewards" and opened the Reward insights tab. The resolver now
  reads the session transcript that `handleNavigate` already sends. It falls
  back to the model's question only when the member's words match nothing,
  so a bare "yes, open it" still works. Mutation check: with the member's
  words disconnected, P01 and P02 fail.
- **Open-screen override** (`live-system-instruction.ts`), placed next to the
  end-conversation override, only with `NAV_V2_ENABLED` and only on member
  surfaces. The `question` parameter now asks for the whole request, word for
  word.
- **VTID-04611 — a second tool round on the cascade**
  (`cascaded-live-client.ts`, `runCascadeModelTurn`). After an ambiguous
  navigate, the model could not call `navigate_to_screen`, because the
  continuation carried no tools. French "Ouvre mes messages" got "I found no
  messaging screen". A second round is now offered after a navigation tool;
  hand-off tools keep one round, and the last call is always tool-less.

## Still open (not fixed here)

Nova sometimes answers "show me X" with a content tool (`view_messages`,
`search_events`, `get_vitana_index`, `find_perfect_practitioner`) instead of
opening the screen. That accounts for 7 of the 9 cases that opened nothing
after the fixes. A prompt cannot make this reliable. A deterministic backstop,
opening the screen when the member's words are an explicit open request and
no navigation ran this turn, changes product behaviour and is left to the
owner.

## Acceptance criteria

AC-1 The 50 redirect cases each reach the expected screen through the real navigate tool (open with the right route/entry kind, or handed off with it first), nothing opens a wrong screen, and a case that opens today may not fall back to a hand-off.
TEST: services/gateway/test/nav-redirect/nav-redirect-suite.test.ts

AC-2 When the voice model passes a shortened question, the member's transcript decides the screen; a bare "yes" falls back to the question.
TEST: services/gateway/test/nav-redirect/nav-redirect-suite.test.ts
TEST: services/gateway/test/navigation/nav-open-screen-override.test.ts

AC-3 The open-screen override follows the end-conversation override, only with NAV_V2_ENABLED, worded positively.
TEST: services/gateway/test/navigation/nav-open-screen-override.test.ts

AC-4 The cascade allows a second tool round after a navigation tool, keeps hand-off tools at one round, and always ends tool-less.
TEST: services/gateway/test/orb/live/upstream/cascaded-nav-tool-rounds.test.ts

AC-5 The existing navigation, golden-set, leave-one-out and cascade suites still pass.
TEST: services/gateway/test/nav-golden/nav-registry-loo.test.ts
TEST: services/gateway/test/orb/live/upstream/cascaded-live-client-audio-gating.test.ts
