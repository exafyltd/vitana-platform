# VTID-04445 — Persona voice gender: Vitana female, Devon male, every language

Owner rule (2026-09-23): every Vitana voice, in every language, is a woman's
voice; every Devon voice, in every language, is a man's voice.

## What was wrong (found by audit)

| Pipeline | Defect |
|---|---|
| Nova Sonic (en/de native; every language when the cascade is off) | Devon spoke with Vitana's female voice (VTID-03704 made Nova persona-independent) |
| Cascade / Polly (tr, zh) | Polly has no male voice → Devon borrowed Vitana's female voice |
| Cascade / Polly (all) | A failed Devon synthesis fell back to Vitana's female voice |
| Cascade / Fish (sr) | Devon spoke with Milica (female) — Fish role was ignored |
| Gemini, Vitana `voice.live_api.voice.fr` / `.es` (DB) + code fallbacks fr/es/tr | Charon / Fenrir / Puck — all male |
| Gemini, Vitana `LIVE_LANGUAGE_VOICE` tr | Umbriel — male |
| LiveKit orb-agent, Vitana ar/zh/ru/sr default | Charon — male |

## Acceptance criteria

AC-1: Nova — Vitana resolves a known female voice and Devon a known male voice in all 11 languages, fallback included (`lennart` for Devon, `tina` for Vitana).
TEST: services/gateway/test/vtid-04445-persona-voice-gender.test.ts
TEST: services/gateway/test/orb/live/voice/nova-sonic-voice.test.ts
TEST: services/gateway/test/orb/live/voice/voice-routing-policy.test.ts

AC-2: Polly — every receptionist voice is female, every specialist voice male; a failed Devon synthesis retries the male voice once and never uses the female voice.
TEST: services/gateway/test/orb/live/upstream/cascaded/tts-backend-specialist.test.ts
TEST: services/gateway/test/orb/live/upstream/cascaded-persona-swap.test.ts

AC-3: Fish — Devon speaks tr/zh/sr with male Fish Official voices (Kerem, Zixuan, Nikola); Vitana keeps Milica.
TEST: services/gateway/test/orb/live/session/persona-swap-in-process.test.ts

AC-4: Hand-off gate — a Devon hand-off only happens when the session's pipeline has a male voice for the language; otherwise the ticket stays filed (`ticket_filed_no_handoff`) and Vitana keeps the call. Wired at both `report_to_specialist` and `switch_persona`.
TEST: services/gateway/test/vtid-04445-persona-voice-gender.test.ts

AC-5: Gemini — every Vitana language voice female; `enforceVertexVoiceGender` replaces any wrong-gender setup voice; DB rows fr/es fixed (migration `20260923220000_vtid_04445_persona_voice_gender.sql`, applied live).
TEST: services/gateway/test/orb/live/voice/live-api-voice.test.ts

AC-6: LiveKit orb-agent — every Vitana `google_tts` default is female; DB `agent_voice_configs` rows carry explicit per-language voices (Vitana female, Devon Charon male).
TEST: services/gateway/test/vtid-04445-persona-voice-gender.test.ts

## Evidence

- `outputs/polly-describe-voices.txt` — live `DescribeVoices`, eu-central-1: every Polly voice used and its Gender.
- `outputs/nova-pitch.txt` — every Nova voice id invoked for real on `amazon.nova-2-sonic-v1:0` (eu-north-1), audio returned, median pitch: female 198–261 Hz, male 104–140 Hz. AWS's own Nova 2 voice table lists the same ids as masculine/feminine. A bogus id is rejected (`Received invalid id`).
- Fish voices: `GET https://api.fish.audio/model/{id}` — author `Fish Official`, `male` tag, `dmca_taken_down:false`.
- Gemini gender: Google's Chirp 3 HD voice table.

OASIS_PROOF: new diag `persona_handoff_voice_unavailable` (stage on `orb.live.diag`) is emitted when a Devon hand-off is refused for want of a male voice; no other OASIS topic changes.

## Not verified live

Staging has been unable to place ECS tasks since 2026-09-22 (AWS account block), so no staging voice session has run this code. Fish is not provisioned on any task def (`FISH_API_KEY` absent), so on today's staging the Turkish/Chinese cascade hand-off is refused by the gate (Vitana stays), and Serbian goes through the Vertex bridge (Devon = Charon).
