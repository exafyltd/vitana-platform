# VTID-03809 — Switch English ORB voice from `tina` (German) to `amy` (British)

User reported: "I don't like Vitana's voice during general Orb
communication, when English is selected." There is no end-user-facing
setting for this — the ORB (Nova Sonic) voice is a single hardcoded id per
language, and English's is `tina`, Nova's German voice, deliberately reused
for English after a 2026-07-28 live-test rejected Nova's native English
voice (`tiffany`) as sounding worse. Reusing the German voice trades a
German accent onto English speech, which is what the user is objecting to.

## Fix

Looked up Amazon's own Nova 2 Sonic voice catalog (not memory) to find real
untried alternatives:
https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-language-support.html

English voice options: `tiffany`/`matthew` (en-US), `amy` (en-GB), `olivia`
(en-AU), `kiara`/`arjun` (en-IN). `tiffany` already lost the 07-28 test;
`matthew`/`arjun` are masculine, excluded by the standing VTID-03704
"one voice per language, always female" rule. Presented `amy`/`olivia`/
`kiara` to the user as the real untried candidates; user picked `amy`.

`NOVA_VOICES.en` changed from `'tina'` to `'amy'` in `nova-sonic-voice.ts`.
`de` is unaffected and still resolves to `tina`. No routing change — `en`
stays in `NOVA_SONIC_SUPPORTED_LANGUAGES`, still goes straight to native
Nova, only the voice id changes.

The full gateway suite caught a second, real spot needing the same update:
`services/voice-lab/nova-sonic-test-runner.ts` (the source behind the
`/api/v1/voice-lab/nova/tests/run` diagnostic endpoint) has its own
`voice_mapping` health-check that independently asserted
`resolveNovaSonicVoice({ language: 'en', ... }) === 'tina'` — a live
production diagnostic, not a stale unit test. Updated it alongside the
resolver so the diagnostic endpoint doesn't start reporting a false
`voice_mapping` failure the moment this ships.

## ⚠️ Not independently confirmed by a live listen

Per this codebase's own standing lesson (documentation describes the
model; only a real invoke tells you what this account can actually use —
see CLAUDE.md §2b's Bedrock profile history), `amy` being listed in AWS's
docs does not guarantee this account's Nova 2 Sonic deployment can
actually invoke it. This session has no AWS credentials to test-invoke it
directly. The same live-listen step that vetted `tina` (2026-07-28) and
rejected `tiffany` should be run against `amy` on staging before treating
this as final — if `amy` also sounds wrong, or the id is not accepted,
the next real untried candidates are `olivia` (en-AU) or `kiara` (en-IN).

---

AC-1 — English ORB sessions resolve to Nova's `amy` voice; German is
unaffected

TEST: `test/orb/live/voice/nova-sonic-voice.test.ts` — "maps Vitana
(feminine default) per language" / "ignores persona — every persona gets
the same female voice" / "sage and mira use feminine voices" / "unknown/
absent persona falls back to the feminine voice" / "handles regional tags
and casing" (all now assert `en` → `amy`, `de` → `tina` unchanged)
Output: outputs/targeted-tests.txt

AC-2 — the fallback-reporting resolver, the routing-policy invariants, and
the session-start telemetry wiring are unaffected by the voice swap

TEST: `test/orb/live/voice/nova-sonic-voice-fallback.test.ts`,
`test/orb/live/voice/voice-routing-policy.test.ts`,
`test/orb/routes/session-start-voice-telemetry.test.ts` — unmodified,
pass because they don't hardcode `en`'s voice id
Output: outputs/targeted-tests.txt

AC-3 — the `/api/v1/voice-lab/nova/tests/run` diagnostic's own
`voice_mapping` health-check reflects the new mapping, not the old one

TEST: `test/services/voice-lab/nova-sonic-test-runner.test.ts` — "offline
tier passes on a clean environment; live probe skips by default" (caught
this as a real full-suite failure before the fix — `summary.failed`
expected 0, got 1 — not a hypothetical)
Output: outputs/targeted-tests.txt

AC-4 — no regression to the existing gateway test suite or type-checking

TEST: `npx jest` (full suite)
Output: outputs/full-suite.txt
TEST: `npx tsc --noEmit`
Output: outputs/tsc.txt
