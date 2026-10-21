# VTID-04336 — Devon takes over in every language: cascade and Serbian bridge

Owner decision (docs/CUSTOMER-SUPPORT-REBUILD-BRIEF.md §3.2, §3.5 decision 2):
the Vitana → Devon hand-off must work on every provider a member can be on —
Nova Sonic, the cascade (Transcribe → Bedrock → Polly/Fish; ru, pl, tr, zh,
ar, sr and the other cascade languages) and the Serbian Vertex bridge.

## What was wrong (measured in code, 2026-09-23)

1. **The cascade could never reach the hand-off.** `CascadedLiveClient`
   declared no tools (`onToolCall` never fired), so `report_to_specialist` /
   `switch_persona` could not be called on a cascade session at all.
2. **The cascade had no memory between turns.** Every Bedrock call carried
   only the latest utterance, so the hand-off rule "propose, then call only
   after the member says yes" could not be satisfied — the "yes" turn had no
   record of the proposal.
3. **The cascade had no persona handling.** `handleTurnComplete` closes the
   upstream with `persona_swap` and relies on a reconnect to rebuild the
   setup; the cascade has no stream to rebuild and no voice in a setup.
4. **Serbian bridge voice.** The reconnect re-selects the bridge (selection
   does not depend on the persona) and uses the registry voice
   (`Charon` for Devon — a Gemini voice). But the registry `voice_id` is shared
   by every provider, and nothing stopped a non-Gemini id from reaching
   `speech_config.voice_name` on the one live Vertex path.

## What changed

- `CascadedLiveClient` declares exactly `report_to_specialist` and
  `switch_persona` (`CASCADE_TOOL_ALLOWLIST`, filtered out of the envelope
  catalog `orb-live.ts` now passes on connect), runs one bounded tool round per
  turn (answered through `sendToolResult`, 20 s synthetic-error timeout,
  answered on `close()`), keeps a 12-message rolling history, and exposes
  `applyPersona()`: new system instruction (or the connect-time one plus the
  cached swap-back context), TTS voice role, history reset, and the
  specialist's opening turn as an English stage-direction INTENT (NEVER-rule 41).
- `handleTurnComplete`: an upstream client with `applyPersona` is swapped in
  process (`persona_swap_in_process` diag); every other client keeps the
  unchanged `close('persona_swap')` + reconnect.
- TTS (backend-local, §2c-fish-scope): `POLLY_SPECIALIST_VOICES` — the male
  counterpart in the same language code (en Matthew, de Daniel, fr Remi,
  es Sergio, ar Zayd, ru Maxim, pt Thiago, pl Jacek); none for zh/tr (Polly has
  no male voice there) — they keep the receptionist timbre. `pollyBackend`
  retries with the receptionist voice if the specialist synthesis fails. Fish
  (`sr`) keeps its single curated voice; no community voice is ever used.
  `synthesizeCascadeReply()`'s Polly-first/Fish-fallback order is unchanged.
- Serbian bridge: `resolveVertexLivePersonaVoice()` — only a Gemini prebuilt
  voice reaches `speech_config`; a specialist with a non-Gemini registry voice
  gets `Charon`; otherwise the language voice as before.

## Acceptance criteria

AC-1 The cascade declares only the hand-off tools, for ru and sr.
TEST: services/gateway/test/orb/live/upstream/cascaded-persona-swap.test.ts

AC-2 `applyPersona` replaces the system instruction for the next turn, resets history and runs the specialist's opening turn; swap-back restores the connect-time instruction plus the cached context with no opening turn (ru and sr).
TEST: services/gateway/test/orb/live/upstream/cascaded-persona-swap.test.ts

AC-3 Voice selection per backend: ru uses the Polly specialist voice (falls back to the receptionist voice on failure); sr keeps the curated Fish voice; zh/tr/sr have no Polly specialist voice.
TEST: services/gateway/test/orb/live/upstream/cascaded/tts-backend-specialist.test.ts
TEST: services/gateway/test/tts/polly-specialist-voice.test.ts

AC-4 One bounded tool round: `onToolCall` fires, the result is fed back with matching ids, a tool-less continuation produces the bridge, a pending call never hangs, a non-allowlisted tool is never dispatched.
TEST: services/gateway/test/orb/live/upstream/cascaded-persona-swap.test.ts

AC-5 Swap wiring: a cascade client gets `applyPersona` and is never closed; a Nova/Vertex client still gets `close('persona_swap')` + `_personaSwapInFlight`; end to end through the real handlers, `report_to_specialist` → Vitana's bridge → Devon's opening turn on Devon's prompt and voice, for ru and sr.
TEST: services/gateway/test/orb/live/session/persona-swap-in-process.test.ts

AC-6 Serbian bridge: the persona-swap reconnect re-selects `vertex_serbian_bridge`, re-enters `connectToLiveAPI`, and the setup voice for Devon is a Gemini prebuilt voice (`Charon`, or `Charon` substituted for a non-Gemini registry voice).
TEST: services/gateway/test/orb/live/upstream/vertex-bridge-persona-swap.test.ts

AC-7 No regression in every cascade / upstream / session / TTS suite.
TEST: services/gateway/test/orb/live/upstream/cascaded-live-client-audio-gating.test.ts
TEST: services/gateway/test/orb/live/upstream/cascaded-live-client-empty-completion.test.ts
TEST: services/gateway/test/orb/live/upstream/cascaded/tts-backend.test.ts

## Verification run (local, this commit)

- `node node_modules/.bin/tsc --noEmit -p .` (services/gateway): clean.
- `jest test/orb/live/upstream test/tts test/orb/live/session test/persona-registry.test.ts test/orb/live/tools`: 68 suites, 918 tests passed.
- `jest test/orb test/frontend test/routes/orb-live`: 258 suites, 4233 passed (1 skipped, 6 todo — pre-existing).

## Not verified, stated plainly

- No live voice session: nothing ran against staging or production. The
  first real signal is a staging cascade session (e.g. `ru`) emitting
  `persona_swap_in_process` in `oasis_events` and the member hearing Devon.
- The Polly specialist voice ids are docs-derived, not confirmed with
  `DescribeVoices` (no AWS credentials in this session);
  `scripts/tts/verify-polly-voices.ts` now checks them.
- Whether the model on the `operator` stage actually calls the hand-off tool
  on the cascade depends on the prompt rules (VTID-04332's scope, not this
  one).
- The Serbian bridge path was verified structurally (selector + source
  checks), not against a live Gemini reconnect.
